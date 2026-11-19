import base64
from contextlib import closing
import concurrent.futures
import ftplib
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import sqlite3
import socket
import ssl
import struct
import subprocess
import tempfile
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

    def test_sqlite_upgrade_preserves_preexisting_device_and_grant(self):
        registration = self.setup_device()
        self.api("PUT", self.device_api, json={"name": "Existing Mac", "profileId": "default",
                                               "revision": registration["revision"]})
        legacy = self.api("POST", API + "/ftp/accounts", 201,
                          json={"name": "legacy", "mode": "ftp", "rootIds": [self.root_id]}).json()
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
        self.start_server()
        existing = self.api("GET", self.device_api).json()
        self.assertEqual(existing["name"], "Existing Mac")
        self.assertEqual(self.api("GET", self.device_api + "/file-roots").json()["items"][0]["id"], self.root_id)
        account = self.api("GET", API + "/ftp/accounts/" + legacy["account"]["id"]).json()
        self.assertEqual((account["scope"], account["rootIds"], account["passwordRetrievable"]), ("grants", [self.root_id], False))
        self.api("POST", f"{API}/ftp/accounts/{account['id']}/password/reveal", 409)
        with closing(sqlite3.connect(self.work / "db" / "filesharing.db")) as data, data:
            self.assertEqual(data.execute("PRAGMA user_version").fetchone()[0], 4)
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
            with self.channel() as ws:
                ws.send(json.dumps({"type": "subscribe", "id": "output", "deviceId": self.device, "topic": "jobs.output"}))
                self.receive(ws, lambda value: value["type"] == "subscribed")
                job = self.api("POST", self.device_api + "/diagnostics", 202, json={"kind": "osVersion"}).json()
                item = self.receive(ws, lambda value: value["type"] == "event" and value["id"] == "output")["item"]["payload"]
                self.assertEqual((item["jobId"], item["index"], item["stream"]), (job["id"], 1, "stdout"))
                finished = self.finished_job(job)
                self.assertEqual((finished["state"], finished["result"]["exitCode"]), ("completed", 0))
                self.assertFalse(finished["result"]["timedOut"])
                output = f"{API}/jobs/{job['id']}/output"
                page = self.api("GET", output).json()
                joined = b"".join(base64.b64decode(part["data"]) for part in page["items"] if part["stream"] == "stdout")
                self.assertEqual(joined.decode(), finished["result"]["stdout"])
                self.assertIn(b"ProductVersion:", joined)
                self.assertEqual(self.api("GET", output, params={"after": page["cursor"]}).json(),
                                 {"items": [], "cursor": page["cursor"]})
                self.api("GET", output, 401, session=self.client())

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

    def test_openapi_contract(self):
        contract = self.api("GET", "/openapi/v1.json").json()
        paths = contract["paths"]
        for expected in ("/api/v1/auth/passkeys/recovery", "/api/v1/auth/status", "/api/v1/auth/lock",
                         "/api/v1/devices/{id}/policy", "/api/v1/devices/{id}/connection-access", "/api/v1/devices/{id}/files/thumbnail",
                         "/api/v1/devices/{id}/files/trash", "/api/v1/devices/{id}/files/renames",
                         "/api/v1/ftp/accounts/{id}/password", "/api/v1/transfers/{id}/content", "/api/v1/events/ws",
                         "/api/v1/jobs/{id}/output", "/api/v1/devices/{id}/interactions/dialogs",
                         "/api/v1/devices/{id}/interactions/notifications"):
            self.assertIn(expected, paths)
        self.assertNotIn("/api/v1/enrollments", paths)
        self.assertIn("101", paths["/api/v1/events/ws"]["get"]["responses"])
        self.assertIn("FileEntry", contract["components"]["schemas"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
