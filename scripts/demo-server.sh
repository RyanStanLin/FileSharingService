#!/bin/bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/.local/demo"
assembly="$root/src/Server/bin/Release/net10.0/FileSharing.Server.dll"
origin=http://localhost:8847
mkdir -p "$state"
chmod 700 "$state"
pidfile="$state/server.pid"
configuration="$state/.env"

registered_pid() {
    [ -f "$pidfile" ] || return 1
    local pid process
    read -r pid < "$pidfile" || return 1
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    process="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
    [[ "$process" == *"$assembly"* && "$process" == *"--FileSharing:DataDirectory=$state/data"* ]] || return 1
    printf '%s\n' "$pid"
}

healthy() {
    curl --noproxy '*' -fsS --max-time 2 "$origin/health/ready" >/dev/null 2>&1
}

describe() {
    printf 'Demo: %s/demo\nDeployment secret: %s\n' "$origin" "$configuration"
}

case "${1:-start}" in
    status)
        if registered_pid >/dev/null && healthy; then describe; else exit 1; fi
        ;;
    stop)
        if pid="$(registered_pid)"; then
            kill "$pid"
        fi
        rm -f "$pidfile"
        ;;
    start)
        if registered_pid >/dev/null && healthy; then describe; exit 0; fi
        if registered_pid >/dev/null || lsof -nP -iTCP:8847 -sTCP:LISTEN -t >/dev/null 2>&1; then
            printf '%s\n' 'Port 8847 is already in use.' >&2
            exit 1
        fi
        if [ ! -e "$configuration" ]; then
            (set -C; printf 'FILESHARING_BOOTSTRAP_SECRET=%s\n' "$(openssl rand -hex 32)" > "$configuration")
        fi
        IFS='=' read -r variable secret < "$configuration"
        if [ "$variable" != FILESHARING_BOOTSTRAP_SECRET ] || ! [[ "$secret" =~ ^[0-9a-f]{64}$ ]]; then
            printf '%s\n' 'The local demo deployment secret is invalid.' >&2
            exit 1
        fi
        dotnet build "$root/src/Server/FileSharing.Server.csproj" -c Release -p:RestoreLockedMode=true --nologo
        dotnetExecutable="$(command -v dotnet)"
        pid="$(
            ASPNETCORE_ENVIRONMENT=Development \
            ASPNETCORE_URLS=http://127.0.0.1:8847 \
            FileSharing__Origin="$origin" \
            FileSharing__BootstrapSecret="$secret" \
            FileSharing__EnableDemo=true \
            FileSharing__KnownProxies= \
            FileSharing__BlockAgentWebSocket=false \
            FileSharing__Ftp__PlainPort=0 \
            FileSharing__Ftp__ExplicitPort=0 \
            FileSharing__Ftp__ImplicitPort=0 \
            python3 - "$dotnetExecutable" "$assembly" "$state" <<'PROCESS'
from pathlib import Path
import subprocess
import sys

dotnet, assembly, state = sys.argv[1:]
directory = Path(state)
with (directory / "server.log").open("ab") as log:
    process = subprocess.Popen([dotnet, assembly, f"--FileSharing:DataDirectory={directory / 'data'}"],
                               cwd=directory, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                               start_new_session=True)
print(process.pid)
PROCESS
        )"
        printf '%s\n' "$pid" > "$pidfile"
        for _ in $(seq 1 60); do
            if registered_pid >/dev/null && healthy; then describe; exit 0; fi
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.2
        done
        printf 'Server failed to start. Log: %s\n' "$state/server.log" >&2
        exit 1
        ;;
    *)
        printf '%s\n' 'Usage: scripts/demo-server.sh start|status|stop' >&2
        exit 1
        ;;
esac
