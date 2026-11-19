#!/bin/bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.local" "$root/artifacts"
stage="$(mktemp -d "$root/.local/agent-build.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
mode="${1:-test}"
target=15.0

if [ "$mode" = test ]; then
    swiftc -swift-version 5 -O -target "$(uname -m)-apple-macosx$target" -D FILESHARING_TEST \
        "$root"/src/Mac/*.swift -o "$stage/FileSharingAgent.loopback"
    mv "$stage/FileSharingAgent.loopback" "$root/artifacts/FileSharingAgent.loopback"
    exit 0
fi

case "$mode" in check|package) ;; *) printf '%s\n' 'Usage: scripts/build-agent.sh test|check|package' >&2; exit 1;; esac

python3 - "$stage/BuildIdentity.swift" "$mode" <<'PY'
import json
import os
from pathlib import Path
import re
import secrets
import sys
from urllib.parse import urlsplit

release = sys.argv[2] == "package"
primary = os.environ.get("FILESHARING_ORIGIN", "" if release else "https://filesharing.example.com")
origins = [primary]
if backup := os.environ.get("FILESHARING_BACKUP_ORIGIN"):
    origins.append(backup)
for origin in origins:
    parsed = urlsplit(origin)
    if any(not 32 < ord(char) < 127 for char in origin) or parsed.scheme != "https" or not parsed.hostname or (
        parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment
    ):
        raise SystemExit("Every endpoint must be an HTTPS origin.")
user = os.environ.get("FILESHARING_MANAGED_USER", "" if release else "filesharing-test")
if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_-]{0,62}", user):
    raise SystemExit("Set FILESHARING_MANAGED_USER to the dedicated macOS account name.")
token = Path(os.environ["FILESHARING_ACTIVATION_FILE"]).read_text().strip() if release else secrets.token_urlsafe(32)
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
    raise SystemExit("A per-device activation code file is required.")
writable = os.environ.get("FILESHARING_ALLOW_HOME_WRITE", "0")
if writable not in ("0", "1"):
    raise SystemExit("FILESHARING_ALLOW_HOME_WRITE must be 0 or 1.")
Path(sys.argv[1]).write_text(
    "enum BuildIdentity {\n"
    f"    static let originStrings = {json.dumps(origins)}\n"
    f"    static let activation = {json.dumps(token)}\n"
    f"    static let user = {json.dumps(user)}\n"
    f"    static let homeWritable = {str(writable == '1').lower()}\n"
    "}\n"
)
PY

app="$stage/payload/Applications/FileSharingAgent.app"
mac="$app/Contents/MacOS"
helper="$stage/payload/Library/PrivilegedHelperTools"
agent_plists="$stage/payload/Library/LaunchAgents"
daemon_plists="$stage/payload/Library/LaunchDaemons"
mkdir -p "$mac" "$helper" "$agent_plists" "$daemon_plists"
chmod 755 "$stage/payload" "$stage/payload/Applications" "$app" "$app/Contents" "$mac" "$stage/payload/Library" "$helper" "$agent_plists" "$daemon_plists"
install -m 644 "$root/src/Mac/Info.plist" "$app/Contents/Info.plist"
install -m 644 "$root/src/Mac/in.ryanl.filesharing.agent.plist" "$agent_plists/in.ryanl.filesharing.agent.plist"

for arch in arm64 x86_64; do
    swiftc -swift-version 5 -O -target "$arch-apple-macosx$target" "$root"/src/Mac/*.swift "$stage/BuildIdentity.swift" \
        -o "$stage/agent.$arch"
    swiftc -swift-version 5 -O -target "$arch-apple-macosx$target" -parse-as-library "$root/src/Power/Main.swift" -o "$stage/power.$arch"
done

lipo -create "$stage/agent.arm64" "$stage/agent.x86_64" -output "$mac/FileSharingAgent"
chmod 755 "$mac/FileSharingAgent"
power="$helper/in.ryanl.filesharing.power"
lipo -create "$stage/power.arm64" "$stage/power.x86_64" -output "$power"
chmod 755 "$power"
for arch in arm64 x86_64; do
    lipo "$mac/FileSharingAgent" -verify_arch "$arch"
    lipo "$power" -verify_arch "$arch"
done
plutil -lint "$app/Contents/Info.plist" "$agent_plists/in.ryanl.filesharing.agent.plist" "$root/src/Power/launchd.plist"

user="${FILESHARING_MANAGED_USER:-filesharing-test}"
daemon="$daemon_plists/in.ryanl.filesharing.power.plist"
sed "s/MANAGED_USER/$user/g" "$root/src/Power/launchd.plist" > "$daemon"
chmod 644 "$daemon"
plutil -lint "$daemon"
mkdir -p "$stage/scripts"
sed "s/MANAGED_USER/$user/g" "$root/scripts/pkg-postinstall.sh" > "$stage/scripts/postinstall"
chmod 755 "$stage/scripts/postinstall"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
pkg="$stage/FileSharingAgent-$version.pkg"
components="$stage/components.plist"
python3 - "$components" <<'PLIST'
import plistlib
import sys

with open(sys.argv[1], "wb") as output:
    plistlib.dump([{
        "RootRelativeBundlePath": "Applications/FileSharingAgent.app",
        "BundleIsRelocatable": False,
        "BundleIsVersionChecked": True,
        "BundleHasStrictIdentifier": True,
        "BundleOverwriteAction": "upgrade",
    }], output)
PLIST
layout=(--root "$stage/payload" --component-plist "$components" --ownership recommended --scripts "$stage/scripts"
        --identifier in.ryanl.filesharing.agent.pkg --version "$version" --install-location /)

if [ "$mode" = check ]; then
    "$mac/FileSharingAgent" version
    pkgbuild "${layout[@]}" "$pkg"
    pkgutil --payload-files "$pkg" > "$stage/manifest"
    for expected in Applications/FileSharingAgent.app/Contents/MacOS/FileSharingAgent \
        Library/LaunchDaemons/in.ryanl.filesharing.power.plist Library/LaunchAgents/in.ryanl.filesharing.agent.plist \
        Library/PrivilegedHelperTools/in.ryanl.filesharing.power; do
        rg --fixed-strings "$expected" "$stage/manifest"
    done
    exit 0
fi

: "${FILESHARING_DEVELOPER_ID_APPLICATION:?Developer ID Application is required}"
: "${FILESHARING_DEVELOPER_ID_INSTALLER:?Developer ID Installer is required}"
: "${FILESHARING_NOTARY_PROFILE:?Notarytool keychain profile is required}"
codesign --force --options runtime --timestamp --sign "$FILESHARING_DEVELOPER_ID_APPLICATION" "$app"
codesign --force --options runtime --timestamp --sign "$FILESHARING_DEVELOPER_ID_APPLICATION" "$power"
codesign --verify --strict --verbose=2 "$app"
codesign --verify --strict --verbose=2 "$power"
pkgbuild "${layout[@]}" --sign "$FILESHARING_DEVELOPER_ID_INSTALLER" "$pkg"
xcrun notarytool submit "$pkg" --keychain-profile "$FILESHARING_NOTARY_PROFILE" --wait
xcrun stapler staple "$pkg"
xcrun stapler validate "$pkg"
pkgutil --check-signature "$pkg"
mv "$pkg" "$root/artifacts/FileSharingAgent-$version-$user.pkg"
