import ftplib
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import stat
import subprocess
import tempfile
import time
import unittest

import requests
from websockets.sync.client import connect

from integration import API, APP, AUTH, ROOT, Passkey, passive_ports, port, ports, sftp_client


class DeploymentSmoke(unittest.TestCase):
    def test_nginx_https_wss_ftps_and_sftp(self):
        scratch = ROOT / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="proxy-smoke-", dir=scratch) as directory:
            self.exercise(Path(directory))

    def exercise(self, directory):
        tls = directory / "tls"
        tls.mkdir()
        key = tls / "privkey.pem"
        certificate = tls / "fullchain.pem"
        ca = directory / "ca.pem"
        ca_key = directory / "ca.key"
        csr = directory / "localhost.csr"
        der = directory / "public.der"
        extensions = directory / "server.ext"
        extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                              "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n")

        def openssl(*arguments):
            subprocess.run(["openssl", *map(str, arguments)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=FileSharing test CA",
                "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout", ca_key, "-out", ca)
        openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", csr)
        openssl("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-CAcreateserial", "-days", "1",
                "-extfile", extensions, "-out", certificate)
        openssl("x509", "-in", ca, "-outform", "DER", "-out", der)
        key.chmod(0o644)
        for filename in ("init-env.sh", ".env.example"):
            shutil.copy(ROOT / "deploy" / filename, directory)
        subprocess.run([str(directory / "init-env.sh")], check=True, capture_output=True)
        env_path = directory / ".env"
        self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o600)
        setup_key = next(line.partition("=")[2] for line in env_path.read_text().splitlines()
                         if line.startswith("FILESHARING_BOOTSTRAP_SECRET="))
        self.assertRegex(setup_key, "^[0-9a-f]{64}$")
        subprocess.run([str(directory / "init-env.sh")], check=True, capture_output=True)
        self.assertIn(f"FILESHARING_BOOTSTRAP_SECRET={setup_key}", env_path.read_text())

        web, plain, explicit, implicit = ports()
        ssh_port = port()
        while ssh_port in (web, plain, explicit, implicit):
            ssh_port = port()
        passive_low, passive_high = passive_ports((web, plain, explicit, implicit, ssh_port))
        origin = f"https://localhost:{web}"
        project = "filesharing-smoke-" + secrets.token_hex(5)
        compose_env = os.environ | {
            "FILESHARING_DOMAIN": "localhost",
            "FILESHARING_ORIGIN": origin,
            "FILESHARING_HTTPS_IP": "127.0.0.1",
            "FILESHARING_HTTPS_PORT": str(web),
            "FILESHARING_NETWORK_PREFIX": f"172.31.{150 + secrets.randbelow(90)}",
            "FILESHARING_FTP_IP": "127.0.0.1",
            "FILESHARING_FTP_HOST": "localhost",
            "FILESHARING_FTP_PLAIN_PORT": str(plain),
            "FILESHARING_FTP_EXPLICIT_PORT": str(explicit),
            "FILESHARING_FTP_IMPLICIT_PORT": str(implicit),
            "FILESHARING_SFTP_PORT": str(ssh_port),
            "FILESHARING_FTP_PASSIVE_MIN": str(passive_low),
            "FILESHARING_FTP_PASSIVE_MAX": str(passive_high),
            "FILESHARING_FTP_PASSIVE_ADDRESS": "127.0.0.1",
            "FILESHARING_FTP_PLAIN_CLIENTS": "127.0.0.0/8",
            "FILESHARING_TLS_DIR": str(tls),
            "FILESHARING_BOOTSTRAP_SECRET": setup_key,
            "FILESHARING_GATEWAY_KEY": secrets.token_hex(32),
        }

        def compose(*arguments):
            return subprocess.run(["docker", "compose", "-p", project, "-f", str(ROOT / "deploy/compose.yaml"), *arguments],
                                  env=compose_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=240)

        agent = None
        browser = requests.Session()
        browser.trust_env = False
        browser.headers["Origin"] = origin
        browser.verify = str(ca)

        def api(method, route, status=200, **kwargs):
            response = browser.request(method, origin + route, timeout=20, **kwargs)
            self.assertEqual(response.status_code, status, f"{method} {route}: {response.text[:350]}")
            return response

        try:
            running = compose("up", "--build", "-d")
            self.assertEqual(running.returncode, 0, running.stdout[-8000:])
            for _ in range(80):
                try:
                    if browser.get(origin + "/health/ready", timeout=1).ok:
                        break
                except requests.RequestException:
                    pass
                time.sleep(0.2)
            self.assertTrue(api("GET", "/health/ready").json()["ready"])

            key_handle = Passkey(origin)
            start = api("POST", AUTH + "/registration/options", json={"secret": setup_key}).json()
            api("POST", AUTH + "/registration", 204, json={"secret": setup_key, "challengeId": start["challengeId"],
                "credential": key_handle.create(start["publicKey"])})
            request = api("POST", AUTH + "/authentication/options").json()
            login = api("POST", AUTH + "/authentication", json={"challengeId": request["challengeId"],
                        "credential": key_handle.assert_for(request["publicKey"])})
            self.assertIn("__Host-fs-admin=", login.headers["Set-Cookie"])
            self.assertIn("secure", login.headers["Set-Cookie"].lower())
            contract = api("GET", "/openapi/v1.json").json()
            self.assertIn("/api/v1/ftp/accounts", contract["paths"])

            home = directory / "test-home"
            home.mkdir()
            agent_state = directory / "agent-state"
            agent_state.mkdir(mode=0o700)
            payload = b"TLS forwarding and FTP proxy fixture"
            (home / "fixture.txt").write_bytes(payload)
            agent_env = os.environ | {
                "FILESHARING_TEST_STATE": str(agent_state),
                "FILESHARING_TEST_HOME": str(home),
                "FILESHARING_TEST_ORIGIN": origin,
                "FILESHARING_TEST_CA_DER": str(der),
                "TMPDIR": str(directory),
            }
            with (directory / "agent.log").open("w") as log:
                agent = subprocess.Popen([str(APP), "run"], stdout=log, stderr=log, env=agent_env)
            for _ in range(100):
                devices = api("GET", API + "/devices").json()["items"]
                if devices and devices[0]["connection"]["online"]:
                    break
                time.sleep(0.2)
            self.assertTrue(devices and devices[0]["connection"]["online"], (directory / "agent.log").read_text())
            device = devices[0]["id"]
            self.assertEqual(devices[0]["connection"]["protocol"], "wss")
            self.assertFalse(devices[0]["connection"]["accessGranted"])
            access = api("PUT", f"{API}/devices/{device}/connection-access",
                         json={"connectionId": devices[0]["connection"]["connectionId"], "enabled": True}).json()
            self.assertTrue(access["accessGranted"])
            for _ in range(75):
                scopes = api("GET", f"{API}/devices/{device}/file-roots").json()["items"]
                if scopes:
                    break
                time.sleep(0.2)
            self.assertEqual(len(scopes), 1, (directory / "agent.log").read_text())
            root = scopes[0]["id"]
            context = ssl.create_default_context(cafile=ca)
            cookie = "; ".join(f"{entry.name}={entry.value}" for entry in browser.cookies)
            with connect(origin.replace("https:", "wss:") + API + "/events/ws", origin=origin, ssl=context,
                         additional_headers={"Cookie": cookie}, proxy=None, open_timeout=12) as websocket:
                self.assertEqual(json.loads(websocket.recv(timeout=5))["type"], "ready")
                websocket.send(json.dumps({"type": "subscribe", "id": "tls-folder", "deviceId": device, "rootId": root,
                                            "path": "", "topic": "files.changed"}))
                self.assertEqual(json.loads(websocket.recv(timeout=8))["type"], "subscribed")

            credential = api("POST", API + "/ftp/accounts", 201,
                             json={"name": "gateway-test", "mode": "ftps", "rootIds": [root]}).json()
            api("PUT", f"{API}/devices/{device}",
                json={"name": "Smoke Mac", "profileId": "default", "revision": devices[0]["revision"]})
            secure_file = api("POST", API + "/ftp/accounts", 201,
                              json={"name": "decoupled-ssh", "mode": "sftp", "scope": "activeHomes"}).json()
            secure_endpoint, = secure_file["endpoints"]
            self.assertTrue(secure_endpoint["available"])
            self.assertEqual(secure_endpoint["port"], ssh_port)
            download, _, environment = sftp_client(directory, ssh_port, secure_endpoint["hostKeyFingerprint"], secure_file)
            api("POST", "/_sftp/open", 404, json={})
            api("POST", API + "/auth/lock", 204)
            api("GET", API + "/devices", 401)
            with ftplib.FTP_TLS(context=context) as ftp:
                ftp.connect("localhost", explicit, timeout=12)
                ftp.login(credential["account"]["name"], credential["password"])
                ftp.prot_p()
                ftp.cwd(f"/{device}/{root}")
                output = io.BytesIO()
                ftp.retrbinary("RETR fixture.txt", output.write)
                self.assertEqual(output.getvalue(), payload)
            copied = subprocess.run(download, input="get /smoke-mac/fixture.txt received.txt\nbye\n", env=environment,
                                    cwd=directory, capture_output=True, text=True, timeout=20)
            self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
            self.assertEqual((directory / "received.txt").read_bytes(), payload)
        except BaseException:
            agent_log = directory / "agent.log"
            if agent_log.exists():
                print(agent_log.read_text()[-3000:])
            details = compose("logs", "--tail", "120")
            traces = [line for line in details.stdout.splitlines()
                      if "/agent/" in line or "/events/ws" in line or "error" in line or "fail" in line]
            print("\n".join(traces[-30:]) or details.stdout[-3300:])
            raise
        finally:
            browser.close()
            if agent is not None and agent.poll() is None:
                agent.terminate()
                try:
                    agent.wait(timeout=7)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait(timeout=4)
            cleanup = compose("down", "--volumes", "--remove-orphans", "--rmi", "local")
            self.assertEqual(cleanup.returncode, 0, cleanup.stdout[-4000:])


if __name__ == "__main__":
    unittest.main(verbosity=2)
