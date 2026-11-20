import base64
import ftplib
import itertools
import json
import os
from pathlib import Path
import sqlite3
import time
import unittest
import uuid
from contextlib import closing
from datetime import datetime, timezone

from websockets.sync.client import connect

import integration


class Browser:
    def __init__(self, channel):
        self.channel = channel
        self.identifiers = itertools.count(1)

    def call(self, method, **arguments):
        number = next(self.identifiers)
        self.channel.send(json.dumps({"id": number, "method": method, "params": arguments}))
        while True:
            message = json.loads(self.channel.recv(timeout=10))
            if message.get("id") != number:
                continue
            if "error" in message:
                raise AssertionError(message["error"])
            return message.get("result", {})

    def evaluate(self, expression):
        result = self.call("Runtime.evaluate", expression=expression, returnByValue=True,
                           userGesture=True, awaitPromise=True)
        if "exceptionDetails" in result:
            raise AssertionError(result["exceptionDetails"])
        return result["result"].get("value")

    def wait(self, condition, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.evaluate(condition):
                return
            time.sleep(0.15)
        raise AssertionError(f"Timed out waiting for {condition}\n{self.evaluate('document.body.innerText')}")


class LocalDemoBrowser(unittest.TestCase):
    def setUp(self):
        class DemoFixture(integration.Acceptance):
            def start_server(self, polling=True):
                self.env["FileSharing__EnableDemo"] = "true"
                super().start_server(polling)

        self.fixture = DemoFixture()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        self.downloads = self.fixture.home / "Downloads"
        self.downloads.mkdir()

    def start_browser(self, *, real_agent=True, **agent_env):
        fixture = self.fixture
        if real_agent:
            fixture.spawn([str(integration.APP), "run"], "agent.log", fixture.env | agent_env)
        self.assertEqual(fixture.browser.get(fixture.origin + "/demo", timeout=5).status_code, 200)

        profile = fixture.work / "browser"
        profile.mkdir()
        chrome = os.environ.get("FILESHARING_TEST_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        self.assertTrue(Path(chrome).is_file(), "Chrome is required for the isolated UI acceptance test.")
        fixture.spawn([chrome, "--headless=new", "--disable-background-networking",
                       "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
                       "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + str(profile), "about:blank"],
                      "chrome.log", fixture.env)
        port = fixture.wait(lambda: (profile / "DevToolsActivePort").read_text().splitlines()[0])
        tabs = fixture.browser.get(f"http://127.0.0.1:{port}/json/list", timeout=5).json()
        target = next(tab for tab in tabs if tab["type"] == "page")
        channel = connect(target["webSocketDebuggerUrl"], proxy=None, open_timeout=5)
        self.addCleanup(channel.close)
        browser = Browser(channel)
        browser.call("Page.enable")
        browser.call("WebAuthn.enable")
        browser.call("WebAuthn.addVirtualAuthenticator", options={
            "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
            "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True
        })
        browser.call("Page.navigate", url=fixture.origin + "/demo")
        browser.wait("document.querySelector('#setup')?.offsetHeight > 0")
        browser.evaluate(f"document.querySelector('#secret').value = {json.dumps(fixture.setup_key)}")
        browser.evaluate("document.querySelector('#setup button').click()")
        browser.wait("document.querySelector('#unlock').offsetHeight > 0")
        browser.evaluate("document.querySelector('#unlock').click()")
        browser.wait("!document.querySelector('#access').disabled")
        browser.wait("document.querySelector('#feed-status').textContent === 'WebSocket 已订阅'")
        browser.evaluate("document.querySelector('#access').click()")
        browser.wait("!document.querySelector('#browse-button').disabled")
        return browser

    def capture(self, browser, name, width):
        browser.call("Emulation.setDeviceMetricsOverride", width=width, height=900, deviceScaleFactor=1, mobile=False)
        browser.evaluate("window.scrollTo(0, 0); document.fonts.ready.then(() => true)")
        self.assertTrue(browser.evaluate("document.scrollingElement.scrollWidth <= innerWidth"))
        if directory := os.environ.get("FILESHARING_DEMO_SCREENSHOT_DIR"):
            path = Path(directory)
            path.mkdir(parents=True, exist_ok=True)
            shot = browser.call("Page.captureScreenshot", format="png", captureBeyondViewport=False)
            (path / (name + ".png")).write_bytes(base64.b64decode(shot["data"]))

    def test_browser_reports_pending_pasteboard_and_previews_file_over_polling(self):
        expected = "FileSharing isolated browser fixture.\n"
        (self.downloads / "preview.txt").write_text(expected)
        release = self.fixture.work / "release-pasteboard"
        browser = self.start_browser(FILESHARING_TEST_PASTEBOARD_RELEASE=str(release))
        self.assertIn("在线 · https", browser.evaluate("document.querySelector('#device-status').textContent"))
        connection_id = """(async () => {
            const device = (await (await fetch('/api/v1/devices')).json()).items[0]
            return device.connection.connectionId
        })()"""
        live_connection = browser.evaluate(connection_id)
        self.assertIsNotNone(live_connection)
        browser.wait("!document.querySelector('[data-permission=downloads] button')?.disabled")
        browser.evaluate("document.querySelector('[data-permission=pasteboard] button').click()")
        browser.wait("document.querySelector('[data-permission=pasteboard]').textContent.includes('等待 macOS 确认')")
        self.assertTrue(browser.evaluate("document.querySelector('[data-permission=pasteboard] button').disabled"))
        browser.evaluate("document.querySelector('[data-permission=downloads] button').click()")
        browser.wait("document.querySelector('[data-permission=downloads]').textContent.includes('已授权')")
        self.assertEqual(browser.evaluate("document.querySelector('#feed-status').textContent"),
                         "已通过 WebSocket 收到权限状态")
        browser.evaluate("document.querySelector('#browse-button').click()")
        browser.wait("document.querySelector('#entries').textContent.includes('preview.txt')")
        browser.evaluate("document.querySelector('#entries button').click()")
        browser.wait("document.querySelector('#preview')?.offsetHeight > 0")
        self.assertEqual(browser.evaluate("document.querySelector('#preview-content').textContent"), expected)
        self.assertIn("等待 macOS 确认", browser.evaluate("document.querySelector('[data-permission=pasteboard]').textContent"))
        self.assertEqual(browser.evaluate(connection_id), live_connection)
        release.touch()
        browser.wait("document.querySelector('[data-permission=pasteboard]').textContent.includes('需系统设置')")
        browser.wait("!document.querySelector('[data-permission=pasteboard] button').disabled")
        self.assertIn("每次询问", browser.evaluate("document.querySelector('#notice').textContent"))
        self.assertEqual(browser.evaluate(connection_id), live_connection)
        self.assertIn("当前连接已授权", browser.evaluate("document.querySelector('#access').textContent"))
        browser.evaluate("document.querySelector('#lock').click()")
        browser.wait("document.querySelector('#workspace').hidden")
        self.assertEqual(browser.evaluate("document.querySelector('#preview-content').textContent"), "")

    def test_browser_renders_thumbnails_and_sorts_file_metadata_across_pages(self):
        image = self.downloads / "01 海报 & 预览%.png"
        image.write_bytes(integration.png())
        os.utime(image, (1_710_000_000, 1_710_000_000))
        small, large = self.downloads / "a-small.txt", self.downloads / "z-large.txt"
        small.write_bytes(b"a")
        large.write_bytes(b"z" * 8192)
        os.utime(small, (1_700_000_000, 1_700_000_000))
        for index in range(81):
            (self.downloads / f"sample-{index:02}.txt").write_bytes(b"x" * (100 + index))
        (self.downloads / ".hidden.txt").write_bytes(b"hidden")

        browser = self.start_browser()
        browser.call("Emulation.setDeviceMetricsOverride", width=1360, height=900, deviceScaleFactor=1, mobile=False)
        browser.evaluate("document.querySelector('#browse-button').click()")
        browser.wait("document.querySelector('#file-status').textContent.includes('80 / 84')")
        browser.evaluate("document.querySelector('#entries tr').scrollIntoView({block:'center'})")
        browser.wait("document.querySelector('#entries tr:first-child img')?.naturalWidth > 0")
        source = browser.evaluate("""(() => {
            const preview = document.querySelector('#entries tr:first-child img')
            const url = new URL(preview.src)
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const drawing = canvas.getContext('2d')
            drawing.drawImage(preview, 0, 0, 1, 1)
            return {route: url.pathname.split('/').at(-1), path: url.searchParams.get('path'),
                    version: url.searchParams.get('version'), pixel: [...drawing.getImageData(0, 0, 1, 1).data]}
        })()""")
        self.assertEqual((source["route"], source["path"]), ("thumbnail", "Downloads/" + image.name))
        self.assertTrue(source["version"])
        self.assertEqual(source["pixel"], [255, 0, 0, 255])
        metadata = browser.evaluate("""(() => {
            const cells = document.querySelector('#entries tr').cells
            return {name: cells[1].firstChild.textContent, extension: cells[1].lastChild.textContent,
                    type: cells[2].textContent, bytes: cells[3].title, created: cells[4].firstChild.dateTime,
                    modified: Date.parse(cells[5].firstChild.dateTime) / 1000,
                    lastOpened: cells[6].querySelector('time')?.dateTime ?? cells[6].textContent}
        })()""")
        self.assertEqual((metadata["name"], metadata["extension"], metadata["type"], metadata["bytes"]),
                         (image.name, ".png", "public.png", f"{image.stat().st_size:,} B"))
        self.assertTrue(metadata["created"] and metadata["lastOpened"])
        self.assertEqual(metadata["modified"], 1_710_000_000)

        first_name = "document.querySelector('#entries .file-name')?.textContent"
        browser.evaluate("document.querySelector('[data-sort=size]').click()")
        browser.wait(first_name + " === 'a-small.txt'")
        browser.evaluate("document.querySelector('[data-sort=size]').click()")
        browser.wait(first_name + " === 'z-large.txt'")
        self.assertEqual(browser.evaluate("document.querySelector('[data-sort=size]').parentElement.getAttribute('aria-sort')"), "descending")
        self.assertEqual(browser.evaluate("document.querySelector('#entries .file-size').textContent"), "8 KiB")
        browser.evaluate("document.querySelector('#next-page').click()")
        browser.wait("document.querySelector('#file-status').textContent.includes('84 / 84')")
        sizes = browser.evaluate("""Array.from(document.querySelectorAll('#entries .file-size'),
                                               cell => Number(cell.title.replace(/[^0-9]/g, '')))""")
        self.assertEqual(sizes, sorted(sizes, reverse=True))
        self.assertTrue(browser.evaluate("document.querySelector('#next-page').hidden"))

        browser.evaluate("document.querySelector('[data-sort=modifiedAt]').click()")
        browser.wait(first_name + " === 'a-small.txt'")
        browser.evaluate("document.querySelector('[data-sort=name]').click()")
        browser.wait(first_name + " === " + json.dumps(image.name))
        browser.evaluate("document.querySelector('#show-hidden').click()")
        browser.wait("document.querySelector('#file-status').textContent.includes('80 / 85')")
        self.assertEqual(browser.evaluate(first_name), ".hidden.txt")
        browser.evaluate("document.querySelector('#lock').click()")
        browser.wait("document.querySelector('#workspace').hidden")
        self.assertEqual(browser.evaluate("document.querySelector('#entries').childElementCount"), 0)

    def test_browser_saves_power_policy_collects_samples_and_rotates_ftp_credentials(self):
        fixture = self.fixture
        lid = fixture.work / "lid"
        lid.write_text("open")
        browser = self.start_browser(FILESHARING_TEST_LID=str(lid))
        self.assertEqual(browser.evaluate("""
            const tab = document.querySelector('#tab-files');
            tab.focus();
            tab.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
            document.activeElement.id
        """), "tab-telemetry")
        browser.wait("document.querySelector('#telemetry-feed').textContent === 'WebSocket 直播'")
        browser.wait("!document.querySelector('#policy-fields').disabled && document.querySelector('#telemetry-summary').textContent.includes('已开盖')")
        browser.evaluate("""
            document.querySelector('#keep-awake').checked = false;
            document.querySelector('#sample-cpu').value = 5;
            document.querySelector('#device-policy').requestSubmit()
        """)
        browser.wait("document.querySelector('#policy-status').textContent.includes('已保存设备策略')")
        browser.wait("document.querySelector('#power-details').textContent.includes('遵循默认睡眠')")
        lid.write_text("closed")
        browser.wait("document.querySelector('#device-events').textContent.includes('已合盖')")
        browser.evaluate("document.querySelector('#collect-telemetry').click()")
        browser.wait("document.querySelector('#collect-status').textContent.includes('设备已回传最新采样')", seconds=35)
        self.assertTrue(browser.evaluate("document.querySelector('#telemetry-summary meter')?.value >= 0"))
        self.capture(browser, "telemetry-desktop", 1360)
        self.capture(browser, "telemetry-tablet", 768)
        self.capture(browser, "telemetry-mobile", 375)
        self.capture(browser, "telemetry-narrow", 320)
        browser.evaluate("document.querySelector('#inherit-policy').click()")
        browser.wait("document.querySelector('#policy-status').textContent === '已恢复继承。'")

        browser.evaluate("document.querySelector('#tab-actions').click(); document.querySelector('#diagnostic-form').requestSubmit()")
        browser.wait("document.querySelector('#diagnostic-status').textContent === '退出码 0'")
        self.assertIn("ProductVersion", browser.evaluate("document.querySelector('#diagnostic-stdout').textContent"))
        browser.evaluate("""
            const kind = document.querySelector('#diagnostic-kind');
            kind.value = 'custom';
            kind.dispatchEvent(new Event('change', {bubbles: true}));
            document.querySelector('#diagnostic-command').value = 'uname -m';
            document.querySelector('#diagnostic-form').requestSubmit();
        """)
        browser.wait("document.querySelector('#diagnostic-status').textContent === '退出码 0'")
        self.assertEqual(browser.evaluate("document.querySelector('#diagnostic-stdout').textContent.trim()"), os.uname().machine)
        self.capture(browser, "actions-desktop", 1360)

        browser.evaluate("document.querySelector('#tab-gateway').click()")
        browser.wait("!document.querySelector('#gateway-create-fields').disabled")
        browser.evaluate("""
            document.querySelector('#gateway-mode').value = 'ftp';
            document.querySelector('#gateway-name').value = 'demo-ftp-fixture';
            document.querySelector('#gateway-create').requestSubmit()
        """)
        browser.wait("!document.querySelector('#gateway-credential').hidden")
        original = browser.evaluate("document.querySelector('#gateway-visible-password').value")
        with ftplib.FTP() as client:
            client.connect("127.0.0.1", fixture.plain_port, timeout=10)
            client.login("demo-ftp-fixture", original)
            self.assertTrue(client.nlst("/"))
            browser.wait("document.querySelector('#gateway-connections').textContent.includes('demo-ftp-fixture')")
            browser.evaluate("document.querySelector('#gateway-hide').click()")
            self.assertEqual(browser.evaluate("document.querySelector('#gateway-visible-password').value"), "")
            with closing(sqlite3.connect(fixture.work / "db" / "filesharing.db")) as db, db:
                db.execute("UPDATE Reviews SET Created=Created-301 WHERE Revoked IS NULL")
            browser.evaluate("document.querySelector('#gateway-reveal').click()")
            browser.wait("document.querySelector('#gateway-account-status').textContent === '已验证账号密码。'")
            self.assertTrue(browser.evaluate("document.querySelector('#gateway-visible-password').value") == original)
            browser.evaluate("document.querySelector('#gateway-rotate').requestSubmit()")
            browser.wait("document.querySelector('#gateway-account-status').textContent.includes('密码已轮换')")
            self.assertTrue(browser.evaluate("document.querySelector('#gateway-visible-password').value") != original)
            with self.assertRaises(ftplib.error_perm):
                client.nlst("/")
        browser.evaluate("document.querySelector('#gateway-hide').click()")
        self.capture(browser, "gateway-desktop", 1360)
        browser.evaluate("document.querySelector('#lock').click()")
        browser.wait("document.querySelector('#workspace').hidden")
        self.assertEqual(browser.evaluate("document.querySelector('#gateway-visible-password').value"), "")

    def test_browser_streams_application_activity_and_recovers_dialog_and_diagnostics_over_rest(self):
        fixture = self.fixture
        device = str(uuid.uuid4())
        channel = fixture.api("POST", "/agent/v1/connect", json={"deviceId": device, "name": "Browser fixture Mac"}).json()
        header = {"X-FileSharing-Channel": channel["channel"]}
        browser = self.start_browser(real_agent=False)
        stamp = lambda: datetime.now(timezone.utc).isoformat()

        def send(*frames):
            fixture.api("POST", "/agent/v1/frames", 204, headers=header, json={"frames": frames})

        def event(topic, payload, snapshot=False):
            return {"type": "event", "id": str(uuid.uuid4()), "topic": topic, "snapshot": snapshot, "payload": payload}

        def command(kind):
            commands = fixture.api("GET", "/agent/v1/commands", headers=header).json()
            selected, = [entry for entry in commands if entry["kind"] == kind]
            return selected

        browser.evaluate("document.querySelector('#tab-apps').click()")
        browser.wait("document.querySelector('#apps-feed').textContent === 'WebSocket 直播'")
        app = {"name": "Browser Fixture App", "applicationId": "fixture", "bundleId": "test.example.fixture", "version": "2.0",
               "pid": 987, "active": True, "foreground": True, "hidden": False, "launchedAt": stamp(), "uptimeSeconds": 5}
        send(event("apps-running", [app], True), event("apps-installed", [app | {"pid": None}], True),
             event("applications.changed", {"kind": "launched", "application": app, "occurredAt": stamp()}))
        browser.wait("document.querySelector('#app-rows').textContent.includes('PID 987') && document.querySelector('#app-events').textContent.includes('启动')")
        self.capture(browser, "apps-desktop", 1360)
        browser.evaluate("document.querySelector('#apps-mode').value='apps-installed'; document.querySelector('#apps-mode').dispatchEvent(new Event('change'))")
        browser.wait("document.querySelector('#app-rows').textContent.includes('Browser Fixture App') && !document.querySelector('#app-rows').textContent.includes('PID 987')")
        browser.call("Page.addScriptToEvaluateOnNewDocument", source="""
            window.WebSocket = class OfflineSocket extends EventTarget {
                static OPEN = 1;
                readyState = 0;
                constructor() { super(); queueMicrotask(() => this.close()); }
                close() {
                    if (this.readyState === 3) return;
                    this.readyState = 3;
                    this.dispatchEvent(new Event("close"));
                }
            };
        """)
        browser.call("Page.reload")
        browser.wait("!document.querySelector('#workspace').hidden && !document.querySelector('#revoke-access').hidden")
        browser.evaluate("document.querySelector('#tab-apps').click()")
        browser.wait("document.querySelector('#apps-feed').textContent === 'REST 回退'")
        send(event("apps-running", [], True), event("applications.changed", {"kind": "terminated", "application": app, "occurredAt": stamp()}))
        browser.wait("document.querySelector('#app-rows').textContent.includes('清单为空') && document.querySelector('#app-events').textContent.includes('退出')")

        browser.evaluate("""
            document.querySelector('#tab-actions').click();
            document.querySelector('#dialog-input').value = 'required';
            document.querySelector('#dialog-icon').value = 'warning';
            document.querySelector('#dialog-form').requestSubmit()
        """)
        dialog = command("interaction.dialog")
        self.assertEqual(dialog["payload"]["icon"], "warning")
        self.assertTrue(dialog["payload"]["askText"] and dialog["payload"]["textRequired"])
        send({"type": "result", "id": dialog["id"], "ok": True,
              "payload": {"outcome": "submitted", "choiceId": "choice-1", "text": "<b>维护说明</b>", "respondedAt": stamp()}})
        browser.wait("document.querySelector('#dialog-status').textContent === 'Mac 用户已提交'")
        self.assertEqual(browser.evaluate("document.querySelector('#dialog-result dd:nth-of-type(1)').textContent"), "同意")
        self.assertEqual(browser.evaluate("document.querySelector('#dialog-result dd:nth-of-type(2)').textContent"), "<b>维护说明</b>")
        self.assertFalse(browser.evaluate("Boolean(document.querySelector('#dialog-result b'))"))

        browser.evaluate("document.querySelector('#diagnostic-form').requestSubmit()")
        diagnostic = command("diagnostics.run")
        def part(index, stream, data):
            return {"type": "progress", "id": diagnostic["id"],
                    "payload": {"index": index, "stream": stream, "data": base64.b64encode(data).decode()}}
        content = "运行中\n".encode()
        send(part(1, "stdout", content[:2]), part(2, "stderr", b"warning\n"), part(3, "stdout", content[2:]))
        browser.wait("document.querySelector('#diagnostic-stdout').textContent.includes('运行中') && document.querySelector('#diagnostic-stderr').textContent.includes('warning')")
        self.assertNotIn("退出码", browser.evaluate("document.querySelector('#diagnostic-status').textContent"))
        send({"type": "result", "id": diagnostic["id"], "ok": True,
              "payload": {"stdout": "运行中\n", "stderr": "warning\n", "exitCode": 4, "data": None}})
        browser.wait("document.querySelector('#diagnostic-status').textContent === '退出码 4'")


if __name__ == "__main__":
    unittest.main(verbosity=2)
