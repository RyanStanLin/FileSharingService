import itertools
import json
import os
from pathlib import Path
import subprocess
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
    def test_browser_pushes_permission_and_previews_fixture_file(self):
        class DemoFixture(integration.Acceptance):
            def start_server(self, polling=False):
                self.env["FileSharing__EnableDemo"] = "true"
                super().start_server(polling)

        fixture = DemoFixture()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        folder = fixture.home / "Downloads"
        folder.mkdir()
        expected = "FileSharing isolated browser fixture.\n"
        (folder / "preview.txt").write_text(expected)
        fixture.spawn([str(integration.APP), "run"], "agent.log", fixture.env)
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
        with connect(target["webSocketDebuggerUrl"], proxy=None, open_timeout=5) as channel:
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
            browser.wait("!document.querySelector('[data-permission=downloads] button')?.disabled")
            browser.evaluate("document.querySelector('[data-permission=downloads] button').click()")
            browser.wait("document.querySelector('[data-permission=downloads]').textContent.includes('已授权')")
            self.assertEqual(browser.evaluate("document.querySelector('#feed-status').textContent"),
                             "已通过 WebSocket 收到权限状态")
            browser.evaluate("document.querySelector('#browse-button').click()")
            browser.wait("document.querySelector('#entries').textContent.includes('preview.txt')")
            browser.evaluate("document.querySelector('#entries button').click()")
            browser.wait("document.querySelector('#preview')?.offsetHeight > 0")
            self.assertEqual(browser.evaluate("document.querySelector('#preview-content').textContent"), expected)
            browser.evaluate("document.querySelector('#lock').click()")
            browser.wait("document.querySelector('#workspace').hidden")
            self.assertEqual(browser.evaluate("document.querySelector('#preview-content').textContent"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
