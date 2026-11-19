import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import time


APP = Path("/Applications/FileSharingService.app")
DEVICE_STATE = Path.home() / "Library/Application Support/FileSharingServiceDemo/enrollment.json"
DATABASE = Path(__file__).resolve().parents[1] / ".local/demo/data/filesharing.db"
SERVICE = f"gui/{os.getuid()}/in.ryanl.filesharing.agent"


def job_details():
    result = subprocess.run(["/bin/launchctl", "print", SERVICE], capture_output=True, text=True, timeout=8)
    details = {}
    for key, value in re.findall(r"^[ \t]+(state|parent bundle version|pid|last exit code) = (.+)$",
                                 result.stdout, re.MULTILINE):
        details.setdefault(key, value)
    return details


def server_details(device_id):
    with sqlite3.connect(DATABASE.as_uri() + "?mode=ro", uri=True, timeout=3) as db:
        row = db.execute(
            """SELECT d.LastSeen, s.Payload, (
                   SELECT e.Payload FROM Events e WHERE e.DeviceId = d.Id AND e.Topic = 'connection.changed'
                   ORDER BY e.Sequence DESC LIMIT 1
               )
               FROM Devices d LEFT JOIN Snapshots s ON s.DeviceId = d.Id AND s.Topic = 'agent'
               WHERE d.Id = ? AND d.Revoked IS NULL""",
            (device_id,),
        ).fetchone()
    if not row:
        return None, {}, {}
    return row[0], json.loads(row[1] or "{}"), json.loads(row[2] or "{}")


def live_link(job, build, version, server):
    last_seen, agent, presence = server
    if (job.get("state") == "running" and job.get("pid") and job.get("parent bundle version") == build
            and agent.get("version") == version and presence.get("online") and last_seen is not None
            and time.time() - last_seen < 45):
        return job["pid"], presence["connectionId"]
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--startup-timeout", type=float, default=90)
    parser.add_argument("--observe", type=float, default=60)
    args = parser.parse_args()
    with (APP / "Contents/Info.plist").open("rb") as info:
        bundle = plistlib.load(info)
    if bundle["FileSharingOrigin"] != "http://localhost:8847":
        raise SystemExit("The installed bundle must target the local demo server.")
    build = bundle["CFBundleVersion"]
    version = bundle["CFBundleShortVersionString"]
    deadline = time.monotonic() + args.startup_timeout
    while True:
        job = job_details()
        if DEVICE_STATE.exists():
            device_id = json.loads(DEVICE_STATE.read_text())["deviceId"]
            server = server_details(device_id)
            if link := live_link(job, build, version, server):
                break
        if time.monotonic() >= deadline:
            raise SystemExit(f"Installed {version} (build {build}) did not come online. launchd: {job}")
        time.sleep(2)

    pid, _ = link
    image = subprocess.run(["/usr/sbin/lsof", "-a", "-p", pid, "-d", "txt", "-Fn"],
                           capture_output=True, text=True, timeout=8, check=True).stdout
    binary = APP / "Contents/MacOS/FileSharingService"
    if not any(path in image.splitlines() for path in [f"n{binary}", f"n{binary.resolve()}"]):
        raise SystemExit(f"launchd PID {pid} did not load the installed executable.")
    print(f"Installed {version} registered with the server from launchd PID {pid}.", flush=True)
    start = server[0]
    deadline = time.monotonic() + args.observe
    while time.monotonic() < deadline:
        time.sleep(min(2, max(0, deadline - time.monotonic())))
        job = job_details()
        server = server_details(device_id)
        if live_link(job, build, version, server) != link:
            raise SystemExit(f"The installed service or server connection changed. launchd: {job}")
    if args.observe >= 15 and server[0] <= start:
        raise SystemExit("The server saw no heartbeat during the observation.")
    print(f"Same process and connection held for {args.observe:g} seconds.")


if __name__ == "__main__":
    main()
