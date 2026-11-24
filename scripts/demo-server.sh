#!/bin/bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/.local/demo"
assembly="$root/src/Server/bin/Release/net10.0/FileSharing.Server.dll"
origin=http://localhost:8847
web_origin="${FILESHARING_DEMO_WEB_ORIGIN:-$origin}"
mkdir -p "$state"
chmod 700 "$state"
pidfile="$state/server.pid"
configuration="$state/.env"
gateway_key_file="$state/gateway.key"
ftp_tls="$state/ftps-tls.pem"
ftp_certificate="$state/ftps-cert.pem"
control_ports=(8847 2121 2122 2990 2222)

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

registered_origin() {
    local pid process value
    pid="$(registered_pid)" || return 1
    process="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
    if [[ "$process" == *" --FileSharing:Origin="* ]]; then
        value="${process#* --FileSharing:Origin=}"
        printf '%s\n' "${value%% *}"
    else
        printf '%s\n' "$origin"
    fi
}

describe() {
    printf 'Demo: %s/demo\nDeployment secret: %s\n' "$(registered_origin)" "$configuration"
}

case "${1:-start}" in
    status)
        if registered_pid >/dev/null && healthy; then describe; else exit 1; fi
        ;;
    stop)
        if pid="$(registered_pid)"; then
            kill "$pid" 2>/dev/null || ! kill -0 "$pid" 2>/dev/null
            for _ in $(seq 1 160); do
                if ! registered_pid >/dev/null; then break; fi
                sleep 0.25
            done
            if registered_pid >/dev/null; then
                printf '%s\n' 'The demo is still shutting down. Check its status before restarting.' >&2
                exit 1
            fi
        fi
        rm -f "$pidfile"
        ;;
    start)
        if registered_pid >/dev/null && healthy; then
            if [ -n "${FILESHARING_DEMO_WEB_ORIGIN:-}" ] && [ "$(registered_origin)" != "$web_origin" ]; then
                printf 'The demo already uses %s. Stop it before changing its web origin.\n' "$(registered_origin)" >&2
                exit 1
            fi
            describe
            exit 0
        fi
        if registered_pid >/dev/null; then
            printf '%s\n' 'The demo process is running but has not become ready.' >&2
            exit 1
        fi
        for control_port in "${control_ports[@]}"; do
            if lsof -nP -iTCP:"$control_port" -sTCP:LISTEN -t >/dev/null 2>&1; then
                printf 'Port %s is already in use.\n' "$control_port" >&2
                exit 1
            fi
        done
        if [ ! -e "$configuration" ]; then
            (set -C; printf 'FILESHARING_BOOTSTRAP_SECRET=%s\n' "$(openssl rand -hex 32)" > "$configuration")
        fi
        IFS='=' read -r variable secret < "$configuration"
        if [ "$variable" != FILESHARING_BOOTSTRAP_SECRET ] || ! [[ "$secret" =~ ^[0-9a-f]{64}$ ]]; then
            printf '%s\n' 'The local demo deployment secret is invalid.' >&2
            exit 1
        fi
        if [ ! -e "$gateway_key_file" ]; then
            (set -C; openssl rand -hex 32 > "$gateway_key_file")
        fi
        IFS= read -r gateway_key < "$gateway_key_file"
        if ! [[ "$gateway_key" =~ ^[0-9a-f]{64}$ ]]; then
            printf '%s\n' 'The local gateway encryption key is invalid.' >&2
            exit 1
        fi
        if ! openssl x509 -in "$ftp_tls" -checkend 86400 -noout >/dev/null 2>&1; then
            tls_build="$(mktemp -d "$state/tls-build.XXXXXXXX")"
            trap 'rm -f "$tls_build/key.pem" "$tls_build/cert.pem" "$tls_build/tls.pem"; rmdir "$tls_build"' EXIT
            openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj /CN=localhost \
                -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
                -keyout "$tls_build/key.pem" -out "$tls_build/cert.pem" 2>"$state/ftps-certificate.log"
            cat "$tls_build/cert.pem" "$tls_build/key.pem" > "$tls_build/tls.pem"
            mv "$tls_build/tls.pem" "$ftp_tls"
        fi
        openssl x509 -in "$ftp_tls" -out "$ftp_certificate"
        (cd "$root/src/Sftp" && go build -mod=readonly -trimpath -o "$state/filesharing-sftp" .)
        dotnet build "$root/src/Server/FileSharing.Server.csproj" -c Release -p:RestoreLockedMode=true --nologo
        dotnetExecutable="$(command -v dotnet)"
        pid="$(
            ASPNETCORE_ENVIRONMENT=Development \
            ASPNETCORE_URLS=http://127.0.0.1:8847 \
            FileSharing__BootstrapSecret="$secret" \
            FileSharing__GatewayCredentialKey="$gateway_key" \
            FileSharing__EnableDemo=true \
            FileSharing__SshRelay__Enabled=true \
            FileSharing__KnownProxies= \
            FileSharing__BlockAgentWebSocket=false \
            FileSharing__Ftp__Bind=127.0.0.1 \
            FileSharing__Ftp__Host=localhost \
            FileSharing__Ftp__PlainClients=127.0.0.0/8 \
            FileSharing__Ftp__PlainPort=2121 \
            FileSharing__Ftp__ExplicitPort=2122 \
            FileSharing__Ftp__ImplicitPort=2990 \
            FileSharing__Ftp__Certificate="$ftp_tls" \
            FileSharing__Ftp__CertificateKey="$ftp_tls" \
            FileSharing__Ftp__PassiveAddress=127.0.0.1 \
            FileSharing__Sftp__Port=2222 \
            FileSharing__Sftp__BridgePort=8847 \
            FileSharing__Sftp__Binary="$state/filesharing-sftp" \
            python3 - "$dotnetExecutable" "$assembly" "$state" "$web_origin" <<'PROCESS'
from pathlib import Path
import subprocess
import sys

dotnet, assembly, state, origin = sys.argv[1:]
directory = Path(state)
with (directory / "server.log").open("ab") as log:
    process = subprocess.Popen([dotnet, assembly, f"--FileSharing:DataDirectory={directory / 'data'}",
                                f"--FileSharing:Origin={origin}"],
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
