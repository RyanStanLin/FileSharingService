import base64
from contextlib import closing
import concurrent.futures
from datetime import datetime, timezone
import fcntl
import ftplib
import hashlib
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import plistlib
import pwd
import secrets
import select
import sqlite3
import socket
import ssl
import stat
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
import zipfile
import zlib

import cbor2
import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from websockets.exceptions import ConnectionClosedError
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "artifacts/FileSharingAgent.loopback"
SERVER = ROOT / "src/Server/bin/Debug/net10.0/FileSharing.Server.dll"
SFTP = ROOT / "artifacts/filesharing-sftp"
API = "/api/v1"
AUTH = API + "/auth/passkeys"
NOTIFICATIONS = API + "/notifications"


def encoded(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def digest(value):
    return hashlib.sha256(value).digest()


def port():
    with closing(socket.socket()) as reservation:
        reservation.bind(("127.0.0.1", 0))
        return reservation.getsockname()[1]


def ports():
    while True:
        values = list(dict.fromkeys(port() for _ in range(4)))
        if len(values) == 4:
            return values


def sftp_client(directory, gateway_port, fingerprint, credential):
    scan = subprocess.run(["ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", str(gateway_port), "127.0.0.1"],
                          check=True, capture_output=True, text=True, timeout=10)
    key = next(line for line in scan.stdout.splitlines() if " ssh-ed25519 " in line)
    actual = "SHA256:" + base64.b64encode(digest(base64.b64decode(key.split()[2]))).decode().rstrip("=")
    if actual != fingerprint:
        raise AssertionError("The SFTP host key did not match the management API fingerprint.")
    known = directory / "known_hosts"
    known.write_text(key + "\n")
    askpass = directory / "sftp-askpass"
    askpass.write_text('#!/bin/sh\nprintf "%s\\n" "$FILESHARING_TEST_SFTP_PASSWORD"\n')
    askpass.chmod(0o700)
    env = os.environ | {"SSH_ASKPASS": str(askpass), "SSH_ASKPASS_REQUIRE": "force",
                        "FILESHARING_TEST_SFTP_PASSWORD": credential["password"]}
    options = ["-F", "/dev/null", "-o", f"UserKnownHostsFile={known}", "-o", "StrictHostKeyChecking=yes",
               "-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password",
               "-o", "ConnectTimeout=6"]
    remote = f'{credential["account"]["name"]}@127.0.0.1'
    return ["sftp", *options, "-P", str(gateway_port), "-b", "-", remote], ["ssh", *options, "-p", str(gateway_port), remote], env


def passive_ports(excluded):
    for index in range(80):
        start = 40000 + secrets.randbelow(18000)
        span = range(start, start + 8)
        if set(span) & set(excluded):
            continue
        candidates = []
        try:
            for value in span:
                candidate = socket.socket()
                candidates.append(candidate)
                candidate.bind(("127.0.0.1", value))
            return start, start + 7
        except OSError:
            pass
        finally:
            for candidate in candidates:
                candidate.close()
    raise RuntimeError("Could not reserve a local passive port range.")


def png():
    signature = b"\x89PNG\r\n\x1a\n"

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return signature + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + (
        chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b"")
    )


class Passkey:
    def __init__(self, origin):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.id = secrets.token_bytes(32)
        self.counter = 0
        self.handle = None
        self.origin = origin

    def browser_json(self, challenge, ceremony, origin=None):
        return json.dumps({"type": ceremony, "challenge": challenge, "origin": origin or self.origin, "crossOrigin": False},
                          separators=(",", ":")).encode()

    def create(self, options):
        public = self.key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: public.x.to_bytes(32, "big"), -3: public.y.to_bytes(32, "big")})
        self.handle = options["user"]["id"]
        data = digest(options["rp"]["id"].encode()) + b"\x45" + bytes(20) + struct.pack(">H", len(self.id)) + self.id + cose
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": data})
        return self.credential({"clientDataJSON": encoded(self.browser_json(options["challenge"], "webauthn.create")),
                                "attestationObject": encoded(attestation), "transports": ["internal"]})

    def assert_for(self, options, *, uv=True, origin=None):
        self.counter += 1
        authenticator = digest(options["rpId"].encode()) + (b"\x05" if uv else b"\x01") + struct.pack(">I", self.counter)
        client = self.browser_json(options["challenge"], "webauthn.get", origin)
        proof = self.key.sign(authenticator + digest(client), ec.ECDSA(hashes.SHA256()))
        return self.credential({"clientDataJSON": encoded(client), "authenticatorData": encoded(authenticator),
                                "signature": encoded(proof), "userHandle": self.handle})

    def credential(self, result):
        return {"id": encoded(self.id), "rawId": encoded(self.id), "type": "public-key",
                "response": result, "clientExtensionResults": {}}


class ImplicitTls(ftplib.FTP_TLS):
    def connect(self, host, port, timeout=10):
        self.host, self.port, self.timeout = host, port, timeout
        raw = socket.create_connection((host, port), timeout)
        try:
            self.sock = self.context.wrap_socket(raw, server_hostname=host)
        except BaseException:
            raw.close()
            raise
        self.af = self.sock.family
        self.file = self.sock.makefile("r", encoding=self.encoding)
        self.welcome = self.getresp()
        return self.welcome


class NotificationFixture(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), NotificationFixtureRequest)
        self.received = []
        self.responses = {}
        self.guard = threading.Lock()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_port}"

    def reply(self, path, body):
        with self.guard:
            self.received.append((path, body))
            responses = self.responses.get(path)
            if responses:
                return responses.pop(0)
        if path.endswith("/getMe"):
            return 200, {"ok": True, "result": {"id": 42, "username": "fixture_bot"}}, {}
        if path.endswith("/getChat"):
            return 200, {"ok": True, "result": {"id": -1001234567890, "type": "supergroup"}}, {}
        if path.endswith("/sendMessage"):
            return 200, {"ok": True, "result": {"message_id": 37}}, {}
        if path == "/push":
            return 200, {"code": 200, "message": "success"}, {}
        return 404, {"code": 404}, {}


class NotificationFixtureRequest(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        status, result, headers = self.server.reply(self.path, payload)
        body = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class Acceptance(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / ".local"
        scratch.mkdir(mode=0o700, exist_ok=True)
        workspace = tempfile.TemporaryDirectory(prefix="acceptance-", dir=scratch)
        self.addCleanup(workspace.cleanup)
        self.work = Path(workspace.name)
        self.home = self.work / "fixture-home"
        self.home.mkdir()
        self.agent_state = self.work / "agent"
        self.agent_state.mkdir(mode=0o700)
        self.http_port, self.plain_port, self.ftps_port, self.implicit_port = ports()
        self.origin = f"http://localhost:{self.http_port}"
        self.setup_key = secrets.token_urlsafe(32)
        self.cert = self.work / "tls.pem"
        self.key = self.work / "tls.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost", "-keyout", str(self.key), "-out", str(self.cert)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        low, high = passive_ports((self.http_port, self.plain_port, self.ftps_port, self.implicit_port))
        self.env = os.environ | {
            "ASPNETCORE_ENVIRONMENT": "Development",
            "ASPNETCORE_URLS": f"http://127.0.0.1:{self.http_port}",
            "FileSharing__Origin": self.origin,
            "FileSharing__DataDirectory": str(self.work / "db"),
            "FileSharing__BootstrapSecret": self.setup_key,
            "FileSharing__GatewayCredentialKey": secrets.token_hex(32),
            "FileSharing__MaxDevices": "3",
            "FileSharing__Ftp__Bind": "127.0.0.1",
            "FileSharing__Ftp__PlainPort": str(self.plain_port),
            "FileSharing__Ftp__ExplicitPort": str(self.ftps_port),
            "FileSharing__Ftp__ImplicitPort": str(self.implicit_port),
            "FileSharing__Ftp__PassiveMin": str(low),
            "FileSharing__Ftp__PassiveMax": str(high),
            "FileSharing__Ftp__Certificate": str(self.cert),
            "FileSharing__Ftp__CertificateKey": str(self.key),
            "Logging__LogLevel__Default": "Warning",
            "FILESHARING_TEST_STATE": str(self.agent_state),
            "FILESHARING_TEST_HOME": str(self.home),
            "FILESHARING_TEST_ORIGIN": self.origin,
            "TMPDIR": str(self.work),
        }
        self.browser = self.client()
        self.authenticator = Passkey(self.origin)
        self.start_server()

    def client(self):
        browser = requests.Session()
        browser.trust_env = False
        browser.headers["Origin"] = self.origin
        self.addCleanup(browser.close)
        return browser

    def start_server(self, polling=False):
        self.server = self.spawn(["dotnet", str(SERVER)], "server.log",
                                 self.env | {"FileSharing__BlockAgentWebSocket": str(polling).lower()})
        self.wait(lambda: self.browser.get(self.origin + "/health/ready", timeout=1).ok, seconds=12)

    def spawn(self, command, filename, env):
        with (self.work / filename).open("a") as output:
            process = subprocess.Popen(command, env=env, stdout=output, stderr=output)
        self.addCleanup(self.stop, process)
        return process

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=7)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def log_tail(self):
        result = []
        for name in ("server.log", "agent.log"):
            path = self.work / name
            if path.exists():
                result.append(f"{name}\n{path.read_text()[-3500:]}")
        return "\n".join(result)

    def wait(self, condition, seconds=15):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                value = condition()
                if value:
                    return value
            except (OSError, requests.RequestException):
                pass
            time.sleep(0.1)
        self.fail("Condition timed out.\n" + self.log_tail())

    def api(self, method, route, expected=200, session=None, **kwargs):
        response = (session or self.browser).request(method, self.origin + route, timeout=40, **kwargs)
        if response.status_code != expected:
            detail = response.text[:400] if "json" in response.headers.get("Content-Type", "") else response.reason
            self.fail(f"{method} {route}: expected {expected}, received {response.status_code} {detail}\n{self.log_tail()}")
        return response

    def register(self, key=None, recovery=False):
        path = AUTH + ("/recovery" if recovery else "/registration")
        options = self.api("POST", path + "/options", json={"secret": self.setup_key}).json()
        body = {"challengeId": options["challengeId"], "credential": (key or self.authenticator).create(options["publicKey"]),
                "secret": self.setup_key}
        self.api("POST", path, 204, json=body)
        return body

    def assertion(self, key=None, session=None, **kwargs):
        options = self.api("POST", AUTH + "/authentication/options", session=session).json()
        return {"challengeId": options["challengeId"],
                "credential": (key or self.authenticator).assert_for(options["publicKey"], **kwargs)}

    def unlock(self, key=None, session=None):
        body = self.assertion(key, session)
        return self.api("POST", AUTH + "/authentication", session=session, json=body)

    def setup_device(self, *, allow_access=True):
        self.register()
        self.unlock()
        self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)

        def online():
            rows = self.api("GET", API + "/devices").json()["items"]
            return next((item for item in rows if item["connection"]["online"]), None)

        registration = self.wait(online)
        self.device = registration["id"]
        self.device_api = f"{API}/devices/{self.device}"
        self.files_api = self.device_api + "/files"
        self.root_id = self.wait(lambda: self.api("GET", self.device_api + "/file-roots").json()["items"])[0]["id"]
        if allow_access:
            self.set_access(registration["connection"]["connectionId"], True)
        return registration

    def set_access(self, connection_id, enabled, expected=200, session=None):
        return self.api("PUT", self.device_api + "/connection-access", expected, session,
                        json={"connectionId": connection_id, "enabled": enabled}).json()

    def params(self, path="", **extra):
        return {"path": path, "rootId": self.root_id} | extra

    def entry(self, path, expected=200, **extra):
        return self.api("GET", self.files_api + "/entry", expected, params=self.params(path, **extra)).json()

    def transfer(self, kind, path=None, expected=201, key=None, **extra):
        return self.api("POST", API + "/transfers", expected,
                        headers={"Idempotency-Key": key or secrets.token_urlsafe(16)},
                        json={"deviceId": self.device, "rootId": self.root_id, "kind": kind, "path": path} | extra).json()

    def channel(self):
        cookie = "; ".join(f"{entry.name}={entry.value}" for entry in self.browser.cookies)
        return connect(self.origin.replace("http:", "ws:") + API + "/events/ws", origin=self.origin,
                       additional_headers={"Cookie": cookie}, proxy=None, open_timeout=6)

    @staticmethod
    def receive(channel, predicate, seconds=12):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            candidate = json.loads(channel.recv(timeout=max(0.01, deadline - time.monotonic())))
            if predicate(candidate):
                return candidate
        raise AssertionError("A matching event was not delivered.")

    def test_passkey_bootstrap_unlock_lock_recovery(self):
        self.assertEqual(self.api("GET", API + "/auth/status").json(), {"initialized": False, "unlocked": False, "session": None})
        self.api("GET", API + "/devices", 401)
        self.api("POST", AUTH + "/registration/options", 401, json={"secret": "x" * 64})
        registration = self.register()
        self.api("POST", AUTH + "/registration", 401, json=registration)
        self.api("POST", AUTH + "/registration/options", 409, json={"secret": self.setup_key})
        wrong_rp_origin = self.assertion(origin="https://unrelated.invalid")
        self.api("POST", AUTH + "/authentication", 401, json=wrong_rp_origin)
        no_uv = self.assertion(uv=False)
        self.api("POST", AUTH + "/authentication", 401, json=no_uv)
        login = self.unlock()
        self.assertIn("httponly", login.headers["Set-Cookie"].lower())
        self.assertIn("samesite=strict", login.headers["Set-Cookie"].lower())
        self.assertTrue(self.api("GET", API + "/auth/status").json()["unlocked"])
        self.api("POST", API + "/auth/lock", 403, headers={"Origin": "https://foreign.invalid"})
        with self.channel() as channel:
            self.assertEqual(json.loads(channel.recv(timeout=5))["type"], "ready")
            self.api("POST", API + "/auth/lock", 204)
            with self.assertRaises(ConnectionClosedError) as closed:
                channel.recv(timeout=6)
            self.assertEqual(closed.exception.rcvd.code, 1008)
        self.api("GET", API + "/devices", 401)
        self.api("POST", API + "/auth/lock", 204)

        other = self.client()
        self.unlock(session=other)
        before_recovery = self.assertion()
        replacement = Passkey(self.origin)
        self.register(replacement, recovery=True)
        self.api("GET", API + "/devices", 401, session=other)
        self.api("POST", AUTH + "/authentication", 401, json=before_recovery)
        self.unlock(replacement)
        self.assertTrue(self.api("GET", API + "/auth/status").json()["unlocked"])

    def test_public_admission_before_admin_registration(self):
        device = str(uuid.uuid4())
        self.assertFalse(self.api("GET", API + "/auth/status").json()["initialized"])
        address = self.origin.replace("http:", "ws:") + "/agent/v1/ws"
        with connect(address, proxy=None, open_timeout=6) as agent:
            agent.send(json.dumps({"type": "hello", "deviceId": device, "name": "First public device"}))
            self.assertEqual(json.loads(agent.recv(timeout=5)), {"type": "ready", "deviceId": device})
            self.api("GET", API + "/devices", 401)
            self.register()
            self.unlock()
            registered = self.api("GET", f"{API}/devices/{device}").json()
            self.assertEqual(registered["name"], "First public device")
            self.assertTrue(registered["connection"]["online"])
            self.assertFalse(registered["connection"]["accessGranted"])

    def test_device_zero_config_reconnect_and_long_poll(self):
        initial = self.setup_device(allow_access=False)
        record = json.loads((self.agent_state / "enrollment.json").read_text())
        self.assertEqual(record["deviceId"], self.device)
        self.assertEqual(Path(record["roots"][0]["path"]), self.home.resolve())
        self.assertFalse((self.agent_state / "test-key").exists())
        self.assertEqual(initial["connection"]["protocol"], "wss")
        self.assertFalse(initial["connection"]["accessGranted"])
        old_connection = initial["connection"]["connectionId"]
        anonymous = self.client()
        self.set_access(old_connection, True, 401, anonymous)
        self.assertEqual(self.entry("", 403)["code"], "agent_connection_access_required")
        approved = self.set_access(old_connection, True)
        self.assertTrue(approved["accessGranted"])
        self.entry("")
        self.set_access(old_connection, False)
        self.entry("", 403)
        self.set_access(old_connection, True)

        body = {"deviceId": self.device, "name": "Duplicate connection"}
        self.assertEqual(self.api("POST", "/agent/v1/connect", 409, anonymous, json=body).json()["code"],
                         "device_already_connected")
        self.assertEqual(self.api("GET", self.device_api).json()["connection"]["connectionId"], old_connection)

        def connect_anonymously(device):
            with requests.Session() as client:
                client.trust_env = False
                return client.post(self.origin + "/agent/v1/connect", timeout=12,
                                   json={"deviceId": str(device), "name": "Public test device"})

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            claimed = list(executor.map(connect_anonymously, [uuid.uuid4() for _ in range(3)]))
        self.assertEqual(sorted(result.status_code for result in claimed), [200, 200, 409])
        for result in claimed:
            if result.ok:
                self.api("DELETE", API + "/devices/" + result.json()["deviceId"], 204)

        self.stop(self.agent)
        self.wait(lambda: not self.api("GET", self.device_api).json()["connection"]["online"])
        replacement = self.api("POST", "/agent/v1/connect", session=anonymous, json=body).json()
        replacement_presence = self.api("GET", self.device_api).json()["connection"]
        self.assertNotEqual(replacement_presence["connectionId"], old_connection)
        self.assertFalse(replacement_presence["accessGranted"])
        self.assertEqual(self.set_access(old_connection, True, 409)["code"], "agent_connection_changed")
        self.api("GET", "/agent/v1/policy", 410, anonymous)
        channel = {"X-FileSharing-Channel": replacement["channel"]}
        policy = self.api("GET", "/agent/v1/policy", session=anonymous, headers=channel).json()
        self.assertFalse(policy["settings"]["keepAwake"])
        self.api("DELETE", "/agent/v1/connection", 204, anonymous, headers=channel)
        self.api("GET", "/agent/v1/policy", 410, anonymous, headers=channel)

        self.stop(self.server)
        self.start_server(polling=True)
        self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)
        self.wait(lambda: self.api("GET", self.device_api).json()["connection"]["protocol"] == "https", seconds=36)
        self.wait(lambda: self.api("GET", self.device_api + "/file-roots/local").json())
        again = self.api("GET", self.device_api).json()
        self.assertEqual(again["id"], self.device)
        self.assertEqual(again["name"], initial["name"])
        self.assertFalse(again["connection"]["accessGranted"])
        self.assertEqual(self.api("GET", self.device_api + "/file-roots").json()["items"][0]["id"], self.root_id)
        self.entry("", 403)
        self.set_access(again["connection"]["connectionId"], True)
        (self.home / "polling.txt").write_text("Long-poll fixture")
        self.assertEqual(self.entry("polling.txt")["size"], 17)
        self.assertEqual(json.loads((self.agent_state / "enrollment.json").read_text())["deviceId"], self.device)
        self.api("DELETE", self.device_api, 204)
        self.entry("polling.txt", 403)
        self.assertEqual(self.api("POST", "/agent/v1/connect", 403, anonymous, json=body).json()["code"], "device_revoked")

    def test_agent_watchdog_exits_a_blocked_startup(self):
        with (self.agent_state / "enrollment.lock").open("wb") as locked:
            fcntl.flock(locked, fcntl.LOCK_EX)
            blocked = self.spawn([str(APP), "run"], "agent.log", self.env)
            self.assertEqual(blocked.wait(timeout=34), os.EX_TEMPFAIL)

    def test_running_agent_recovers_when_server_restarts(self):
        registered = self.setup_device()
        connection_id = registered["connection"]["connectionId"]
        process = self.agent
        for polling in (False, True):
            self.stop(self.server)
            self.start_server(polling=polling)
            protocol = "https" if polling else "wss"

            def connected():
                current = self.api("GET", self.device_api).json()["connection"]
                return current if current["protocol"] == protocol and current["connectionId"] != connection_id else None

            current = self.wait(connected, seconds=20)
            self.assertIsNone(process.poll())
            self.assertTrue(current["online"])
            self.assertFalse(current["accessGranted"])
            connection_id = current["connectionId"]
            self.wait(lambda: self.api("GET", self.device_api + "/file-roots/local").json())
            self.set_access(connection_id, True)
            self.assertEqual(self.entry("")["kind"], "directory")

    def test_http_polling_retains_connection_after_a_transient_frame_error(self):
        self.stop(self.server)
        self.start_server(polling=True)
        upstream_port = self.http_port
        fail_next_frame = threading.Event()
        interrupted = threading.Event()

        class PollingProxy(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def forward(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path == "/agent/v1/frames" and fail_next_frame.is_set():
                    fail_next_frame.clear()
                    self.send_response(503)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    interrupted.set()
                    return
                headers = {key: self.headers[key] for key in ("X-FileSharing-Channel", "Content-Type") if key in self.headers}
                headers["Host"] = f"localhost:{upstream_port}"
                try:
                    with closing(HTTPConnection("127.0.0.1", upstream_port, timeout=25)) as origin:
                        origin.request(self.command, self.path, body=body, headers=headers)
                        result = origin.getresponse()
                        contents = result.read()
                        self.send_response(result.status)
                        self.send_header("Content-Length", str(len(contents)))
                        if content_type := result.getheader("Content-Type"):
                            self.send_header("Content-Type", content_type)
                        self.end_headers()
                        self.wfile.write(contents)
                except (ConnectionError, TimeoutError):
                    self.close_connection = True

            do_GET = do_POST = do_DELETE = forward

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), PollingProxy)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(proxy.server_close)
        self.addCleanup(proxy.shutdown)
        self.env["FILESHARING_TEST_ORIGIN"] = f"http://localhost:{proxy.server_port}"
        registered = self.setup_device()
        connection_id = registered["connection"]["connectionId"]
        self.assertEqual(registered["connection"]["protocol"], "https")
        fail_next_frame.set()
        job = self.api("POST", self.device_api + "/refresh", 202, json={"topics": ["identity"]}).json()
        self.assertTrue(interrupted.wait(8))
        self.assertEqual(self.finished_job(job)["state"], "completed")
        presence = self.api("GET", self.device_api).json()["connection"]
        self.assertEqual((presence["connectionId"], presence["accessGranted"]), (connection_id, True))

    def test_sqlite_upgrade_preserves_preexisting_device_and_grant(self):
        registration = self.setup_device()
        self.api("PUT", self.device_api, json={"name": "Existing Mac", "profileId": "default",
                                               "revision": registration["revision"]})
        legacy = self.api("POST", API + "/ftp/accounts", 201,
                          json={"name": "legacy", "mode": "ftp", "rootIds": [self.root_id]}).json()
        legacy_dialog_id = str(uuid.uuid4())
        stamp = "2026-11-20T08:30:00.123+00:00"
        reply = {"outcome": "submitted", "choiceId": "ok", "text": "Legacy fixture reply", "respondedAt": stamp}
        self.stop(self.agent)
        self.stop(self.server)
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data, data:
            data.executescript("""
                ALTER TABLE Devices ADD COLUMN PublicKey BLOB;
                CREATE UNIQUE INDEX LegacyDeviceKey ON Devices(PublicKey);
                CREATE TABLE AgentTokens(Hash TEXT PRIMARY KEY, DeviceId TEXT REFERENCES Devices(Id), Expires INTEGER);
                CREATE TABLE Activations(Id TEXT PRIMARY KEY, SecretHash TEXT);
                INSERT INTO Activations VALUES('old-ticket', 'fixture');
                UPDATE Devices SET PublicKey=X'010203';
                DROP TABLE GatewayMounts;
                DROP TABLE NotificationChannels;
                DROP TABLE NotificationDeliveries;
                DROP TABLE NotificationUpdates;
                DROP TABLE NotificationCooldowns;
                DROP TABLE NotificationRules;
                DROP TABLE NotificationDevices;
                DROP TABLE NotificationSamples;
                DROP TABLE ClipboardRecords;
                DROP TABLE DialogRecords;
                CREATE TABLE FtpAccountsPrior(
                    Id TEXT PRIMARY KEY, Name TEXT NOT NULL COLLATE NOCASE UNIQUE, Owner TEXT NOT NULL REFERENCES Operators(Id),
                    Mode TEXT NOT NULL CHECK(Mode IN ('ftp','ftps')), SecretHash TEXT NOT NULL,
                    Disabled INTEGER NOT NULL DEFAULT 0, Failed INTEGER NOT NULL DEFAULT 0,
                    LockUntil INTEGER NOT NULL DEFAULT 0, Revision INTEGER NOT NULL DEFAULT 1);
                INSERT INTO FtpAccountsPrior SELECT Id,Name,Owner,Mode,SecretHash,Disabled,Failed,LockUntil,Revision FROM FtpAccounts;
                DROP TABLE FtpAccounts;
                ALTER TABLE FtpAccountsPrior RENAME TO FtpAccounts;
                PRAGMA user_version=1;
            """)
            now = int(time.time())
            data.execute("""
                INSERT INTO Jobs(Id,Owner,DeviceId,Kind,State,Created,Finished,Result,ReviewId)
                SELECT ?,Id,?,'interaction.dialog','completed',?,?,?,'legacy-review' FROM Operators
                """, (legacy_dialog_id, self.device, now - 10, now, json.dumps(reply)))
            clipboard_id = data.execute("INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(?,'clipboard.changed',?,?)",
                                        (self.device, now, json.dumps({"occurredAt": stamp}))).lastrowid
        self.start_server()
        existing = self.api("GET", self.device_api).json()
        self.assertEqual(existing["name"], "Existing Mac")
        self.assertEqual(self.api("GET", self.device_api + "/file-roots").json()["items"][0]["id"], self.root_id)
        account = self.api("GET", API + "/ftp/accounts/" + legacy["account"]["id"]).json()
        self.assertEqual((account["scope"], account["rootIds"], account["passwordRetrievable"]), ("grants", [self.root_id], False))
        self.api("POST", f"{API}/ftp/accounts/{account['id']}/password/reveal", 409)
        dialog = self.api("GET", self.device_api + "/interactions/dialogs/" + legacy_dialog_id).json()
        self.assertEqual(dialog["result"], reply)
        self.assertIsNone(dialog["request"])
        item = self.api("GET", self.device_api + f"/clipboard/records/{clipboard_id}").json()
        self.assertEqual((item["occurredAt"], item["content"]), (stamp, "N/A"))
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data, data:
            self.assertEqual(data.execute("PRAGMA user_version").fetchone()[0], 8)
            self.assertEqual(data.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertNotIn("PublicKey", [row[1] for row in data.execute("PRAGMA table_info(Devices)")])
            self.assertEqual(data.execute("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('AgentTokens','Activations')").fetchone()[0], 0)

    def test_directory_metadata_sort_and_thumbnail(self):
        self.setup_device()
        (self.home / "folder").mkdir()
        (self.home / "folder" / "nested").mkdir()
        (self.home / "folder" / "nested" / "readme.txt").write_bytes(b"Example")
        (self.home / ".hidden").write_bytes(b"x")
        (self.home / "hello.txt").write_bytes(b"Hi")
        (self.home / "picture.png").write_bytes(png())
        parameters = self.params(hidden=True, limit=2, sort="size", direction="desc")
        page = self.api("GET", self.files_api + "/entries", params=parameters).json()
        self.assertEqual(page["total"], 4)
        self.assertEqual([entry["name"] for entry in page["items"]], ["picture.png", "hello.txt"])
        following = self.api("GET", self.files_api + "/entries", params=parameters | {
            "offset": page["nextOffset"], "revision": page["revision"]}).json()
        self.assertEqual([entry["name"] for entry in following["items"]], [".hidden", "folder"])
        self.assertIsNone(following["nextOffset"])
        self.api("GET", self.files_api + "/entries", 400, params=parameters | {"sort": "wrong"})
        for sort in ("name", "createdAt", "modifiedAt", "type", "lastOpenedAt"):
            with self.subTest(sort=sort):
                response = self.api("GET", self.files_api + "/entries", params=self.params(sort=sort)).json()
                self.assertEqual({row["name"] for row in response["items"]}, {"folder", "hello.txt", "picture.png"})
        folder = self.entry("folder")
        self.assertEqual(folder["folder"], {"folderSize": 7, "filesCount": 1, "foldersCount": 1, "complete": True})
        image = self.entry("picture.png")
        self.assertTrue(image["fullPath"].endswith("/fixture-home/picture.png"))
        self.assertEqual((image["extension"], image["fileType"], image["thumbnail"]), ("png", "public.png", "image"))
        self.assertIn("lastOpenedAt", image)
        self.assertIsNotNone(image["createdAt"])
        self.assertIsNotNone(image["modifiedAt"])
        response = self.api("GET", self.files_api + "/thumbnail", params=self.params(image["path"], version=image["version"]))
        self.assertEqual(response.headers["Content-Type"], "image/png")
        self.assertTrue(response.content.startswith(b"\x89PNG\r\n\x1a\n"))
        (self.home / "changed.txt").touch()
        self.api("GET", self.files_api + "/entries", 409, params=parameters | {"offset": 2, "revision": page["revision"]})

    def test_directory_websocket_rename_and_external_change(self):
        self.setup_device()
        folder = self.home / "watched"
        folder.mkdir()
        (folder / "before.txt").write_text("content")
        with self.channel() as channel:
            channel.send(json.dumps({"type": "subscribe", "id": "watch-directory", "deviceId": self.device,
                                     "topic": "files.changed", "rootId": self.root_id, "path": "watched"}))
            self.receive(channel, lambda frame: frame.get("type") == "subscribed")
            (folder / "before.txt").rename(folder / "after.txt")

            def change(kind):
                def matching(frame):
                    if frame.get("type") != "event":
                        return False
                    body = frame["item"]["payload"]
                    return any(item["kind"] == kind for item in body["change"].get("changes", []))
                return matching

            event = self.receive(channel, change("renamed"))
            delta = event["item"]["payload"]["change"]["changes"][0]
            self.assertEqual(delta["fromPath"], "watched/before.txt")
            self.assertEqual(delta["entry"]["path"], "watched/after.txt")
            self.assertEqual(delta["entry"]["extension"], "txt")
            (folder / "after.txt").write_text("updated fixture")
            self.receive(channel, change("updated"))
            channel.send(json.dumps({"type": "unsubscribe", "id": "watch-directory"}))
            self.receive(channel, lambda frame: frame.get("type") == "unsubscribed")

    def test_scoped_move_trash_and_permanent_delete(self):
        self.setup_device()
        (self.home / "source.txt").write_text("File content")
        (self.home / "outside-link").symlink_to(self.agent_state, target_is_directory=True)
        (self.home / ".ssh").mkdir()
        (self.home / ".ssh" / "placeholder").write_text("Control directory fixture")
        self.entry("../agent/enrollment.json", 400)
        self.entry("outside-link/enrollment.json", 404)
        self.entry(".ssh/placeholder", 403)
        self.assertNotIn(".ssh", [item["name"] for item in self.api("GET", self.files_api + "/entries",
                                                                  params=self.params(hidden=True)).json()["items"]])
        before = self.entry("source.txt")
        rename = {"rootId": self.root_id, "path": "source.txt", "newName": "source.md", "version": before["version"]}
        after = self.api("POST", self.files_api + "/renames", json=rename).json()
        self.assertEqual(after["extension"], "md")
        self.entry("source.txt", 404)
        (self.home / "target").mkdir()
        moved = self.api("POST", self.files_api + "/moves", json={"rootId": self.root_id, "path": after["path"],
                         "version": after["version"], "destination": "target/moved.md"}).json()
        self.assertEqual(moved["path"], "target/moved.md")
        self.api("POST", self.files_api + "/trash", 412,
                 json={"rootId": self.root_id, "path": moved["path"], "version": "stale-version"})
        trash = self.api("POST", self.files_api + "/trash",
                         json={"rootId": self.root_id, "path": moved["path"], "version": moved["version"]}).json()
        self.assertEqual((self.home / ".Trash" / trash["trashName"]).read_text(), "File content")
        self.assertFalse((self.home / "target" / "moved.md").exists())
        (self.home / "target" / "child.txt").write_text("purge fixture")
        folder = self.entry("target")
        renamed = self.api("POST", self.files_api + "/renames",
                           json={"rootId": self.root_id, "path": "target", "newName": "renamed", "version": folder["version"]}).json()
        self.api("DELETE", self.files_api + "/entry", 409, params=self.params("renamed", version=renamed["version"]))
        self.api("DELETE", self.files_api + "/entry", 204,
                 params=self.params("renamed", version=renamed["version"], recursive=True))
        self.assertFalse((self.home / "renamed").exists())
        self.assertTrue((self.agent_state / "enrollment.json").exists())

    def test_stream_ranges_resume_and_version_precondition(self):
        self.setup_device()
        source = (b"FileSharing repeatable transfer " * 82000) + b"EOF"
        (self.home / "large.bin").write_bytes(source)
        transfer = self.transfer("download", "large.bin")
        path = transfer["downloadUrl"]
        meta = self.api("HEAD", path)
        self.assertEqual(int(meta.headers["Content-Length"]), len(source))
        weak_range = self.api("GET", path, 206, headers={"Range": "bytes=-8"})
        self.assertEqual(weak_range.content, source[-8:])
        self.assertEqual(self.api("GET", API + "/transfers/" + transfer["id"]).json()["offset"], 0)
        initial = self.api("GET", path, 206, headers={"Range": "bytes=0-996"})
        continuation = self.api("GET", path, 206, headers={"Range": "bytes=997-", "If-Range": meta.headers["ETag"]})
        self.assertEqual(digest(initial.content + continuation.content), digest(source))
        self.assertEqual(continuation.headers["Content-Range"], f"bytes 997-{len(source)-1}/{len(source)}")
        self.assertEqual(self.api("GET", API + "/transfers/" + transfer["id"]).json()["state"], "completed")
        invalid = self.api("GET", path, 416, headers={"Range": f"bytes={len(source)}-"})
        self.assertEqual(invalid.headers["Content-Range"], f"bytes */{len(source)}")
        (self.home / "large.bin").write_bytes(b"changed")
        self.api("GET", path, 412, headers={"Range": "bytes=1-", "If-Range": meta.headers["ETag"]})

        remote_offset = (1 << 32) + 777
        with (self.home / "sparse.bin").open("wb") as sparse:
            sparse.seek(remote_offset)
            sparse.write(b"64BITEOF")
        large = self.transfer("download", "sparse.bin")
        self.assertEqual(large["length"], remote_offset + 8)
        result = self.api("GET", large["downloadUrl"], 206, headers={"Range": f"bytes={remote_offset}-"})
        self.assertEqual(result.content, b"64BITEOF")
        self.assertEqual(result.headers["Content-Range"], f"bytes {remote_offset}-{remote_offset + 7}/{remote_offset + 8}")

    def test_upload_chunks_resume_and_publish(self):
        self.setup_device()
        payload = b"Upload fixture with retry"
        target = self.home / "new.txt"
        upload = self.transfer("upload", "new.txt", length=len(payload))
        stage = API + "/transfers/" + upload["id"]
        endpoint = stage + "/content"

        def chunk(offset, contents, expected=204):
            return self.api("PUT", endpoint, expected, data=contents,
                            headers={"Upload-Offset": str(offset), "Content-Type": "application/octet-stream"})

        chunk(1, payload[:7], 409)
        self.assertEqual(chunk(0, payload[:7]).headers["Upload-Offset"], "7")
        self.assertEqual(chunk(0, payload[:7]).headers["Upload-Offset"], "7")
        self.api("POST", stage + "/commit", 409)
        self.assertFalse(target.exists())
        self.assertEqual(chunk(7, payload[7:]).headers["Upload-Offset"], str(len(payload)))
        published = self.api("POST", stage + "/commit").json()
        self.assertEqual(target.read_bytes(), payload)
        self.assertEqual(self.api("POST", stage + "/commit").json()["version"], published["version"])

    def test_zip_transfer_and_cancel(self):
        self.setup_device()
        (self.home / "parent" / "empty").mkdir(parents=True)
        (self.home / "parent" / ".inside").write_text("Hidden file")
        (self.home / "另外.txt").write_text("Unicode file")
        idempotency = secrets.token_urlsafe(16)
        entries = ["parent", "另外.txt"]
        task = self.transfer("archive", key=idempotency, entries=entries)
        repeated = self.transfer("archive", expected=200, key=idempotency, entries=entries)
        self.assertEqual(repeated["id"], task["id"])
        self.transfer("archive", expected=409, key=idempotency, entries=["另外.txt"])
        status_path = API + "/transfers/" + task["id"]

        def packaged():
            current = self.api("GET", status_path).json()
            self.assertNotEqual(current["state"], "failed", current)
            return current if current["state"] == "ready" else None

        link = self.wait(packaged)["downloadUrl"]
        response = self.api("GET", link)
        self.assertEqual(response.headers["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(set(archive.namelist()), {"parent/", "parent/empty/", "parent/.inside", "另外.txt"})
            self.assertEqual(archive.read("parent/.inside"), b"Hidden file")
            self.assertEqual(archive.read("另外.txt"), b"Unicode file")
            self.assertIsNone(archive.testzip())

        download = self.transfer("download", "另外.txt")
        status = API + "/transfers/" + download["id"]
        self.api("DELETE", status, 204)
        self.api("DELETE", status, 204)
        self.assertEqual(self.api("GET", status).json()["state"], "cancelled")
        self.api("GET", download["downloadUrl"], 409)

    def open_ftp(self, mode, endpoint, credential):
        ctx = ssl.create_default_context(cafile=self.cert)
        if mode == "plain":
            client = ftplib.FTP()
        elif mode == "explicitTls":
            client = ftplib.FTP_TLS(context=ctx)
        else:
            client = ImplicitTls(context=ctx)
        self.addCleanup(client.close)
        client.connect("localhost", endpoint, timeout=12)
        client.login(credential["account"]["name"], credential["password"])
        if mode != "plain":
            client.prot_p()
        return client

    def test_loopback_ftp_active_listing_and_protected_download(self):
        self.setup_device()
        content = b"FTP active data fixture\n"
        (self.home / "active.txt").write_bytes(content)
        route = API + "/ftp/accounts"
        plain = self.api("POST", route, 201, json={"mode": "ftp", "name": "active-fixture", "scope": "activeHomes"}).json()
        secure = self.api("POST", route, 201, json={"mode": "ftps", "name": "active-secure-fixture", "scope": "activeHomes"}).json()

        with ftplib.FTP() as anonymous:
            anonymous.connect("127.0.0.1", self.plain_port, timeout=8)
            with self.assertRaisesRegex(ftplib.error_perm, "^530 "):
                anonymous.sendcmd("EPRT |1|127.0.0.1|49152|")

        with self.open_ftp("plain", self.plain_port, plain) as client:
            client.set_pasv(False)
            mount, = client.nlst("/")
            client.cwd(f"/{mount}")
            lines = []
            client.retrlines("LIST", lines.append)
            self.assertTrue(any(line.endswith(" active.txt") for line in lines))
            self.assertEqual(dict(client.mlsd())["active.txt"]["size"], str(len(content)))

            with socket.create_server(("127.0.0.1", 0)) as listener:
                listener.settimeout(8)
                host, port = listener.getsockname()
                self.assertTrue(client.sendeprt(host, port).startswith("200 "))
                self.assertTrue(client.sendcmd("NLST").startswith("150 "))
                data, address = listener.accept()
                self.assertEqual(address[0], host)
                with data, data.makefile("rb") as names:
                    self.assertEqual(names.read(), b"active.txt\r\n")
                self.assertTrue(client.voidresp().startswith("226 "))
                for invalid in (f"EPRT |1|127.0.0.2|{port}|", "PORT 127,0,0,1,0,21", "PORT 127,0,0,1,256,0"):
                    with self.assertRaisesRegex(ftplib.error_perm, "^501 "):
                        client.sendcmd(invalid)
            with self.assertRaisesRegex(ftplib.error_temp, "^425 "):
                client.sendcmd("NLST")
            client.set_pasv(True)
            self.assertEqual(client.nlst(), ["active.txt"])
            self.assertTrue(client.sendcmd("EPSV ALL").startswith("200 "))
            with self.assertRaisesRegex(ftplib.error_perm, "^501 "):
                client.sendcmd("PASV")
            self.assertTrue(client.sendcmd("EPSV").startswith("229 "))

        for mode, port in (("explicitTls", self.ftps_port), ("implicitTls", self.implicit_port)):
            with self.subTest(mode=mode), self.open_ftp(mode, port, secure) as client:
                client.set_pasv(False)
                received = io.BytesIO()
                client.retrbinary(f"RETR /{mount}/active.txt", received.write)
                self.assertEqual(received.getvalue(), content)

    def test_ftp_repeated_valid_logins_preserve_ip_limit(self):
        self.register()
        self.unlock()
        credential = self.api("POST", API + "/ftp/accounts", 201,
                              json={"mode": "ftp", "name": "repeat-fixture", "scope": "activeHomes"}).json()
        for _ in range(24):
            with self.open_ftp("plain", self.plain_port, credential) as client:
                self.assertEqual(client.pwd(), "/")
                client.quit()

        with ftplib.FTP() as invalid:
            invalid.connect("127.0.0.1", self.plain_port, timeout=8)
            for _ in range(17):
                with self.assertRaisesRegex(ftplib.error_perm, "^530 "):
                    invalid.login("missing-fixture", "incorrect-fixture")
            with self.assertRaisesRegex(ftplib.error_temp, "^421 "):
                invalid.login("missing-fixture", "incorrect-fixture")
        with self.open_ftp("plain", self.plain_port, credential) as client:
            self.assertEqual(client.pwd(), "/")

    def test_ftp_cached_login_respects_account_lock_and_password_rotation(self):
        self.register()
        self.unlock()
        route = API + "/ftp/accounts"
        original = self.api("POST", route, 201,
                            json={"mode": "ftp", "name": "rotation-fixture", "scope": "activeHomes"}).json()
        with self.open_ftp("plain", self.plain_port, original) as client:
            self.assertEqual(client.pwd(), "/")
            client.quit()
        account = original["account"]
        rotated = self.api("PUT", route + f"/{account['id']}/password", json={"revision": account["revision"]}).json()
        with ftplib.FTP() as invalid:
            invalid.connect("127.0.0.1", self.plain_port, timeout=8)
            with self.assertRaisesRegex(ftplib.error_perm, "^530 "):
                invalid.login(account["name"], original["password"])

        with self.open_ftp("plain", self.plain_port, rotated) as client:
            self.assertEqual(client.pwd(), "/")
            client.quit()
        with ftplib.FTP() as invalid:
            invalid.connect("127.0.0.1", self.plain_port, timeout=8)
            for _ in range(5):
                with self.assertRaisesRegex(ftplib.error_perm, "^530 "):
                    invalid.login(account["name"], "incorrect-fixture")
            with self.assertRaisesRegex(ftplib.error_perm, "^530 "):
                invalid.login(account["name"], rotated["password"])

    def test_ftp_ftps_locked_sessions_and_password_rotation(self):
        self.setup_device()
        content = b"File transfer fixture" * 2500
        (self.home / "payload.bin").write_bytes(content)
        route = API + "/ftp"
        endpoints = {entry["mode"]: entry for entry in self.api("GET", route + "/connection").json()}
        self.assertEqual({entry["port"] for entry in endpoints.values()},
                         {self.plain_port, self.ftps_port, self.implicit_port})
        plain = self.api("POST", route + "/accounts", 201, json={"mode": "ftp", "name": "private-ftp",
                         "rootIds": [self.root_id]}).json()
        secure = self.api("POST", route + "/accounts", 201, json={"mode": "ftps", "name": "secure-ftps",
                          "rootIds": [self.root_id]}).json()
        self.assertNotIn("password", self.api("GET", route + "/accounts/" + secure["account"]["id"]).json())
        connection_id = self.api("GET", self.device_api).json()["connection"]["connectionId"]
        self.set_access(connection_id, False)
        denied = self.open_ftp("plain", self.plain_port, plain)
        self.assertEqual(denied.nlst(), [])
        with self.assertRaisesRegex(ftplib.error_perm, "^550 "):
            denied.cwd(f"/{self.device}/{self.root_id}")
        denied.quit()
        self.set_access(connection_id, True)
        self.api("POST", API + "/auth/lock", 204)
        self.api("GET", route + "/connection", 401)
        with ftplib.FTP() as downgraded:
            downgraded.connect("localhost", self.ftps_port, timeout=8)
            with self.assertRaisesRegex(ftplib.error_perm, "^534 "):
                downgraded.login(secure["account"]["name"], secure["password"])
        for mode, number, credential in (("plain", self.plain_port, plain), ("explicitTls", self.ftps_port, secure),
                                          ("implicitTls", self.implicit_port, secure)):
            with self.subTest(mode=mode):
                client = self.open_ftp(mode, number, credential)
                self.assertEqual(client.nlst(), [self.device])
                client.cwd(f"/{self.device}/{self.root_id}")
                self.assertEqual(dict(client.mlsd())["payload.bin"]["size"], str(len(content)))
                receive = io.BytesIO()
                client.retrbinary("RETR payload.bin", receive.write)
                self.assertEqual(digest(receive.getvalue()), digest(content))
                resumed = io.BytesIO()
                client.retrbinary("RETR payload.bin", resumed.write, rest=521)
                self.assertEqual(resumed.getvalue(), content[521:])
                if mode != "explicitTls":
                    client.quit()
                else:
                    active = client
        self.unlock()
        account = secure["account"]
        new_password = "Operator-rotated-42-strong"
        rotated = self.api("PUT", route + "/accounts/" + account["id"] + "/password",
                           json={"revision": account["revision"], "password": new_password}).json()
        self.assertEqual(rotated["password"], new_password)
        with self.assertRaisesRegex(ftplib.error_perm, "^530 "):
            active.pwd()
        self.api("POST", API + "/auth/lock", 204)
        client = self.open_ftp("explicitTls", self.ftps_port, rotated)
        self.assertEqual(client.pwd(), "/")
        client.quit()

    def test_sftp_home_paging_download_password_revocation_and_host_key(self):
        self.stop(self.server)
        sftp_port = port()
        self.env.update({"FileSharing__Sftp__Port": str(sftp_port), "FileSharing__Sftp__BridgePort": str(self.http_port),
                         "FileSharing__Sftp__Binary": str(SFTP)})
        self.start_server()
        registration = self.setup_device()
        self.api("PUT", self.device_api, json={"name": "Mac1", "profileId": "default", "revision": registration["revision"]})
        data = secrets.token_bytes(1_013_456)
        (self.home / "source.bin").write_bytes(data)
        for number in range(206):
            (self.home / f"entry{number:03d}.txt").touch()
        outside = self.work / "outside.txt"
        outside.write_text("Outside the authorized root")
        (self.home / "outside-link.txt").symlink_to(outside)
        credential = self.api("POST", API + "/ftp/accounts", 201, json={"name": "sftp-fixture", "mode": "sftp",
                                                                       "scope": "activeHomes"}).json()
        endpoint, = credential["endpoints"]
        self.assertEqual((endpoint["mode"], endpoint["port"], endpoint["available"]), ("sftp", sftp_port, True))
        fingerprint = endpoint["hostKeyFingerprint"]
        sftp, ssh, env = sftp_client(self.work, sftp_port, fingerprint, credential)
        self.api("POST", "/_sftp/open", 404, json={})

        with subprocess.Popen(sftp, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              cwd=self.work, env=env, text=True) as process:
            def live():
                return next(iter(self.api("GET", API + "/ftp/connections").json()), None)
            connection = self.wait(live)
            self.assertEqual((connection["accountId"], connection["protocol"]), (credential["account"]["id"], "sftp"))
            stdout, stderr = process.communicate("ls /\nls /mac1\nget /mac1/source.bin downloaded.bin\nbye\n", timeout=45)
            self.assertEqual(process.returncode, 0, stdout[-1000:] + stderr[-2000:])
            self.assertIn("mac1", stdout)
            self.assertIn("entry205.txt", stdout)
            self.assertIn("outside-link.txt", stdout)
            self.assertEqual((self.work / "downloaded.bin").read_bytes(), data)
        self.wait(lambda: not self.api("GET", API + "/ftp/connections").json())
        self.api("POST", API + "/auth/lock", 204)
        read_only = subprocess.run(sftp, input="ls /\nput outside.txt /mac1/unwanted.txt\n", cwd=self.work,
                                   env=env, capture_output=True, text=True, timeout=15)
        self.assertNotEqual(read_only.returncode, 0)
        self.assertIn("mac1", read_only.stdout)
        self.assertFalse((self.home / "unwanted.txt").exists())
        link = subprocess.run(sftp, input="get /mac1/outside-link.txt denied.txt\n", cwd=self.work, env=env,
                              capture_output=True, text=True, timeout=15)
        self.assertNotEqual(link.returncode, 0)
        shell = subprocess.run(ssh + ["true"], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
        self.assertNotEqual(shell.returncode, 0)
        self.assertIn("exec request failed", shell.stderr.lower())
        self.unlock()

        account = credential["account"]
        subsystem = [*ssh[:-1], "-s", ssh[-1], "sftp"]
        with subprocess.Popen(subsystem, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              cwd=self.work, env=env, text=True) as process:
            self.wait(live)
            rotated = self.api("PUT", f"{API}/ftp/accounts/{account['id']}/password", json={"revision": account["revision"]}).json()
            self.assertNotEqual(rotated["password"], credential["password"])
            self.assertEqual(self.api("GET", API + "/ftp/connections").json(), [])
            self.wait(lambda: process.poll() is not None)
        revoked = subprocess.run(sftp, input="ls /\n", cwd=self.work, env=env, capture_output=True, text=True, timeout=15)
        self.assertNotEqual(revoked.returncode, 0)
        new_client, _, new_env = sftp_client(self.work, sftp_port, fingerprint, rotated)
        verified = subprocess.run(new_client, input="ls /\nbye\n", cwd=self.work, env=new_env, capture_output=True, text=True, timeout=15)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn("mac1", verified.stdout)
        self.stop(self.server)
        self.start_server()
        endpoint = next(item for item in self.api("GET", API + "/ftp/connection").json() if item["mode"] == "sftp")
        self.assertEqual(endpoint["hostKeyFingerprint"], fingerprint)

    def test_home_volume_identity_recovers_directory_and_ftp_listings(self):
        downloads = self.home / "Downloads"
        downloads.mkdir()
        (downloads / "sample.txt").write_text("shared contents")
        registration = self.setup_device()
        connection_id = registration["connection"]["connectionId"]
        enrollment_file = self.agent_state / "enrollment.json"
        original_root, = json.loads(enrollment_file.read_text())["roots"]
        credential = self.api("POST", API + "/ftp/accounts", 201,
                              json={"name": "volume-fixture", "mode": "ftp", "scope": "activeHomes"}).json()

        def remount(metadata):
            nonlocal connection_id
            self.stop(self.agent)
            registered = json.loads(enrollment_file.read_text())
            root, = registered["roots"]
            root["deviceNumber"] = os.stat(self.home).st_dev ^ 1
            metadata(root)
            enrollment_file.write_text(json.dumps(registered))
            self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)

            def reconnected():
                current = self.api("GET", self.device_api).json()["connection"]
                return current if current["online"] and current["connectionId"] != connection_id else None

            connection_id = self.wait(reconnected)["connectionId"]
            self.wait(lambda: self.api("GET", self.device_api + "/file-roots/local").json())
            self.set_access(connection_id, True)
            self.assertEqual(self.api("GET", self.device_api + "/file-roots").json()["items"][0]["id"], self.root_id)
            return json.loads(enrollment_file.read_text())["roots"][0]

        def list_downloads():
            page = self.api("GET", self.files_api + "/entries", params=self.params("Downloads")).json()
            self.assertEqual([entry["name"] for entry in page["items"]], ["sample.txt"])

        upgraded = remount(lambda root: root.pop("volumeUUID"))
        self.assertEqual(upgraded["deviceNumber"], os.stat(self.home).st_dev)
        self.assertEqual(upgraded["volumeUUID"], original_root["volumeUUID"])
        list_downloads()
        with self.open_ftp("plain", self.plain_port, credential) as client:
            mount, = client.nlst("/")
            self.assertIn("Downloads", client.nlst(f"/{mount}"))
            client.cwd(f"/{mount}")
            self.assertEqual(list(client.mlsd("Downloads"))[0][0], "sample.txt")
            lines = []
            client.retrlines("LIST -la Downloads", lines.append)
            self.assertTrue(any(line.endswith(" sample.txt") for line in lines))

        same_volume = remount(lambda root: None)
        self.assertEqual(same_volume["volumeUUID"], upgraded["volumeUUID"])
        self.assertNotEqual(same_volume["deviceNumber"], upgraded["deviceNumber"])
        list_downloads()

        remount(lambda root: root.update(volumeUUID=str(uuid.uuid4())))
        error = self.api("GET", self.files_api + "/entries", 409, params=self.params()).json()
        self.assertEqual(error["code"], "root_identity_changed")
        with self.open_ftp("plain", self.plain_port, credential) as client:
            mount, = client.nlst("/")
            with self.assertRaisesRegex(ftplib.error_perm, "550 Shared directory needs local reapproval"):
                client.cwd(f"/{mount}")

    def test_gateway_live_home_scope_connections_and_encrypted_password_reveal(self):
        registration = self.setup_device()
        self.api("PUT", self.device_api, json={"name": "Mac1", "profileId": "default", "revision": registration["revision"]})
        (self.home / "shared.txt").write_text("First Mac")
        second_home = self.work / "second-home"
        second_home.mkdir()
        (second_home / "shared.txt").write_text("Second Mac")
        self.spawn([str(APP), "run"], "second-agent.log", self.env | {
            "FILESHARING_TEST_HOME": str(second_home),
            "FILESHARING_TEST_STATE": str(self.work / "second-agent"),
        })
        other = self.wait(lambda: next((item for item in self.api("GET", API + "/devices").json()["items"]
                                       if item["id"] != self.device and item["connection"]["online"]), None))
        other_route = f"{API}/devices/{other['id']}"
        self.api("PUT", other_route, json={"name": "Mac2", "profileId": "default", "revision": other["revision"]})
        group = API + "/ftp/accounts"
        credential = self.api("POST", group, 201, json={"name": "operator-homes", "mode": "ftps", "scope": "activeHomes"}).json()
        account = credential["account"]
        path = group + "/" + account["id"]
        self.assertEqual((account["scope"], account["rootIds"]), ("activeHomes", []))
        self.assertNotIn("password", self.api("GET", path).json())
        self.assertTrue(account["passwordRetrievable"])
        self.api("POST", path + "/password/reveal", 401, session=self.client())
        reveal = self.api("POST", path + "/password/reveal").json()
        self.assertEqual(reveal, {"name": account["name"], "password": credential["password"]})
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data, data:
            stored = data.execute("SELECT SecretHash,SecretCipher FROM FtpAccounts WHERE Id=?", (account["id"],)).fetchone()
            self.assertTrue(all(value and credential["password"] not in value for value in stored))
            data.execute("UPDATE Reviews SET Created=Created-301 WHERE Revoked IS NULL")
        self.assertEqual(self.api("POST", path + "/password/reveal", 403).json()["code"], "fresh_passkey_required")
        self.unlock()

        endpoint = next(item for item in credential["endpoints"] if item["mode"] == "explicitTls")
        with self.open_ftp("explicitTls", endpoint["port"], credential) as client:
            self.assertEqual(client.nlst("/"), ["mac1"])
            connection, = self.api("GET", API + "/ftp/connections", params={"accountId": account["id"]}).json()
            self.assertEqual((connection["accountId"], connection["protocol"]), (account["id"], "ftps"))
            self.wait(lambda: self.api("GET", other_route + "/file-roots").json()["items"])
            self.api("PUT", other_route + "/connection-access",
                     json={"connectionId": other["connection"]["connectionId"], "enabled": True})
            self.assertEqual(set(client.nlst("/")), {"mac1", "mac2"})
            for name, text in (("mac1", b"First Mac"), ("mac2", b"Second Mac")):
                output = io.BytesIO()
                client.retrbinary(f"RETR /{name}/shared.txt", output.write)
                self.assertEqual(output.getvalue(), text)
            self.set_access(registration["connection"]["connectionId"], False)
            self.assertEqual(client.nlst("/"), ["mac2"])
            updated = self.api("PUT", path + "/password", json={"revision": account["revision"]}).json()
            self.assertEqual(self.api("POST", path + "/password/reveal").json()["password"], updated["password"])
            self.assertEqual(self.api("GET", API + "/ftp/connections").json(), [])
            with self.assertRaises(ftplib.error_perm):
                client.nlst("/")

    def test_application_inventory_icon_hash_and_native_lifecycle(self):
        apps = self.home / "Applications"
        apps.mkdir()
        staged = self.work / "FileSharingFixture.app"
        contents = staged / "Contents"
        executable = contents / "MacOS" / "FileSharingFixture"
        executable.parent.mkdir(parents=True)
        identifier = "in.ryanl.filesharing.test." + uuid.uuid4().hex
        info = {"CFBundleName": "FileSharing Fixture", "CFBundleIdentifier": identifier,
                "CFBundleExecutable": "FileSharingFixture", "CFBundlePackageType": "APPL",
                "CFBundleShortVersionString": "1.0", "CFBundleVersion": "1", "LSUIElement": True}
        (contents / "Info.plist").write_bytes(plistlib.dumps(info))
        source = self.work / "ApplicationFixture.swift"
        source.write_text("""
import AppKit
let stop = CommandLine.arguments.dropFirst().first { $0.hasPrefix("/") }!
let deadline = Date().addingTimeInterval(90)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: stop) || Date() >= deadline { app.terminate(nil) }
}
app.run()
""")
        subprocess.run(["swiftc", str(source), "-o", str(executable)], check=True, capture_output=True, timeout=40)
        self.setup_device()
        self.wait(lambda: self.browser.get(self.origin + self.device_api + "/apps/installed", timeout=5).ok)
        with self.channel() as events:
            events.send(json.dumps({"type": "subscribe", "id": "apps", "deviceId": self.device, "topic": "applications.changed"}))
            self.receive(events, lambda value: value["type"] == "subscribed")

            def event(kind):
                return self.receive(events, lambda value: value["type"] == "event" and
                                    value["item"]["payload"]["kind"] == kind and
                                    value["item"]["payload"]["application"]["bundleId"] == identifier,
                                    seconds=20)["item"]["payload"]["application"]

            live = apps / staged.name
            staged.rename(live)
            installed = event("installed")
            self.assertEqual((installed["version"], installed["installPath"]), ("1.0", str(live)))
            (live / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info | {"CFBundleShortVersionString": "2.0"}))
            self.assertEqual(event("updated")["version"], "2.0")
            stop = self.work / "stop-fixture-app"
            self.addCleanup(stop.touch)
            subprocess.run(["codesign", "--force", "--sign", "-", str(live)], check=True, capture_output=True, timeout=20)
            subprocess.run(["open", "-gj", str(live), "--args", str(stop)], check=True, capture_output=True, timeout=20)
            launched = event("launched")
            self.assertGreater(launched["pid"], 0)
            pid = launched["pid"]

            def running():
                return next((item for item in self.api("GET", self.device_api + "/apps/running").json()["value"]
                             if item["pid"] == pid), None)

            current = self.wait(running)
            icon = self.api("GET", self.device_api + "/apps/icon", params={"applicationId": current["applicationId"]})
            self.assertEqual(current["iconHash"], hashlib.sha256(icon.content).hexdigest().upper())
            self.assertEqual(icon.headers["ETag"].strip('"'), current["iconHash"])
            stop.touch()
            self.assertEqual(event("terminated")["pid"], pid)
            self.wait(lambda: running() is None)
            live.rename(staged)
            self.assertEqual(event("removed")["applicationId"], installed["applicationId"])

    def test_dialog_response_notification_and_session_cancellation(self):
        self.register()
        self.unlock()
        for transport in ("wss", "https"):
            with self.subTest(transport=transport):
                device = str(uuid.uuid4())
                hello = {"type": "hello", "deviceId": device, "name": "Interaction fixture"}
                if transport == "wss":
                    agent = connect(self.origin.replace("http:", "ws:") + "/agent/v1/ws", proxy=None, open_timeout=6)
                    self.addCleanup(agent.close)
                    agent.send(json.dumps(hello))
                    self.receive(agent, lambda value: value["type"] == "ready")

                    def next_message():
                        return self.receive(agent, lambda value: value["type"] in ("command", "cancel"))

                    def reply(frame):
                        agent.send(json.dumps(frame))
                else:
                    channel = self.api("POST", "/agent/v1/connect", json=hello).json()
                    header = {"X-FileSharing-Channel": channel["channel"]}

                    def next_message():
                        message, = self.api("GET", "/agent/v1/commands", headers=header).json()
                        return message

                    def reply(frame):
                        self.api("POST", "/agent/v1/frames", 204, headers=header, json={"frames": [frame]})

                route = f"{API}/devices/{device}"
                dialogs = route + "/interactions/dialogs"
                notifications = route + "/interactions/notifications"
                request = {"title": "Restart review", "message": "Provide a reason.", "icon": "warning",
                           "choices": [{"id": "submit", "label": "Submit"}], "askText": True,
                           "textRequired": True, "timeoutSeconds": 30}
                stamp = "2026-11-20T03:00:00Z"
                self.api("POST", dialogs, 403, json=request)
                presence = self.api("GET", route).json()["connection"]
                self.api("PUT", route + "/connection-access", json={"connectionId": presence["connectionId"], "enabled": True})
                self.api("POST", dialogs, 400, json=request | {"icon": "file:///tmp/icon"})
                with self.channel() as events:
                    events.send(json.dumps({"type": "subscribe", "id": "jobs", "deviceId": device, "topic": "jobs.changed"}))
                    self.receive(events, lambda value: value["type"] == "subscribed")
                    job = self.api("POST", dialogs, 202, json=request).json()
                    command = next_message()
                    self.assertEqual((command["kind"], command["id"], command["payload"]),
                                     ("interaction.dialog", job["id"], request))
                    answer = {"outcome": "submitted", "choiceId": "submit", "text": "Approved maintenance", "respondedAt": stamp}
                    reply({"type": "result", "id": command["id"], "ok": True, "payload": answer})
                    event = self.receive(events, lambda value: value["type"] == "event")["item"]["payload"]
                    self.assertEqual(event, {"id": job["id"], "state": "completed", "kind": "interaction.dialog"})
                    result = self.finished_job(job)["result"]
                    self.assertEqual((result["choiceId"], result["text"]), ("submit", "Approved maintenance"))

                    masked = request | {"maskText": True}
                    self.api("POST", dialogs, 400, json=masked | {"askText": False, "textRequired": False})
                    job = self.api("POST", dialogs, 202, json=masked).json()
                    command = next_message()
                    self.assertEqual((command["kind"], command["id"], command["payload"]),
                                     ("interaction.dialog.masked", job["id"], masked))
                    code = "  00-APP-42  "
                    reply({"type": "result", "id": job["id"], "ok": True, "payload": answer | {"text": code}})
                    event = self.receive(events, lambda value: value["type"] == "event"
                                         and value["item"]["payload"]["id"] == job["id"])["item"]["payload"]
                    self.assertEqual(event, {"id": job["id"], "state": "completed", "kind": "interaction.dialog"})
                    self.assertEqual(self.finished_job(job)["result"]["text"], code)
                    self.api("GET", f"{API}/jobs/{job['id']}", 401, session=self.client())

                    text_fields = [
                        {"id": "reason", "hintText": "Reason", "defaultText": "Maintenance",
                         "required": True, "disabled": False, "maskText": False},
                        {"id": "reference", "hintText": "Request ID", "defaultText": "CHG-42",
                         "required": True, "disabled": True, "maskText": False},
                        {"id": "approval", "hintText": "Approval code", "defaultText": "",
                         "required": True, "disabled": False, "maskText": True},
                        {"id": "note", "hintText": None, "defaultText": "", "required": False, "disabled": False, "maskText": False},
                    ]
                    form = request | {"askText": False, "textRequired": False, "textFields": text_fields}
                    for invalid in (form | {"askText": True}, form | {"requireLocalAuthentication": True},
                                    form | {"textFields": []}, form | {"textFields": text_fields * 2},
                                    form | {"textFields": [text_fields[0], text_fields[0]]},
                                    form | {"textFields": [text_fields[0] | {"hintText": "x" * 121}]},
                                    form | {"textFields": [text_fields[0] | {"defaultText": "x\ny"}]}):
                        self.api("POST", dialogs, 400, json=invalid)
                    values = {"reason": "  Verified  ", "approval": code, "note": ""}
                    for returned, expected in ((values, "completed"),
                                               (values | {"reference": "CHG-42"}, "failed"),
                                               (values | {"reason": "  "}, "failed"),
                                               ({"reason": "Verified", "approval": code}, "failed"),
                                               (values | {"approval": None}, "failed"),
                                               (values | {"approval": 42}, "failed")):
                        job = self.api("POST", dialogs, 202, json=form).json()
                        command = next_message()
                        self.assertEqual((command["kind"], command["id"], command["payload"]),
                                         ("interaction.dialog.form", job["id"], form))
                        reply({"type": "result", "id": job["id"], "ok": True,
                               "payload": answer | {"text": None, "textValues": returned}})
                        event = self.receive(events, lambda value: value["type"] == "event"
                                             and value["item"]["payload"]["id"] == job["id"])["item"]["payload"]
                        self.assertEqual(event, {"id": job["id"], "state": expected, "kind": "interaction.dialog"})
                        finished = self.finished_job(job)
                        if expected == "completed":
                            self.assertEqual(finished["result"]["textValues"], values)
                            self.assertIsNone(finished["result"]["text"])
                            archive = self.api("GET", dialogs + "/" + job["id"]).json()
                            self.assertEqual(archive["result"], finished["result"])
                            self.assertEqual(archive["request"]["textFields"][2], {
                                "id": "approval", "hintText": "Approval code", "required": True, "disabled": False, "maskText": True,
                            })
                        else:
                            self.assertEqual((finished["error"], finished["result"]), ("invalid_dialog_result", None))
                            self.api("GET", dialogs + "/" + job["id"], 404)

                protected = {key: value for key, value in request.items() if key not in ("icon", "askText", "textRequired")}
                protected["requireLocalAuthentication"] = True
                self.api("POST", dialogs, 400, json=protected | {"askText": True})
                expected = {"outcome": "submitted", "choiceId": "submit", "text": None, "respondedAt": stamp}
                for extra, wanted in (({}, "failed"), ({"locallyAuthenticated": True, "password": "fixture"}, "failed"),
                                      ({"locallyAuthenticated": True}, "completed")):
                    job = self.api("POST", dialogs, 202, json=protected).json()
                    command = next_message()
                    self.assertTrue(command["payload"]["requireLocalAuthentication"])
                    reply({"type": "result", "id": command["id"], "ok": True, "payload": expected | extra})
                    finished = self.finished_job(job)
                    self.assertEqual(finished["state"], wanted)
                    if wanted == "completed":
                        self.assertEqual(finished["result"], expected | {
                            "locallyAuthenticated": True, "respondedAt": stamp.replace("Z", "+00:00")
                        })
                    else:
                        self.assertEqual((finished["error"], finished["result"]), ("invalid_dialog_result", None))

                notification = self.api("POST", notifications, 202, json={"title": "Maintenance", "message": "Starts at 18:00."}).json()
                command = next_message()
                self.assertEqual((command["kind"], command["id"]), ("interaction.notification", notification["id"]))
                reply({"type": "result", "id": command["id"], "ok": True,
                       "payload": {"status": "scheduled", "scheduledAt": stamp}})
                self.assertEqual(self.finished_job(notification)["result"]["status"], "scheduled")
                pending = self.api("POST", dialogs, 202, json=request).json()
                self.assertEqual(next_message()["id"], pending["id"])
                self.api("POST", API + "/auth/lock", 204)
                cancel = next_message()
                self.assertEqual((cancel["type"], cancel["id"]), ("cancel", pending["id"]))
                self.unlock()
                completed = self.finished_job(pending)
                self.assertEqual((completed["state"], completed["error"], completed["result"]),
                                 ("cancelled", "review_ended", None))

    def test_dialog_helper_crash_and_timeout_preserve_connection(self):
        helper = self.work / "dialog-helper"
        pid_path = self.work / "dialog-helper.pid"
        helper.write_text("""#!/usr/bin/env python3
import json, os, signal, sys, time
from pathlib import Path
from datetime import datetime, timezone

request = json.load(sys.stdin)
if request["title"] == "Crash fixture":
    os._exit(3)
if request["title"] == "Timeout fixture":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    Path(os.environ["FILESHARING_TEST_HELPER_PID"]).write_text(str(os.getpid()))
    time.sleep(60)
result = {"outcome": "submitted", "choiceId": "yes", "text": "00-APP-42" if request.get("maskText") else None,
          "respondedAt": datetime.now(timezone.utc).isoformat()}
if "textFields" in request:
    result["textValues"] = {field["id"]: field["defaultText"] for field in request["textFields"] if not field["disabled"]}
print(json.dumps({"payload": result}, ensure_ascii=False))
""")
        helper.chmod(0o700)
        self.env["FILESHARING_TEST_DIALOG_HELPER"] = str(helper)
        self.env["FILESHARING_TEST_HELPER_PID"] = str(pid_path)
        device = self.setup_device()
        connection_id = device["connection"]["connectionId"]
        route = self.device_api + "/interactions/dialogs"

        def submit(title, **fields):
            request = {"title": title, "message": "Local test", "timeoutSeconds": 10,
                       "choices": [{"id": "yes", "label": "Accept"}]}
            return self.api("POST", route, 202, json=request | fields).json()

        failed = self.finished_job(submit("Crash fixture"))
        self.assertEqual((failed["state"], failed["error"]), ("failed", "dialog_presentation_failed"))
        job = submit("Timeout fixture")
        child_pid = int(self.wait(lambda: pid_path.read_text() if pid_path.exists() else None))
        current = self.api("GET", self.device_api).json()["connection"]
        stamp = current["lastCommunicationAt"]

        def heartbeat():
            reading = self.api("GET", self.device_api).json()["connection"]
            self.assertEqual(reading["connectionId"], connection_id)
            return reading["lastCommunicationAt"] > stamp

        self.wait(heartbeat, seconds=9)
        expired = self.finished_job(job)
        self.assertEqual((expired["state"], expired["result"]["outcome"]), ("completed", "expired"))
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)
        completed = self.finished_job(submit("Reply fixture", askText=True, textRequired=True, maskText=True))
        self.assertEqual((completed["result"]["choiceId"], completed["result"]["text"]), ("yes", "00-APP-42"))
        text_fields = [{"id": f"field-{index}", "defaultText": "测" * 1024, "required": True}
                       for index in range(6)]
        large = self.finished_job(submit("Large form fixture", textFields=text_fields))
        self.assertEqual(large["state"], "completed")
        self.assertEqual(large["result"]["textValues"], {field["id"]: field["defaultText"] for field in text_fields})
        self.assertEqual(self.api("GET", self.device_api).json()["connection"]["connectionId"], connection_id)

    def test_diagnostic_outputs_stream_and_resume_on_wss_and_https(self):
        self.setup_device()
        for protocol in ("wss", "https"):
            if protocol == "https":
                self.stop(self.agent)
                self.stop(self.server)
                self.start_server(polling=True)
                self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)
                def connected():
                    result = self.api("GET", self.device_api).json()["connection"]
                    return result if result["protocol"] == protocol else None
                self.set_access(self.wait(connected)["connectionId"], True)
            self.api("POST", self.device_api + "/diagnostics", 400, json={"kind": "sw_vers -productVersion"})
            for invalid in (None, "uname -m | uname -r", "/usr/bin/uname", "df /", "sysctl -a", "pmset sleepnow"):
                response = self.api("POST", self.device_api + "/diagnostics", 400, json={"kind": "custom", "command": invalid})
                self.assertEqual(response.json()["code"], "invalid_diagnostic_command")
            with self.channel() as ws:
                ws.send(json.dumps({"type": "subscribe", "id": "output", "deviceId": self.device, "topic": "jobs.output"}))
                self.receive(ws, lambda value: value["type"] == "subscribed")
                ws.send(json.dumps({"type": "subscribe", "id": "finished", "deviceId": self.device, "topic": "jobs.changed"}))
                self.receive(ws, lambda value: value["type"] == "subscribed" and value["id"] == "finished")
                for body in ({"kind": "osVersion"}, {"kind": "custom", "command": "sw_vers -productVersion"}):
                    job = self.api("POST", self.device_api + "/diagnostics", 202, json=body).json()
                    item = self.receive(ws, lambda value: value["type"] == "event" and value["id"] == "output"
                                        and value["item"]["payload"]["jobId"] == job["id"])["item"]["payload"]
                    self.assertEqual((item["index"], item["stream"]), (1, "stdout"))
                    terminal = self.receive(ws, lambda value: value["type"] == "event" and value["id"] == "finished"
                                            and value["item"]["payload"]["id"] == job["id"])["item"]["payload"]
                    self.assertEqual((terminal["state"], terminal["exitCode"]), ("completed", 0))
                    finished = self.finished_job(job)
                    self.assertEqual((finished["state"], finished["result"]["exitCode"]), ("completed", 0))
                    self.assertFalse(finished["result"]["timedOut"])
                    output = f"{API}/jobs/{job['id']}/output"
                    page = self.api("GET", output).json()
                    joined = b"".join(base64.b64decode(part["data"]) for part in page["items"] if part["stream"] == "stdout")
                    self.assertEqual(joined.decode(), finished["result"]["stdout"])
                    if body["kind"] == "custom":
                        self.assertEqual(joined, subprocess.check_output(["/usr/bin/sw_vers", "-productVersion"]))
                        self.assertEqual(finished["result"]["stderr"], "")
                    else:
                        self.assertIn(b"ProductVersion:", joined)
                    self.assertEqual(self.api("GET", output, params={"after": page["cursor"]}).json(),
                                     {"items": [], "cursor": page["cursor"]})
                    self.api("GET", output, 401, session=self.client())

    def test_terminal_session_keeps_native_cwd_and_streams_on_wss_and_https(self):
        self.setup_device()
        folder = self.home / "Project Files"
        folder.mkdir()
        (self.home / "Local Link").symlink_to(folder, target_is_directory=True)
        base = self.device_api + "/diagnostics/sessions"
        identity = f"{pwd.getpwuid(os.getuid()).pw_name}@{socket.gethostname().split('.', 1)[0]}"
        home_prompt = f"{identity} ~ %"
        folder_prompt = f"{identity} {folder.name} %"

        for protocol in ("wss", "https"):
            with self.subTest(protocol=protocol):
                prompt = home_prompt
                if protocol == "https":
                    self.stop(self.agent)
                    self.stop(self.server)
                    self.start_server(polling=True)
                    self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)

                    def connected():
                        result = self.api("GET", self.device_api).json()["connection"]
                        return result if result["protocol"] == protocol else None

                    self.set_access(self.wait(connected)["connectionId"], True)

                view = self.api("POST", base, 201, json={}).json()
                self.assertEqual(view["rootId"], self.root_id)
                path = f"{base}/{view['id']}"
                output_path = path + "/output"
                self.api("POST", base, 409, json={"rootId": self.root_id})
                self.api("GET", output_path, 401, session=self.client())
                other = self.client()
                self.unlock(session=other)
                self.assertEqual(self.api("GET", output_path, 404, session=other).json()["code"], "terminal_not_found")
                for line in ("uname -m | uname -n", "sysctl -a", "cd `date`"):
                    self.api("POST", path + "/commands", 400, json={"line": line})

                def submit(line):
                    return self.api("POST", path + "/commands", 202, json={"line": line}).json()["commandId"]

                def assert_result(pages, command_id, expected_text=None, status=0, next_prompt=None):
                    nonlocal prompt
                    selected = [item for item in pages if item["commandId"] == command_id]
                    self.assertEqual((selected[0]["kind"], selected[0]["prompt"]), ("command", prompt))
                    prompt = next_prompt or prompt
                    self.assertEqual((selected[-1]["kind"], selected[-1]["exitCode"]), ("exit", status))
                    self.assertEqual(selected[-1]["prompt"], prompt)
                    if expected_text is not None:
                        joined = b"".join(base64.b64decode(item["data"]) for item in selected if item["kind"] == "output")
                        self.assertTrue(joined.endswith(b"\r\n"), "Output should come from the macOS PTY")
                        self.assertEqual(joined.decode().strip(), expected_text)
                    return selected[-1]["index"]

                cookie = "; ".join(f"{entry.name}={entry.value}" for entry in self.browser.cookies)
                with connect(self.origin.replace("http:", "ws:") + path + "/ws", origin=self.origin,
                             additional_headers={"Cookie": cookie}, proxy=None, open_timeout=6) as channel:
                    ready = json.loads(channel.recv(timeout=6))
                    self.assertEqual([(item["kind"], item["prompt"]) for item in ready["items"]], [("ready", home_prompt)])
                    command_id = submit("pwd")
                    frames = []
                    while not any(item["kind"] == "exit" for item in frames):
                        page = json.loads(channel.recv(timeout=6))
                        frames.extend(page["items"])
                    cursor = assert_result(frames, command_id, str(self.home.resolve()))

                def run(line, expected_text=None, status=0, next_prompt=None):
                    nonlocal cursor
                    command_id = submit(line)

                    def complete():
                        items = self.api("GET", output_path, params={"after": cursor}).json()["items"]
                        return items if any(item["kind"] == "exit" for item in items) else None

                    items = self.wait(complete)
                    self.assertEqual(items[0]["index"], cursor + 1)
                    cursor = assert_result(items, command_id, expected_text, status, next_prompt)

                run('cd "Project Files"', next_prompt=folder_prompt)
                run("pwd", str(folder.resolve()))
                run("uname -m", subprocess.check_output(["/usr/bin/uname", "-m"], text=True).strip())
                run('cd "/Local Link"', status=1)
                run("pwd", str(folder.resolve()))
                run("cd ..", next_prompt=home_prompt)
                run("cd ..", status=1)
                run("pwd", str(self.home.resolve()))
                self.api("DELETE", path, 204)
                closed = self.api("GET", output_path, params={"after": cursor}).json()
                self.assertTrue(closed["closed"])
                self.assertEqual([item["kind"] for item in closed["items"]], ["closed"])
                self.api("POST", path + "/commands", 409, json={"line": "pwd"})
                replacement = self.api("POST", base, 201, json={}).json()
                self.assertNotEqual(replacement["id"], view["id"])
                self.api("DELETE", f"{base}/{replacement['id']}", 204)

    def test_terminal_helper_enforces_the_allowlist_and_scope_independently(self):
        self.setup_device()
        key = json.loads((self.agent_state / "enrollment.json").read_text())["roots"][0]["rootKey"]
        master, slave = os.openpty()
        self.addCleanup(os.close, master)
        try:
            helper = subprocess.Popen([str(APP), "terminal-helper", key], env=self.env,
                                      stdin=subprocess.PIPE, stdout=slave, stderr=subprocess.PIPE)
        finally:
            os.close(slave)
        self.addCleanup(helper.stderr.close)
        self.addCleanup(helper.stdin.close)
        self.addCleanup(self.stop, helper)

        def frame():
            self.assertTrue(select.select([helper.stderr], [], [], 5)[0], "No response from terminal helper")
            return json.loads(helper.stderr.readline())

        initial = frame()
        self.assertEqual(initial["kind"], "ready")
        self.assertTrue(initial["prompt"].endswith(" ~ %"))
        for payload, code in (
            ({"kind": "run", "executable": "uname", "arguments": ["-invalid"]}, "invalid_diagnostic_command"),
            ({"kind": "run", "executable": "unknown-diagnostic", "arguments": []}, "invalid_diagnostic_command"),
            ({"kind": "cd", "path": ".."}, "invalid_path"),
        ):
            command_id = str(uuid.uuid4())
            helper.stdin.write(json.dumps(payload | {"commandId": command_id}).encode() + b"\n")
            helper.stdin.flush()
            self.assertEqual(frame(), {"kind": "exit", "commandId": command_id, "exitCode": 1,
                                       "code": code, "prompt": initial["prompt"]})
        helper.stdin.close()
        self.assertEqual(helper.wait(timeout=5), 0)

    def test_stderr_progress_precedes_exit_and_duplicate_is_ignored(self):
        self.register()
        self.unlock()
        device = str(uuid.uuid4())
        established = self.api("POST", "/agent/v1/connect", json={"deviceId": device, "name": "Diagnostic fixture"}).json()
        header = {"X-FileSharing-Channel": established["channel"]}
        presence = self.api("GET", f"{API}/devices/{device}").json()["connection"]
        self.api("PUT", f"{API}/devices/{device}/connection-access",
                 json={"connectionId": presence["connectionId"], "enabled": True})
        request = self.api("POST", f"{API}/devices/{device}/diagnostics", 202, json={"kind": "diskSpace"}).json()
        self.api("POST", f"{API}/devices/{device}/diagnostics", 429, json={"kind": "diskSpace"})
        command, = self.api("GET", "/agent/v1/commands", headers=header).json()
        self.assertEqual(command["id"], request["id"])
        path = f"{API}/jobs/{request['id']}"
        text = "Diagnostic fixture reported an error\n"
        stderr = {"index": 1, "stream": "stderr", "data": base64.b64encode(text.encode()).decode()}
        frame = {"type": "progress", "id": command["id"], "payload": stderr}
        self.api("POST", "/agent/v1/frames", 204, headers=header, json={"frames": [frame, frame]})
        self.assertEqual(self.api("GET", path).json()["state"], "queued")
        self.assertEqual(self.api("GET", path + "/output").json(), {"items": [stderr], "cursor": 1})
        self.api("POST", "/agent/v1/frames", 204, headers=header, json={"frames": [
            {"type": "result", "id": command["id"], "ok": True,
             "payload": {"stdout": "", "stderr": text, "exitCode": 2, "data": None}},
        ]})
        self.assertEqual(self.finished_job(request)["result"]["exitCode"], 2)

    def test_clipboard_timestamp_lid_and_heartbeat_over_both_transports(self):
        self.env["FILESHARING_TEST_PASTEBOARD_NAME"] = "FileSharing.Test." + uuid.uuid4().hex
        lid = self.work / "lid"
        lid.write_text("open")
        self.env["FILESHARING_TEST_LID"] = str(lid)
        self.setup_device()

        for protocol in ("wss", "https"):
            if protocol == "https":
                self.stop(self.agent)
                self.stop(self.server)
                self.start_server(polling=True)
                self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)
            start = self.wait(lambda: self.api("GET", self.device_api + "/status").json()
                              if self.api("GET", self.device_api).json()["connection"]["protocol"] == protocol else None)
            expected_lid = protocol == "wss"
            self.wait(lambda: any(snapshot["topic"] == "lid" and snapshot["value"]["lidClosed"] is not expected_lid
                                  for snapshot in self.api("GET", self.device_api + "/status").json()["samples"]))
            with self.channel() as ws:
                ready = self.receive(ws, lambda value: value["type"] == "ready")
                for topic in ("clipboard.changed", "lid.changed", "connection.quality"):
                    ws.send(json.dumps({"type": "subscribe", "id": topic, "deviceId": self.device,
                                        "topic": topic, "after": ready["cursor"]}))
                    self.receive(ws, lambda value: value["type"] == "subscribed" and value["id"] == topic)
                subprocess.run(["swift", "-", self.env["FILESHARING_TEST_PASTEBOARD_NAME"]], input="""
import AppKit
let board = NSPasteboard(name: .init(CommandLine.arguments[1]))
board.clearContents()
precondition(board.setString("ISOLATED_CLIPBOARD_CONTENT", forType: .string))
""", text=True, check=True, timeout=35)
                lid.write_text("closed" if expected_lid else "open")
                events = {}
                while len(events) < 3:
                    item = self.receive(ws, lambda value: value["type"] == "event" and value["id"] not in events)["item"]
                    events[item["topic"]] = item
                clipboard_event = events["clipboard.changed"]
                self.assertEqual(set(clipboard_event["payload"]), {"occurredAt"})
                self.assertEqual(events["lid.changed"]["payload"]["lidClosed"], expected_lid)
                quality = events["connection.quality"]["payload"]
                self.assertTrue(quality["online"])
                self.assertEqual(quality["connectionId"], start["connection"]["connectionId"])
                self.assertEqual(quality["protocol"], protocol)
                self.assertGreaterEqual(quality["latencyMs"], 0)
                replay = self.api("GET", self.device_api + "/history",
                                  params={"topic": "clipboard.changed", "after": ready["cursor"]}).json()
                self.assertEqual(replay["items"], [clipboard_event])
                self.assertNotIn("ISOLATED_CLIPBOARD_CONTENT", json.dumps(replay))
                record = self.api("GET", self.device_api + "/clipboard/records/" + clipboard_event["sequence"]).json()
                self.assertEqual(record["occurredAt"], clipboard_event["payload"]["occurredAt"])
                self.assertEqual((record["event"], record["content"]), ("clipboard.changed", "N/A"))
                self.assertNotIn("ISOLATED_CLIPBOARD_CONTENT", json.dumps(record))

        outsider = self.client()
        registered = self.api("POST", "/agent/v1/connect", session=outsider,
                              json={"deviceId": str(uuid.uuid4()), "name": "Privacy fixture"}).json()
        frame = {"type": "event", "id": str(uuid.uuid4()), "topic": "clipboard.changed", "snapshot": False,
                 "payload": {"occurredAt": clipboard_event["payload"]["occurredAt"], "contents": "SYNTHETIC"}}
        reply = self.api("POST", "/agent/v1/frames", 400, outsider, json={"frames": [frame]},
                         headers={"X-FileSharing-Channel": registered["channel"]})
        self.assertEqual(reply.json()["code"], "invalid_clipboard_event")
        self.assertEqual(self.api("GET", API + "/events",
                                  params={"deviceId": registered["deviceId"], "topic": "clipboard.changed"}).json()["items"], [])

    def test_durable_interaction_records_keep_details_after_cleanup_and_relogin(self):
        self.register()
        self.unlock()
        device = str(uuid.uuid4())
        hello = {"deviceId": device, "name": "History fixture"}
        agent = self.api("POST", "/agent/v1/connect", json=hello).json()
        header = {"X-FileSharing-Channel": agent["channel"]}
        route = API + "/devices/" + device
        clipboard = route + "/clipboard/records"
        dialogs = route + "/interactions/dialogs"
        opaque = "  sealed/+/Q=\n密文样例  "
        first = {"type": "event", "id": str(uuid.uuid4()), "topic": "clipboard.changed", "snapshot": False,
                 "payload": {"occurredAt": "2026-11-20T10:30:00.123+02:00", "content": "N/A"}}
        second = first | {"id": str(uuid.uuid4()),
                          "payload": {"occurredAt": "2026-11-20T08:31:00+00:00", "content": opaque}}
        legacy = first | {"id": str(uuid.uuid4()), "payload": {"occurredAt": "2026-11-20T08:29:00+00:00"}}

        def send(*frames, expected=204):
            return self.api("POST", "/agent/v1/frames", expected, headers=header, json={"frames": frames})

        send(legacy, first, first, second)
        invalid = first | {"id": str(uuid.uuid4()), "payload": first["payload"] | {"content": {"value": opaque}}}
        self.assertEqual(send(invalid, expected=400).json()["code"], "invalid_clipboard_event")
        newest = self.api("GET", clipboard, params={"limit": 1}).json()
        oldest = self.api("GET", clipboard, params={"limit": 2, "cursor": newest["nextCursor"]}).json()
        latest, = newest["items"]
        earlier, old_agent = oldest["items"]
        self.assertEqual([item["occurredAt"] for item in (latest, earlier, old_agent)], [
            "2026-11-20T08:31:00+00:00", "2026-11-20T08:30:00.123+00:00", "2026-11-20T08:29:00+00:00"])
        self.assertIsNone(oldest["nextCursor"])
        self.assertEqual([(item["event"], item["content"]) for item in (latest, earlier, old_agent)],
                         [("clipboard.changed", value) for value in (opaque, "N/A", None)])
        self.assertEqual(self.api("GET", clipboard + "/" + latest["id"]).json(), latest)
        self.assertEqual(self.api("GET", clipboard + "/" + old_agent["id"]).json(), old_agent)
        live = self.api("GET", route + "/history", params={"topic": "clipboard.changed"}).json()["items"]
        self.assertEqual([item["payload"] for item in live],
                         [{"occurredAt": item["occurredAt"]} for item in (old_agent, earlier, latest)])
        self.api("GET", clipboard + "/" + earlier["id"], 401, self.client())

        connection = self.api("GET", route).json()["connection"]
        self.api("PUT", route + "/connection-access", json={"connectionId": connection["connectionId"], "enabled": True})
        form = {"title": "Archived confirmation", "message": "Provide an approval code.",
                "choices": [{"id": "yes", "label": "Confirm"}],
                "textFields": [{"id": "approval", "hintText": "Approval code", "defaultText": "preset",
                                "required": True, "maskText": True}]}
        reply = {"outcome": "submitted", "choiceId": "yes", "text": None,
                 "respondedAt": "2026-11-20T08:30:00+00:00", "textValues": {"approval": "  00-APP-42  "}}
        job = self.api("POST", dialogs, 202, json=form).json()
        command, = self.api("GET", "/agent/v1/commands", headers=header).json()
        self.assertEqual(command["kind"], "interaction.dialog.form")
        send({"type": "result", "id": job["id"], "ok": True, "payload": reply})
        self.assertEqual(self.finished_job(job)["result"], reply)
        archive = self.api("GET", dialogs + "/" + job["id"]).json()
        self.assertEqual(archive["result"], reply)
        self.assertEqual(archive["request"]["textFields"], [
            {"id": "approval", "hintText": "Approval code", "disabled": False, "required": True, "maskText": True}])
        self.assertEqual(self.api("GET", dialogs).json()["items"], [archive["record"]])
        self.assertNotIn("00-APP-42", json.dumps(archive["record"]))
        self.api("GET", dialogs + "/" + job["id"], 401, self.client())
        other = str(uuid.uuid4())
        self.api("POST", "/agent/v1/connect", json={"deviceId": other, "name": "Other device"})
        self.api("GET", f"{API}/devices/{other}/interactions/dialogs/{job['id']}", 404)
        self.api("GET", f"{API}/devices/{other}/clipboard/records/{earlier['id']}", 404)

        self.api("POST", API + "/auth/lock", 204)
        self.api("GET", dialogs, 401)
        self.api("GET", clipboard, 401)
        self.stop(self.server)
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as db, db:
            persisted = db.execute("SELECT Content FROM ClipboardRecords WHERE DeviceId=? ORDER BY Sequence DESC", (device,))
            self.assertEqual(persisted.fetchall(), [(opaque,), ("N/A",), (None,)])
            db.execute("UPDATE Events SET At=1 WHERE DeviceId=? AND Topic='clipboard.changed'", (device,))
            db.execute("UPDATE Jobs SET Created=1 WHERE Id=?", (job["id"],))
            db.execute("UPDATE AgentReceipts SET At=1 WHERE DeviceId=?", (device,))
        self.start_server()
        self.unlock()
        self.wait(lambda: self.browser.get(self.origin + API + "/jobs/" + job["id"], timeout=5).status_code == 404)
        self.assertFalse(self.api("GET", route).json()["connection"]["online"])
        self.assertEqual(self.api("GET", route + "/history", params={"topic": "clipboard.changed"}).json()["items"], [])
        self.assertEqual(self.api("GET", dialogs + "/" + job["id"]).json(), archive)
        self.assertEqual(self.api("GET", clipboard).json()["items"], [latest, earlier, old_agent])

        agent = self.api("POST", "/agent/v1/connect", json=hello).json()
        header = {"X-FileSharing-Channel": agent["channel"]}
        send(first)
        self.assertEqual(self.api("GET", clipboard).json()["items"], [latest, earlier, old_agent])
        self.assertEqual(self.api("GET", route + "/history", params={"topic": "clipboard.changed"}).json()["items"], [])

    def test_folder_permission_enables_scoped_writes_and_library_reads(self):
        self.env["FILESHARING_TEST_HOME_WRITE"] = "NO"
        for folder in ("Downloads", "Documents", "Library/Preferences", "Library/Keychains",
                       "Library/Application Support/FileSharingServiceDemo"):
            (self.home / folder).mkdir(parents=True)
        os.chflags(self.home / "Library", stat.UF_HIDDEN)
        library_file = "Library/Preferences/fixture.txt"
        (self.home / library_file).write_bytes(b"Library fixture")
        self.setup_device()
        self.api("POST", self.files_api + "/directories", 403,
                 json={"rootId": self.root_id, "path": "Library/blocked"})

        def restart_agent():
            previous = self.api("GET", self.device_api).json()["connection"]
            self.stop(self.agent)
            if previous["protocol"] == "https":
                # A terminated polling client leaves its lease until it expires.
                self.stop(self.server)
                self.start_server(polling=True)
            self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)

            def reconnected():
                link = self.api("GET", self.device_api).json()["connection"]
                return link if link["online"] and link["connectionId"] != previous["connectionId"] else None

            self.set_access(self.wait(reconnected)["connectionId"], True)

        grants = self.device_api + "/file-roots"
        self.wait(lambda: any(root["primary"] and not root["writable"]
                              for root in self.api("GET", grants + "/local").json()))

        def mkdir(path, expected=201):
            return self.api("POST", self.files_api + "/directories", expected, json={"rootId": self.root_id, "path": path})

        self.assertEqual(mkdir("Downloads/fixture", 403).json()["code"], "root_access_denied")
        self.assertIn("Library", [entry["name"] for entry in self.api("GET", self.files_api + "/entries",
                      params=self.params()).json()["items"]])
        self.entry("Library/Keychains", 403)
        self.entry("Library/Application Support/FileSharingServiceDemo", 403)
        source = self.transfer("download", library_file)
        self.assertEqual(self.api("GET", source["downloadUrl"]).content, b"Library fixture")

        job = self.api("POST", self.device_api + "/permissions/requests", 202, json={"kind": "downloads"}).json()
        permission = self.finished_job(job)["result"]["result"]
        self.assertEqual((permission["state"], permission["writable"]), ("allowed", True))
        mkdir("Downloads/fixture")
        mkdir("downloads/other-spelling", 403)
        mkdir("Documents/blocked", 403)
        mkdir("Library/blocked", 403)
        payload = b"Uploaded after one folder permission request"
        upload = self.transfer("upload", "Downloads/source.txt", length=len(payload))
        route = API + "/transfers/" + upload["id"]
        self.api("PUT", route + "/content", 204, data=payload,
                 headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"})
        written = self.api("POST", route + "/commit").json()
        renamed = self.api("POST", self.files_api + "/renames", json={"rootId": self.root_id, "path": written["path"],
                           "newName": "renamed.txt", "version": written["version"]}).json()
        move = {"rootId": self.root_id, "path": renamed["path"], "version": renamed["version"]}
        for denied in ("Library/renamed.txt", "Documents/renamed.txt", "renamed.txt"):
            self.api("POST", self.files_api + "/moves", 403, json=move | {"destination": denied})
        self.api("POST", self.files_api + "/moves", json=move | {"destination": "Downloads/fixture/renamed.txt"})
        self.assertEqual((self.home / "Downloads/fixture/renamed.txt").read_bytes(), payload)
        self.assertFalse(self.api("GET", grants + "/" + self.root_id).json()["writable"])
        self.stop(self.agent)
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data, data:
            snapshot = json.loads(data.execute("SELECT Payload FROM Snapshots WHERE DeviceId=? AND Topic='permissions'",
                                               (self.device,)).fetchone()[0])
            snapshot["documents"].update(state="allowed", phase="completed", checkedAt=permission["checkedAt"])
            data.execute("UPDATE Snapshots SET Payload=? WHERE DeviceId=? AND Topic='permissions'",
                         (json.dumps(snapshot), self.device))
        restart_agent()
        self.wait(lambda: self.api("GET", self.device_api + "/permissions").json()["value"]["documents"].get("writable") is True)
        mkdir("Downloads/fixture/after-restart")
        mkdir("Documents/after-upgrade")
        mkdir("Library/still-read-only", 403)
        grant = grants + "/" + self.root_id
        current = self.api("GET", grant).json()
        self.api("PUT", grant, json={"rootKey": current["rootKey"], "label": current["label"],
                 "writable": False, "enabled": True, "revision": current["revision"]})
        self.assertEqual(mkdir("Downloads/explicitly-read-only", 403).json()["code"], "root_access_denied")

    def test_home_writes_follow_the_shared_path_permissions(self):
        for folder in ("Projects/Destination", "Downloads", "Library", "Applications"):
            (self.home / folder).mkdir(parents=True)
        locked = self.home / "Locked"
        locked.mkdir(mode=0o500)
        self.addCleanup(locked.chmod, 0o700)
        self.env["FILESHARING_TEST_HOME_WRITE"] = "NO"
        self.setup_device()
        grant_route = self.device_api + "/file-roots/" + self.root_id
        prior = self.api("GET", grant_route).json()
        self.assertFalse(prior["writable"])

        def mkdir(path, expected=201):
            return self.api("POST", self.files_api + "/directories", expected, json=self.params(path)).json()

        def reconnect(protocol):
            self.stop(self.agent)
            self.stop(self.server)
            self.start_server(polling=protocol == "https")
            self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)

            def connected():
                link = self.api("GET", self.device_api).json()["connection"]
                return link if link["online"] and link["protocol"] == protocol else None

            self.set_access(self.wait(connected)["connectionId"], True)
            self.wait(lambda: any(root["rootKey"] == prior["rootKey"] and root["writable"]
                                  for root in self.api("GET", self.device_api + "/file-roots/local").json()))

        self.assertEqual(mkdir("Projects/blocked-before-upgrade", 403)["code"], "root_access_denied")
        self.stop(self.agent)
        enrollment = self.agent_state / "enrollment.json"
        old_state = json.loads(enrollment.read_text())
        old_state["roots"][0].pop("followsHomePolicy")
        enrollment.write_text(json.dumps(old_state))
        del self.env["FILESHARING_TEST_HOME_WRITE"]

        for protocol in ("wss", "https"):
            with self.subTest(protocol=protocol):
                reconnect(protocol)
                self.wait(lambda: self.api("GET", grant_route).json()["writable"])
                upgraded = self.api("GET", grant_route).json()
                self.assertEqual((upgraded["id"], upgraded["rootKey"], upgraded["revision"]),
                                 (prior["id"], prior["rootKey"], prior["revision"] + 1))
                mkdir(f"Top-{protocol}")
                folder = f"Projects/Ordinary-{protocol}"
                mkdir(folder)
                payload = b"Writable ordinary directory fixture"
                upload = self.transfer("upload", folder + "/source.txt", length=len(payload))
                route = API + "/transfers/" + upload["id"]
                self.api("PUT", route + "/content", 204, data=payload,
                         headers={"Upload-Offset": "0", "Content-Type": "application/octet-stream"})
                written = self.api("POST", route + "/commit").json()
                renamed = self.api("POST", self.files_api + "/renames",
                                   json=self.params(written["path"], newName="renamed.txt", version=written["version"])).json()
                move = self.params(renamed["path"], version=renamed["version"])
                self.api("POST", self.files_api + "/moves", 403, json=move | {"destination": "Library/renamed.txt"})
                destination = f"Projects/Destination/{protocol}.txt"
                self.api("POST", self.files_api + "/moves", json=move | {"destination": destination})
                self.assertEqual((self.home / destination).read_bytes(), payload)
                self.assertEqual(mkdir("Locked/denied", 403)["code"], "filesystem_access_denied")
                self.assertEqual(mkdir("Applications/denied", 403)["code"], "root_access_denied")
                self.assertFalse((locked / "denied").exists())

        root = self.api("GET", grant_route).json()
        self.api("PUT", grant_route, json={"rootKey": root["rootKey"], "label": root["label"],
                 "writable": False, "enabled": True, "revision": root["revision"]})
        reconnect("wss")
        self.assertFalse(self.api("GET", grant_route).json()["writable"])
        self.assertEqual(mkdir("Projects/explicitly-read-only", 403)["code"], "root_access_denied")
        self.assertEqual(mkdir("Downloads/explicitly-read-only", 403)["code"], "root_access_denied")

    def test_window_geometry_focus_and_live_fallback(self):
        fixture = self.work / "windows.json"
        self.env["FILESHARING_TEST_WINDOW_STATE"] = str(fixture)

        def rect(x, y, width, height):
            return {"x": x, "y": y, "width": width, "height": height}

        displays = [{"id": 1, "main": True, "bounds": rect(0, 0, 500, 300)},
                    {"id": 2, "main": False, "bounds": rect(-400, 0, 400, 300)}]
        front = {"id": 21, "pid": 301, "bounds": rect(-20, 40, 60, 80), "title": "FIXTURE_PRIVATE_TITLE"}
        back = {"id": 22, "pid": 302, "bounds": rect(-50, 40, 100, 80)}
        translucent = {"id": 20, "pid": 303, "bounds": back["bounds"], "alpha": 0.4, "layer": 8}
        offscreen = {"id": 23, "pid": 304, "bounds": rect(-310, 10, 60, 60)}
        moved = back | {"bounds": rect(-350, 20, 70, 60)}
        covered = {"id": 24, "pid": 302, "bounds": moved["bounds"]}

        def sample(windows, visible, active):
            temp = fixture.with_suffix(".next")
            temp.write_text(json.dumps({"windows": windows, "onScreen": visible, "displays": displays,
                                        "activePid": active}))
            temp.replace(fixture)

        sample([translucent, front, back, offscreen], [20, 21, 22], 301)
        self.setup_device(allow_access=False)
        route = self.device_api + "/windows"
        self.api("GET", route, 401, self.client())
        self.api("GET", route, 403)
        self.api("GET", route, 400, params={"waitSeconds": -1})
        self.api("GET", route, 400, params={"after": "42"})
        subscription = {"type": "subscribe", "id": "layout", "deviceId": self.device, "topic": "windows.changed"}

        for protocol in ("wss", "https"):
            with self.subTest(protocol=protocol):
                if protocol == "https":
                    self.stop(self.agent)
                    self.stop(self.server)
                    self.start_server(polling=True)
                    sample([translucent, front, back, offscreen], [20, 21, 22], 301)
                    self.agent = self.spawn([str(APP), "run"], "agent.log", self.env)

                def connection():
                    value = self.api("GET", self.device_api).json()["connection"]
                    return value if value["protocol"] == protocol else None

                presence = self.wait(connection)
                with self.channel() as ws:
                    self.receive(ws, lambda frame: frame["type"] == "ready")
                    ws.send(json.dumps(subscription))
                    rejection = self.receive(ws, lambda frame: frame["type"] == "error")
                    self.assertEqual(rejection["code"], "agent_connection_access_required")
                    self.set_access(presence["connectionId"], True)
                    first = self.api("GET", route).json()
                    layout = first["value"]
                    self.assertTrue(layout["available"])
                    self.assertEqual(layout["displays"], displays)
                    self.assertEqual((layout["activePid"], layout["focusStatus"], layout["focusedWindowId"]), (301, "foreground", 21))
                    self.assertNotIn("FIXTURE_PRIVATE_TITLE", json.dumps(layout))
                    windows = {item["id"]: item for item in layout["windows"]}
                    self.assertEqual(list(windows), [20, 21, 22, 23])
                    self.assertTrue(windows[20]["frontmost"])
                    self.assertEqual((windows[20]["layer"], windows[20]["alpha"]), (8, 0.4))
                    self.assertTrue(windows[21]["focused"] and windows[21]["ownerFrontmost"])
                    self.assertEqual(windows[22]["zIndex"], 2)
                    self.assertEqual(windows[22]["relativeBounds"], back["bounds"])
                    self.assertEqual(windows[22]["occlusion"]["state"], "partial")
                    self.assertAlmostEqual(windows[22]["occlusion"]["coveredFraction"], 0.6)
                    self.assertEqual(windows[22]["occlusion"]["occludingWindowIds"], [21])
                    self.assertFalse(windows[23]["onScreen"])
                    self.assertIsNone(windows[23]["zIndex"])
                    self.assertEqual(windows[23]["occlusion"]["state"], "notDisplayed")

                    ws.send(json.dumps(subscription | {"after": first["revision"]}))
                    subscribed = self.receive(ws, lambda frame: frame["type"] == "subscribed")
                    self.assertEqual(subscribed["cursor"], first["revision"])
                    self.api("GET", route, 204, params={"after": first["revision"]})
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as reader:
                        pending = reader.submit(self.api, "GET", route, params={"after": first["revision"], "waitSeconds": 5})
                        sample([moved, front, covered, offscreen], [22, 21, 24], 302)
                        changed = self.receive(ws, lambda frame: frame["type"] == "event" and frame["id"] == "layout")["item"]
                        polled = pending.result(timeout=8).json()
                    self.assertEqual(changed["topic"], "windows.changed")
                    self.assertEqual(changed["sequence"], polled["revision"])
                    self.assertEqual(changed["payload"], polled)
                    self.assertNotEqual(polled["revision"], first["revision"])
                    layout = polled["value"]
                    self.assertEqual((layout["activePid"], layout["focusedWindowId"]), (302, 22))
                    windows = {item["id"]: item for item in layout["windows"]}
                    self.assertEqual(list(windows), [22, 21, 24, 23])
                    self.assertEqual(windows[22]["bounds"], moved["bounds"])
                    self.assertEqual((windows[22]["displayId"], windows[22]["relativeBounds"]), (2, rect(50, 20, 70, 60)))
                    self.assertTrue(windows[22]["frontmost"] and windows[22]["focused"])
                    self.assertTrue(windows[24]["ownerFrontmost"])
                    self.assertFalse(windows[24]["focused"])
                    self.assertEqual(windows[24]["occlusion"], {"state": "covered", "coveredFraction": 1, "occludingWindowIds": [22]})

                    sample([moved, front, covered, offscreen], [22, 21, 24], 301)
                    focus_only = self.receive(ws, lambda frame: frame["type"] == "event")["item"]["payload"]["value"]
                    self.assertEqual((focus_only["activePid"], focus_only["focusedWindowId"]), (301, 21))
                    self.assertTrue(focus_only["windows"][0]["frontmost"])
                    self.assertFalse(focus_only["windows"][0]["focused"])

                    sample([moved, front, covered, offscreen], [22, 21, 24], 304)
                    no_focus = self.receive(ws, lambda frame: frame["type"] == "event")["item"]["payload"]["value"]
                    self.assertEqual(no_focus["focusStatus"], "noFocusedWindow")
                    self.assertIsNone(no_focus["focusedWindowId"])
                    self.assertTrue(all(not item["focused"] for item in no_focus["windows"]))
                    self.set_access(presence["connectionId"], False)
                    revoked = self.receive(ws, lambda frame: frame["type"] == "error")
                    self.assertEqual(revoked["code"], "agent_connection_access_required")
                    self.api("GET", route, 403)

                with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as db:
                    counts = db.execute("""
                        SELECT COUNT(*) FROM Events WHERE Topic=?
                        UNION ALL
                        SELECT COUNT(*) FROM Snapshots WHERE Topic=?
                        """, ("windows.changed", "windows.changed")).fetchall()
                    self.assertEqual(counts, [(0,), (0,)])

    def test_permissions_per_device_policy_and_history(self):
        self.setup_device()
        for folder in ("Downloads", "Documents", "Desktop"):
            (self.home / folder).mkdir()

        def permission_matrix():
            response = self.browser.get(self.origin + self.device_api + "/permissions", timeout=5)
            return response.json()["value"] if response.ok else None

        initial = self.wait(permission_matrix)
        self.assertEqual(set(initial), {"downloads", "documents", "desktop", "inputMonitoring", "pasteboard"})
        self.assertEqual(initial["documents"]["state"], "notDetermined")
        self.api("POST", self.device_api + "/permissions/requests", 400, json={"kind": "fullDiskAccess"})
        for permission in ("documents", "inputMonitoring", "pasteboard"):
            job = self.api("POST", self.device_api + "/permissions/requests", 202, json={"kind": permission}).json()
            result = self.finished_job(job)
            expected = "allowed" if permission == "documents" else "requiresSystemSettings"
            self.assertEqual((result["state"], result["result"]["result"]["state"]), ("completed", expected))
        self.assertEqual(self.wait(permission_matrix)["documents"]["phase"], "completed")

        policy = self.api("GET", self.device_api + "/policy").json()
        self.assertTrue(policy["inherited"] and policy["settings"]["keepAwake"])
        revised = policy["settings"] | {"keepAwake": False, "cpu": 0, "memory": 5}
        changed = self.api("PUT", self.device_api + "/policy",
                           json={"revision": policy["revision"], "settings": revised}).json()
        self.assertFalse(changed["inherited"])
        self.api("PUT", self.device_api + "/policy", 409, json={"revision": policy["revision"], "settings": revised})
        self.api("PUT", self.device_api + "/policy", 400,
                 json={"revision": changed["revision"], "settings": revised | {"cpu": 2}})

        def power_policy_applied():
            samples = self.api("GET", self.device_api + "/status").json()["samples"]
            return next((row for row in samples if row["topic"] == "power" and row["value"]["configured"] is False), None)

        power = self.wait(power_policy_applied, seconds=19)
        self.assertEqual(power["value"]["closedLid"]["state"], "testIsolated")
        self.assertEqual(power["value"]["displayAndLockPolicy"], "managedByMacOS")
        refresh = self.api("POST", self.device_api + "/refresh", 202, json={"topics": ["cpu", "memory"]}).json()
        self.assertEqual(self.finished_job(refresh)["result"]["refreshed"], ["cpu", "memory"])
        event_page = self.api("GET", self.device_api + "/history", params={"topic": "cpu", "from": "2024-01-01T00:00:00Z"}).json()
        self.assertTrue(event_page["items"])
        self.api("GET", self.device_api + "/history", 400,
                 params={"from": "2032-01-01T00:00:00Z", "to": "2031-01-01T00:00:00Z"})
        job = self.api("POST", self.device_api + "/diagnostics", 202, json={"kind": "osVersion"}).json()
        self.assertEqual(self.finished_job(job)["result"]["exitCode"], 0)

    def finished_job(self, job):
        def complete():
            result = self.api("GET", API + "/jobs/" + job["id"]).json()
            return result if result["state"] != "queued" else None
        return self.wait(complete)

    def notification_fixture(self, polling=False):
        fixture = NotificationFixture()
        worker = threading.Thread(target=fixture.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(fixture.server_close)
        self.addCleanup(worker.join, 2)
        self.addCleanup(fixture.shutdown)
        self.env.update({
            "FileSharing__Notifications__CredentialKey": secrets.token_hex(32),
            "FileSharing__Notifications__BarkOrigins": fixture.origin,
            "FileSharing__Notifications__TestTelegramOrigin": fixture.origin,
        })
        self.stop(self.server)
        self.start_server(polling=polling)
        return fixture

    def wait_delivery(self, delivery, state="sent"):
        def reached():
            current = self.api("GET", f"{NOTIFICATIONS}/deliveries/{delivery['id']}").json()
            return current if current["state"] == state else None
        return self.wait(reached, seconds=20)

    def test_notification_destinations_and_durable_delivery(self):
        fixture = self.notification_fixture()
        telegram_token = "42:TelegramTestToken"
        bark_key = "FixtureBarkDeviceKey"
        self.api("GET", NOTIFICATIONS + "/channels", 401)
        self.register()
        self.unlock()
        telegram = {"name": "Operations", "kind": "telegram", "enabled": True,
                    "telegram": {"chatId": "-1001234567890", "botToken": telegram_token, "messageThreadId": 71, "silent": True}}
        bark = {"name": "Phone", "kind": "bark", "enabled": True,
                "bark": {"server": fixture.origin, "deviceKey": bark_key, "group": "file-sharing", "sound": "bell"}}
        self.assertEqual(self.api("POST", NOTIFICATIONS + "/channels", 400,
                                  json=bark | {"bark": bark["bark"] | {"server": "https://unapproved.invalid"}}).json()["code"],
                         "bark_origin_not_allowed")

        route = NOTIFICATIONS + "/channels"
        chat = self.api("POST", route, 201, json=telegram).json()
        phone = self.api("POST", route, 201, json=bark).json()
        self.assertNotIn(telegram_token, json.dumps(chat))
        self.assertNotIn(bark_key, json.dumps(phone))
        self.assertNotIn(bark_key, json.dumps(self.api("GET", route).json()))
        chat_route = f"{route}/{chat['id']}"
        phone_route = f"{route}/{phone['id']}"
        self.assertEqual(self.api("GET", chat_route).json(), chat)
        self.assertEqual(self.api("POST", chat_route + "/verify").json(),
                         {"botId": "42", "botUsername": "fixture_bot", "chatId": "-1001234567890", "chatType": "supergroup"})
        self.api("PUT", chat_route, 428, json=telegram)
        kept = {"name": "Ops", "kind": "telegram", "enabled": True, "revision": chat["revision"],
                "telegram": {"chatId": "-1001234567890", "messageThreadId": 71, "silent": True}}
        self.assertEqual(self.api("PUT", chat_route, json=kept).json()["revision"], 2)
        self.api("PUT", chat_route, 409, json=kept)
        self.api("POST", chat_route + "/test", 428, json={})

        send_path = f"/bot{telegram_token}/sendMessage"
        fixture.responses[send_path] = [(429, {"ok": False, "error_code": 429, "parameters": {"retry_after": 6}}, {})]
        with self.channel() as ws:
            self.receive(ws, lambda f: f["type"] == "ready")
            ws.send(json.dumps({"type": "subscribe", "id": "notify", "topic": "notifications.changed"}))
            self.receive(ws, lambda f: f["type"] == "subscribed")
            headers = {"Idempotency-Key": secrets.token_urlsafe(16)}
            message = {"title": "Bark & Telegram", "body": "<plain> 測試"}
            sent = self.api("POST", chat_route + "/test", 202, headers=headers, json=message).json()
            self.assertEqual(self.api("POST", chat_route + "/test", 202, headers=headers, json=message).json()["id"], sent["id"])
            self.api("POST", chat_route + "/test", 409, headers=headers, json=message | {"body": "different"})
            other = self.api("POST", phone_route + "/test", 202,
                             headers={"Idempotency-Key": secrets.token_urlsafe(16)}, json=message).json()
            self.assertEqual(self.wait_delivery(other)["attempts"], 1)
            retry_event = self.receive(ws, lambda f: f["type"] == "event" and f["item"]["payload"]["id"] == sent["id"]
                                       and f["item"]["payload"]["state"] == "retryScheduled")
            self.assertIsNone(retry_event["item"]["deviceId"])
            self.assertEqual(self.wait_delivery(sent, "retryScheduled")["httpStatus"], 429)

        self.stop(self.server)
        self.start_server()
        terminal = self.wait_delivery(sent)
        self.assertEqual((terminal["attempts"], terminal["providerId"], terminal["httpStatus"]), (2, "37", 200))
        with self.channel() as ws:
            self.receive(ws, lambda f: f["type"] == "ready")
            ws.send(json.dumps({"type": "subscribe", "id": "replay", "topic": "notifications.changed",
                                "after": retry_event["item"]["sequence"]}))
            self.receive(ws, lambda f: f["type"] == "event" and f["item"]["payload"]["id"] == sent["id"]
                         and f["item"]["payload"]["state"] == "sent")

        with fixture.guard:
            self.assertEqual([body for path, body in fixture.received if path == send_path], [{
                "chat_id": -1001234567890, "message_thread_id": 71, "text": "Bark & Telegram\n<plain> 測試",
                "disable_notification": True, "link_preview_options": {"is_disabled": True}
            }] * 2)
            self.assertIn(("/push", message | {"device_key": bark_key, "group": "file-sharing", "sound": "bell"}), fixture.received)
        page = self.api("GET", NOTIFICATIONS + "/deliveries", params={"channelId": chat["id"], "state": "sent"}).json()
        self.assertEqual([row["id"] for row in page["items"]], [sent["id"]])
        self.assertNotIn(telegram_token, json.dumps(self.api("GET", NOTIFICATIONS + "/updates").json()))
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data:
            for value, in data.execute("SELECT SecretCipher FROM NotificationChannels"):
                self.assertNotIn(telegram_token.encode(), base64.b64decode(value))
                self.assertNotIn(bark_key.encode(), base64.b64decode(value))
        self.api("DELETE", phone_route, 204, params={"revision": phone["revision"]})
        self.api("GET", phone_route, 404)
        self.assertEqual(self.api("GET", f"{NOTIFICATIONS}/deliveries/{other['id']}").json()["state"], "sent")
        self.assertNotIn(telegram_token, self.log_tail())

    def notification_channel(self, fixture, name="Ops"):
        return self.api("POST", NOTIFICATIONS + "/channels", 201,
                        json={"name": name, "enabled": True, "kind": "bark",
                              "bark": {"server": fixture.origin, "deviceKey": "FixtureDeviceKey"}}).json()

    def notification_event(self, topic, payload, snapshot=False, event_id=None):
        return {"type": "event", "id": event_id or str(uuid.uuid4()), "topic": topic, "snapshot": snapshot, "payload": payload}

    def send_agent_frames(self, connection, *frames):
        self.api("POST", "/agent/v1/frames", 204, headers={"X-FileSharing-Channel": connection["channel"]},
                 json={"frames": frames})

    def rule_deliveries(self, rule_id):
        return self.api("GET", NOTIFICATIONS + "/deliveries", params={"ruleId": rule_id}).json()["items"]

    def test_notification_rules_match_trusted_events_and_render_context(self):
        fixture = self.notification_fixture()
        self.register()
        self.unlock()
        hello = {"deviceId": str(uuid.uuid4()), "name": "Desk Mac", "notificationKey": secrets.token_urlsafe(32)}
        connection = self.api("POST", "/agent/v1/connect", json=hello).json()
        self.device_api = f"{API}/devices/{hello['deviceId']}"
        phone = self.notification_channel(fixture)
        second = self.notification_channel(fixture, "Support")
        kinds = self.api("GET", NOTIFICATIONS + "/event-types").json()
        self.assertIn("app.name", {var["name"] for entry in kinds["events"] if entry["type"] == "application.launched"
                                   for var in entry["variables"]})
        body = {"name": "Watch the Editor", "deviceId": hello["deviceId"], "enabled": True,
                "events": ["application.launched", "application.terminated"], "channelIds": [phone["id"], second["id"]],
                "filter": {"bundleId": "com.example.editor"}, "cooldownSeconds": 300,
                "template": {"title": "{{ device.name }}", "body": "{{app.name}} {{event.type}} ({{app.version}})"}}
        rules = NOTIFICATIONS + "/rules"
        self.api("POST", rules, 400, json=body | {"template": {"body": "{{app.secret}}"}})
        self.api("POST", rules, 400, json=body | {"filter": {"thresholdPercent": 55}})
        self.api("POST", rules, 400, json=body | {"events": ["application.launched", "application.launched"]})
        preview = self.api("POST", rules + "/preview", json={"event": "application.launched", "template": body["template"],
                           "context": {"device.name": "Preview", "app.name": "{{event.type}}"}}).json()
        self.assertEqual(preview, {"message": {"title": "Preview", "body": "{{event.type}} application.launched ()"},
                                   "missingVariables": ["app.version"]})
        rule_response = self.api("POST", rules, 201, json=body)
        rule = rule_response.json()
        route = rules + "/" + rule["id"]
        self.assertEqual(rule_response.headers["Location"], route)
        self.assertEqual(self.api("GET", rules, params={"deviceId": hello["deviceId"], "enabled": "true"}).json()["items"], [rule])

        def app(kind="launched", bundle="com.example.Editor"):
            return self.notification_event("applications.changed", {
                "kind": kind, "occurredAt": datetime.now(timezone.utc).isoformat(),
                "application": {"applicationId": "editor", "bundleId": bundle, "name": "Editor & 閱讀", "version": "3"}
            })

        self.send_agent_frames(connection, app())
        self.assertEqual(self.rule_deliveries(rule["id"]), [])
        current = self.api("GET", self.device_api).json()["connection"]
        self.set_access(current["connectionId"], True)
        first = app()
        self.send_agent_frames(connection, first, first | {"id": first["id"].upper()}, app(), app(bundle="other.application"),
                               app("terminated"))
        rows = self.rule_deliveries(rule["id"])
        self.assertEqual([x["event"] for x in rows], ["application.launched"] * 2 + ["application.terminated"] * 2)
        self.assertTrue(all(x["deviceId"] == hello["deviceId"] and x["sourceSequence"] for x in rows))
        self.assertEqual(rows[0]["message"], {"title": "Desk Mac", "body": "Editor & 閱讀 application.launched (3)"})
        self.assertEqual(rows[0]["context"]["app.bundleId"], "com.example.Editor")
        self.assertEqual({x["channelId"] for x in rows[:2]}, {phone["id"], second["id"]})
        state = self.api("GET", route).json()
        self.assertEqual((state["matchedEvents"], state["enqueuedDeliveries"], state["skippedDeliveries"]), (3, 4, 2))
        self.api("DELETE", f"{NOTIFICATIONS}/channels/{phone['id']}", 409, params={"revision": phone["revision"]})
        self.api("PUT", route, 409, json=body | {"revision": 2})
        updated = self.api("PUT", route, json=body | {"enabled": False, "revision": 1}).json()
        self.assertEqual(updated["revision"], 2)
        self.send_agent_frames(connection, app())
        self.assertEqual(len(self.rule_deliveries(rule["id"])), 4)
        self.api("DELETE", route, 204, params={"revision": 2})
        self.api("GET", route, 404)

        metric_rule = self.api("POST", rules, 201, json=body | {
            "events": ["battery.levelBelow", "battery.levelRecovered", "battery.chargingStarted", "system.sleeping", "lid.closed"],
            "template": {"body": "{{event.type}} {{metric.previousValue}} → {{battery.chargePercent}} ({{metric.thresholdPercent}})"},
            "filter": {"thresholdPercent": 25}, "cooldownSeconds": 0, "channelIds": [phone["id"]]
        }).json()
        for charge, charging in [(60, False), (24, False), (18, True), (25, True)]:
            self.send_agent_frames(connection, self.notification_event("battery", {
                "chargePercent": charge, "charging": charging, "externalPower": charging
            }, snapshot=True))
        stamp = datetime.now(timezone.utc).isoformat()
        self.send_agent_frames(connection, self.notification_event("system.changed", {"kind": "sleeping", "occurredAt": stamp}),
                               self.notification_event("lid.changed", {"lidClosed": True, "occurredAt": stamp}))
        signals = self.rule_deliveries(metric_rule["id"])
        self.assertEqual([x["event"] for x in signals],
                         ["battery.levelBelow", "battery.chargingStarted", "battery.levelRecovered", "system.sleeping", "lid.closed"])
        self.assertEqual(signals[0]["message"]["body"], "battery.levelBelow 60 → 24 (25)")
        self.assertEqual(signals[2]["context"]["metric.value"], "25")

    def test_notification_presence_requires_bound_agent_identity(self):
        fixture = self.notification_fixture()
        self.register()
        self.unlock()
        phone = self.notification_channel(fixture)
        hello = {"type": "hello", "deviceId": str(uuid.uuid4()), "name": "Trusted Mac", "notificationKey": secrets.token_urlsafe(32)}
        self.device_api = f"{API}/devices/{hello['deviceId']}"
        url = self.origin.replace("http:", "ws:") + "/agent/v1/ws"
        with connect(url, proxy=None, open_timeout=6) as agent:
            agent.send(json.dumps(hello))
            self.receive(agent, lambda f: f["type"] == "ready")
            rule = self.api("POST", NOTIFICATIONS + "/rules", 201,
                            json={"name": "Mac availability", "deviceId": hello["deviceId"], "enabled": True,
                                  "events": ["device.online", "device.offline", "lid.closed"], "channelIds": [phone["id"]],
                                  "template": {"body": "{{device.name}} {{event.type}} {{connection.protocol}}"}}).json()
            current = self.api("GET", self.device_api).json()["connection"]
            self.set_access(current["connectionId"], True)
            self.assertEqual(self.rule_deliveries(rule["id"]), [])
        self.wait(lambda: len(self.rule_deliveries(rule["id"])) == 1)
        first = self.rule_deliveries(rule["id"])[0]
        self.assertEqual((first["event"], first["context"]["connection.protocol"]), ("device.offline", "wss"))

        forged = self.api("POST", "/agent/v1/connect", json=hello | {"notificationKey": secrets.token_urlsafe(32)}).json()
        stamp = datetime.now(timezone.utc).isoformat()
        lid = self.notification_event("lid.changed", {"lidClosed": True, "occurredAt": stamp})
        self.send_agent_frames(forged, lid)
        self.api("DELETE", "/agent/v1/connection", 204, headers={"X-FileSharing-Channel": forged["channel"]})
        self.assertEqual(len(self.rule_deliveries(rule["id"])), 1)

        restored = self.api("POST", "/agent/v1/connect", json=hello).json()
        self.assertFalse(self.api("GET", self.device_api).json()["connection"]["accessGranted"])
        self.send_agent_frames(restored, lid | {"id": str(uuid.uuid4())})
        rows = self.rule_deliveries(rule["id"])
        self.assertEqual([row["event"] for row in rows], ["device.offline", "device.online", "lid.closed"])
        self.assertEqual(rows[1]["context"]["connection.protocol"], "https")
        self.assertEqual(rows[2]["context"]["lid.closed"], "true")
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data:
            proof, = data.execute("SELECT ProofHash FROM NotificationDevices WHERE DeviceId=?", (hello["deviceId"],)).fetchone()
            self.assertEqual(proof, hashlib.sha256(hello["notificationKey"].encode()).hexdigest().upper())

    def file_notification_rule(self, channel_id, events, template, *, path="watched", **file_filters):
        return {"name": "Watched files", "deviceId": self.device, "enabled": True,
                "events": events, "channelIds": [channel_id],
                "filter": {"file": {"rootId": self.root_id, "path": path} | file_filters}, "template": template}

    def wait_file_watch(self, state):
        def reached():
            rows = self.api("GET", NOTIFICATIONS + "/watches", params={"deviceId": self.device}).json()
            return next((view for view in rows if view["state"] == state), None)
        return self.wait(reached, seconds=20)

    def wait_rule_event(self, rule, kind, *, name=None):
        def reached():
            return next((row for row in self.rule_deliveries(rule["id"]) if row["event"] == kind
                         and (name is None or row["context"].get("file.name") == name)), None)
        return self.wait(reached, seconds=18)

    def test_notification_file_watches_apply_scope_and_run_while_locked(self):
        fixture = self.notification_fixture()
        registration = self.setup_device()
        connection_id = registration["connection"]["connectionId"]
        folder = self.home / "watched"
        folder.mkdir()
        (self.home / "sibling").mkdir()
        phone = self.notification_channel(fixture)
        rule_body = self.file_notification_rule(phone["id"], ["file.added", "file.removed", "file.renamed", "file.modified"],
                                                {"title": "{{device.name}}", "body": "{{event.type}} {{file.oldName}} → {{file.name}}"},
                                                nameGlob="*.txt", entryKind="file")
        rules = NOTIFICATIONS + "/rules"
        self.api("POST", rules, 400, json=rule_body | {"filter": {"file": {"rootId": self.root_id, "path": "../"}}})
        self.api("POST", rules, 403, json=rule_body | {
            "filter": {"file": {"rootId": str(uuid.uuid4()), "path": "watched"}}
        })
        self.api("POST", rules, 400, json=rule_body | {"filter": {}})
        rule = self.api("POST", rules, 201, json=rule_body).json()
        aggregate = self.api("POST", rules, 201, json=self.file_notification_rule(
            phone["id"], ["file.directoryChanged"], {"body": "{{directory.path}} {{directory.changeKind}} {{directory.changeCount}}"})).json()
        watch = self.wait_file_watch("active")
        self.assertEqual(set(watch["ruleIds"]), {rule["id"], aggregate["id"]})
        self.assertEqual(self.rule_deliveries(rule["id"]), [])
        self.assertEqual(self.rule_deliveries(aggregate["id"]), [])

        self.api("POST", API + "/auth/lock", 204)
        self.api("GET", NOTIFICATIONS + "/watches", 401)
        (self.home / "sibling" / "outside.txt").write_text("outside")
        (folder / ".env.txt").write_text("hidden by local scope")
        (folder / "old.txt").write_text("one")

        def pushed_while_locked():
            with fixture.guard:
                return any(body["body"] == "file.added  → old.txt" for _, body in fixture.received)
        self.wait(pushed_while_locked, seconds=18)
        self.unlock()
        added = self.wait_rule_event(rule, "file.added", name="old.txt")
        self.assertEqual(added["context"]["file.path"], "watched/old.txt")
        self.assertEqual(added["context"]["file.size"], "3")
        self.assertNotIn(str(self.home), json.dumps(added))
        batch = self.wait_rule_event(aggregate, "file.directoryChanged")
        self.assertEqual((batch["message"]["body"], batch["sourceSequence"]), ("watched delta 1", added["sourceSequence"]))

        (folder / "old.txt").write_text("modified data")
        changed = self.wait_rule_event(rule, "file.modified", name="old.txt")
        self.assertEqual(changed["context"]["file.size"], str(len("modified data")))
        (folder / "old.txt").rename(folder / "renamed.txt")
        renamed = self.wait_rule_event(rule, "file.renamed", name="renamed.txt")
        self.assertEqual(renamed["context"]["file.oldPath"], "watched/old.txt")
        self.assertEqual(renamed["message"]["body"], "file.renamed old.txt → renamed.txt")
        (folder / "renamed.txt").unlink()
        removed = self.wait_rule_event(rule, "file.removed", name="renamed.txt")
        self.assertEqual(removed["rootId"], self.root_id)
        self.assertEqual([row["event"] for row in self.rule_deliveries(rule["id"])],
                         ["file.added", "file.modified", "file.renamed", "file.removed"])

        self.set_access(connection_id, False)
        self.wait_file_watch("awaitingAuthorization")
        (folder / "while-unauthorized.txt").write_text("no access")
        self.set_access(connection_id, True)
        self.wait_file_watch("active")
        (folder / "authorized.txt").write_text("access")
        self.wait_rule_event(rule, "file.added", name="authorized.txt")
        paths = {row["context"]["file.path"] for row in self.rule_deliveries(rule["id"])}
        self.assertEqual(paths, {"watched/old.txt", "watched/renamed.txt", "watched/authorized.txt"})

    def test_notification_directory_watch_delivers_over_https(self):
        fixture = self.notification_fixture(polling=True)
        registration = self.setup_device()
        self.assertEqual(registration["connection"]["protocol"], "https")
        folder = self.home / "watched"
        folder.mkdir()
        phone = self.notification_channel(fixture)
        body = self.file_notification_rule(phone["id"], ["file.added"], {"body": "{{file.name}}"})
        rule = self.api("POST", NOTIFICATIONS + "/rules", 201, json=body).json()
        self.wait_file_watch("active")
        (folder / "報告.txt").write_text("hello")
        added = self.wait_rule_event(rule, "file.added", name="報告.txt")
        self.assertEqual(self.wait_delivery(added)["message"]["body"], "報告.txt")

        with fixture.guard:
            fixture.responses["/push"] = [(429, {"code": 429}, {"Retry-After": "60"})]
        (folder / "waiting.txt").write_text("should not be retried")
        waiting = self.wait_rule_event(rule, "file.added", name="waiting.txt")
        self.wait_delivery(waiting, "retryScheduled")
        self.api("DELETE", f"{self.device_api}/file-roots/{self.root_id}", 204)
        cancelled = self.wait_delivery(waiting, "cancelled")
        self.assertEqual((cancelled["error"], cancelled["attempts"], cancelled["nextAttemptAt"]),
                         ("notification_scope_revoked", 1, None))
        self.assertEqual(self.wait_file_watch("unavailable")["error"], "root_access_denied")

    def test_notification_file_watch_rejects_stale_frames_after_reauthorization(self):
        fixture = self.notification_fixture()
        self.register()
        self.unlock()
        self.device = str(uuid.uuid4())
        self.device_api = f"{API}/devices/{self.device}"
        local_root = str(uuid.uuid4())
        connection = self.api("POST", "/agent/v1/connect",
                              json={"deviceId": self.device, "name": "Fixture Mac"}).json()
        self.send_agent_frames(connection, self.notification_event("roots", [
            {"rootKey": local_root, "label": "Home", "primary": True, "writable": False}
        ], snapshot=True))
        self.root_id = self.api("GET", self.device_api + "/file-roots").json()["items"][0]["id"]
        connection_id = self.api("GET", self.device_api).json()["connection"]["connectionId"]
        self.set_access(connection_id, True)
        phone = self.notification_channel(fixture)
        rule_body = self.file_notification_rule(phone["id"], ["file.added"], {"body": "{{file.name}}"}, path="")
        rule = self.api("POST", NOTIFICATIONS + "/rules", 201, json=rule_body).json()

        def accept_watch():
            while True:
                frames = self.api("GET", "/agent/v1/commands",
                                  headers={"X-FileSharing-Channel": connection["channel"]}).json()
                for command in frames:
                    payload = command["payload"]
                    if command["kind"] == "files.unwatch":
                        self.send_agent_frames(connection, {"type": "result", "id": command["id"], "ok": True, "payload": {}})
                    if command["kind"] == "files.watch":
                        self.assertEqual((payload["root"], payload["purpose"]), (local_root, "notification"))
                        self.send_agent_frames(connection, {"type": "result", "id": command["id"], "ok": True,
                                                            "payload": {"purpose": "notification", "revision": "fixture"}})
                        return payload["watchId"]
                self.assertTrue(frames, "Expected a watch or unwatch command")

        def added(watch, filename):
            return self.notification_event("files.changed", {
                "watchId": watch, "purpose": "notification", "kind": "delta", "occurredAt": datetime.now(timezone.utc).isoformat(),
                "changes": [{"kind": "added", "entry": {"path": filename, "kind": "file", "size": 5}}]
            })

        first = accept_watch()
        self.wait_file_watch("active")
        self.set_access(connection_id, False)
        self.set_access(connection_id, True)
        self.send_agent_frames(connection, added(first, "old.txt"))
        self.assertEqual(self.rule_deliveries(rule["id"]), [])
        second = accept_watch()
        self.assertNotEqual(first, second)
        self.wait_file_watch("active")
        self.send_agent_frames(connection, added(second, "new.txt"))
        self.assertEqual(self.wait_rule_event(rule, "file.added")["message"]["body"], "new.txt")

    def test_openapi_contract(self):
        contract = self.api("GET", "/openapi/v1.json").json()
        paths = contract["paths"]
        for expected in ("/api/v1/auth/passkeys/recovery", "/api/v1/auth/status", "/api/v1/auth/lock",
                         "/api/v1/devices/{id}/policy", "/api/v1/devices/{id}/connection-access", "/api/v1/devices/{id}/files/thumbnail",
                         "/api/v1/devices/{id}/files/trash", "/api/v1/devices/{id}/files/renames",
                         "/api/v1/ftp/accounts/{id}/password", "/api/v1/transfers/{id}/content", "/api/v1/events/ws",
                         "/api/v1/jobs/{id}/output", "/api/v1/devices/{id}/interactions/dialogs",
                         "/api/v1/devices/{id}/interactions/dialogs/{recordId}",
                         "/api/v1/devices/{id}/clipboard/records", "/api/v1/devices/{id}/clipboard/records/{recordId}",
                         "/api/v1/devices/{id}/interactions/notifications", "/api/v1/ftp/connections",
                         "/api/v1/ftp/accounts/{id}/password/reveal", "/api/v1/devices/{id}/windows",
                         NOTIFICATIONS + "/channels/{id}/verify", NOTIFICATIONS + "/channels/{id}/test",
                         NOTIFICATIONS + "/deliveries", NOTIFICATIONS + "/updates",
                         NOTIFICATIONS + "/event-types", NOTIFICATIONS + "/rules", NOTIFICATIONS + "/rules/preview", NOTIFICATIONS + "/watches"):
            self.assertIn(expected, paths)
        self.assertNotIn("/api/v1/enrollments", paths)
        self.assertIn("101", paths["/api/v1/events/ws"]["get"]["responses"])
        self.assertIn("FileEntry", contract["components"]["schemas"])
        self.assertIn("WindowSnapshot", contract["components"]["schemas"])
        self.assertIn("204", paths["/api/v1/devices/{id}/windows"]["get"]["responses"])
        schemas = contract["components"]["schemas"]
        self.assertIn("textFields", schemas["DialogRequest"]["properties"])
        self.assertEqual(set(schemas["DialogTextField"]["properties"]),
                         {"id", "hintText", "defaultText", "disabled", "required", "maskText"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
