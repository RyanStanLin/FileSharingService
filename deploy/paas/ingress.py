#!/usr/bin/env python3
"""Route this repository's WebSockets and file ports to its PaaS containers."""

from contextlib import closing
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading

ROUTE_FILE = Path("/var/lib/paas-routes/filesharing-wss.yml")
PAAS_DATABASE = "/var/lib/paas-runtime/state.db"
DOCKER = "/opt/personal-paas/docker/bin/docker"
APP_SUBNET = ipaddress.ip_network("172.30.253.0/28")


class RootlessPorts(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(f"/run/user/{os.getuid()}/dockerd-rootless/api.sock")


def port_request(method, suffix="", payload=None):
    with closing(RootlessPorts("rootlesskit", timeout=4)) as client:
        client.request(method, "/v1/ports" + suffix, json.dumps(payload) if payload else None,
                       {"Content-Type": "application/json"})
        response = client.getresponse()
        body = response.read()
        if not 200 <= response.status < 300:
            raise RuntimeError(f"RootlessKit {method} returned HTTP {response.status}")
        return json.loads(body) if body else None


def docker(*arguments):
    return subprocess.run(
        [DOCKER, "--host", f"unix:///run/user/{os.getuid()}/docker.sock", *arguments],
        check=True, capture_output=True, text=True, timeout=6,
    ).stdout.strip()


def server_address(repository_id):
    containers = docker(
        "ps", "-q", "--filter", "label=in.ryanl.paas.managed=true",
        "--filter", f"label=in.ryanl.paas.repository={repository_id}",
        "--filter", "label=in.ryanl.paas.service=server",
    ).split()
    if not containers:
        return None
    if len(containers) != 1:
        raise RuntimeError("More than one FileSharing backend is running")
    network = f"paas-{repository_id}"
    address = docker("inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}',
                     containers[0])
    if ipaddress.ip_address(address) not in APP_SUBNET:
        raise RuntimeError("The backend is outside the FileSharing Docker subnet")
    return address


def sync_ports(public_address, ports, backend):
    bound = {}
    for entry in port_request("GET") or []:
        spec = entry["spec"]
        port = spec["parentPort"]
        if not spec["proto"].startswith("tcp") or port not in ports:
            continue
        if spec.get("parentIP") not in (public_address, "", "0.0.0.0", "::"):
            continue
        if (spec.get("parentIP") != public_address or spec.get("childPort") != port or
                ipaddress.ip_address(spec.get("childIP") or "127.0.0.1") not in APP_SUBNET):
            raise RuntimeError(f"TCP {port} belongs to a different RootlessKit mapping")
        bound[port] = entry
    changes = 0
    for port, entry in bound.items():
        if entry["spec"]["childIP"] != backend:
            port_request("DELETE", "/" + str(entry["id"]))
            changes += 1
    if backend:
        for port in sorted(ports):
            if port not in bound or bound[port]["spec"]["childIP"] != backend:
                port_request("POST", payload={
                    "proto": "tcp", "parentIP": public_address, "parentPort": port,
                    "childIP": backend, "childPort": port,
                })
                changes += 1
    if changes:
        print(f"Reconciled {changes} FileSharing TCP mappings", flush=True)


def active_web_port(repository_id, container_port):
    with closing(sqlite3.connect(f"file:{PAAS_DATABASE}?mode=ro", uri=True, timeout=2)) as database:
        row = database.execute(
            "SELECT active FROM apps WHERE repo=? AND active<>'' "
            "AND NOT EXISTS (SELECT 1 FROM suspensions WHERE suspensions.repo=apps.repo)",
            (repository_id,),
        ).fetchone()
    if row is None:
        return None
    if not re.fullmatch(r"[a-f0-9]{64}", row[0]):
        raise RuntimeError("Invalid active FileSharing release ID")
    name = f"paas-{repository_id}-web-{row[0][:12]}"
    try:
        address = docker("port", name, f"{container_port}/tcp")
    except subprocess.CalledProcessError:
        return None
    match = re.fullmatch(r"127\.0\.0\.1:(\d+)", address)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise RuntimeError("The active frontend has no private loopback port")
    return int(match[1])


def sync_wss(domain, port):
    if port is None:
        ROUTE_FILE.unlink(missing_ok=True)
        return
    config = {"http": {
        "routers": {"filesharing-wss": {
            "rule": f"Host(\x60{domain}\x60) && HeaderRegexp(\x60Upgrade\x60, \x60(?i)^websocket$\x60)",
            "entryPoints": ["websecure"], "priority": 1000, "service": "filesharing-wss", "tls": {},
            "middlewares": ["headers"],
        }},
        "services": {"filesharing-wss": {
            "loadBalancer": {"servers": [{"url": f"http://127.0.0.1:{port}"}]},
        }},
    }}
    value = json.dumps(config, indent=2) + "\n"
    if ROUTE_FILE.is_file() and ROUTE_FILE.read_text() == value:
        return
    with tempfile.NamedTemporaryFile(mode="w", dir=ROUTE_FILE.parent, prefix=".filesharing-wss-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), 0o640)
            stream.write(value)
            stream.flush()
            os.replace(temporary, ROUTE_FILE)
        finally:
            temporary.unlink(missing_ok=True)
    print("Updated the FileSharing WebSocket route", flush=True)


def main():
    repository_id = int(sys.argv[1])
    config = json.loads(Path(sys.argv[2]).read_text())["services"]
    domain = config["web"]["domain"]
    if not re.fullmatch(r"[a-z0-9-]+\.ryanl\.in", domain):
        raise ValueError("Invalid FileSharing web domain")
    settings = config["server"]["environment"]
    address = str(ipaddress.IPv4Address(settings["FILESHARING__FTP__PASSIVEADDRESS"]))
    ftp = "FILESHARING__FTP__"
    ports = {int(settings[ftp + name]) for name in ("PLAINPORT", "EXPLICITPORT", "IMPLICITPORT")}
    ports.add(int(settings["FILESHARING__SFTP__PORT"]))
    ports.update(range(int(settings[ftp + "PASSIVEMIN"]), 1 + int(settings[ftp + "PASSIVEMAX"])))
    ports.discard(0)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    last_error = None
    while not stopped.is_set():
        try:
            sync_ports(address, ports, server_address(repository_id))
            sync_wss(domain, active_web_port(repository_id, config["web"]["port"]))
            last_error = None
        except (ValueError, RuntimeError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
            message = f"{type(error).__name__}: {error}"
            if message != last_error:
                print(message, file=sys.stderr, flush=True)
            last_error = message
        stopped.wait(2)
    sync_wss(domain, None)
    sync_ports(address, ports, None)


if __name__ == "__main__":
    main()
