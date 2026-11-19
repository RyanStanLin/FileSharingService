import itertools
import json
import os
from pathlib import Path
import time
import unittest

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

    def start_browser(self, **agent_env):
        fixture = self.fixture
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
