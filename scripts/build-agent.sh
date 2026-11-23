#!/bin/bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.local" "$root/artifacts"
stage="$(mktemp -d "$root/.local/agent-build.XXXXXXXX")"
mount=""
cleanup() {
    if [ -n "$mount" ]; then
        diskutil eject "$mount" >/dev/null 2>&1 || return
    fi
    rm -rf "$stage"
}
trap cleanup EXIT
mode="${1:-dmg}"

if [ "$mode" = test ]; then
    swiftc -swift-version 5 -O -target "$(uname -m)-apple-macosx15.0" -D FILESHARING_TEST \
        "$root"/src/Mac/*.swift -o "$stage/FileSharingAgent.loopback"
    mv "$stage/FileSharingAgent.loopback" "$root/artifacts/FileSharingAgent.loopback"
    exit 0
fi

case "$mode" in check|dmg) ;; *) printf '%s\n' 'Usage: scripts/build-agent.sh test|check|dmg' >&2; exit 1;; esac

origin="${FILESHARING_ORIGIN:-http://localhost:8847}"
backup="${FILESHARING_BACKUP_ORIGIN:-}"
user="${FILESHARING_MANAGED_USER:-}"
writable="${FILESHARING_ALLOW_HOME_WRITE:-YES}"
python3 - "$origin" "$backup" "$user" "$writable" <<'PY'
import re
import sys
from urllib.parse import urlsplit

origin, backup, user, writable = sys.argv[1:]
for value in filter(None, (origin, backup)):
    url = urlsplit(value)
    if any(not 32 < ord(char) < 127 for char in value) or not url.hostname or url.username or url.password or (
        url.scheme != "https" and not (url.scheme == "http" and url.hostname == "localhost")
    ) or url.path not in ("", "/") or url.query or url.fragment:
        raise SystemExit("Use an HTTPS server origin, or HTTP with localhost.")
if backup and (urlsplit(origin).hostname == "localhost") != (urlsplit(backup).hostname == "localhost"):
    raise SystemExit("Use the same local or remote mode for both origins.")
if user and not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_-]{0,62}", user):
    raise SystemExit("Use a valid optional managed macOS account name.")
if writable not in ("YES", "NO"):
    raise SystemExit("FILESHARING_ALLOW_HOME_WRITE must be YES or NO.")
PY

xcodebuild -project "$root/FileSharingService.xcodeproj" -scheme FileSharingService -configuration Release \
    -destination 'generic/platform=macOS' -derivedDataPath "$stage/DerivedData" -quiet \
    'ARCHS=arm64 x86_64' ONLY_ACTIVE_ARCH=NO \
    FILESHARING_ORIGIN="$origin" FILESHARING_BACKUP_ORIGIN="$backup" FILESHARING_MANAGED_USER="$user" \
    FILESHARING_ALLOW_HOME_WRITE="$writable"

app="$stage/DerivedData/Build/Products/Release/FileSharingService.app"
verify_app() {
    local bundle="$1"
    local binary="$bundle/Contents/MacOS/FileSharingService"
    local plist="$bundle/Contents/Library/LaunchAgents/in.ryanl.filesharing.agent.plist"
    lipo "$binary" -verify_arch arm64
    lipo "$binary" -verify_arch x86_64
    plutil -lint "$bundle/Contents/Info.plist" "$plist"
    codesign --verify --strict "$bundle"
    test "$(/usr/libexec/PlistBuddy -c 'Print :FileSharingOrigin' "$bundle/Contents/Info.plist")" = "$origin"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$bundle/Contents/Info.plist")" = FileSharing
    test -s "$bundle/Contents/Resources/FileSharing.icns"
    test -s "$bundle/Contents/Resources/Assets.car"
    test "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist")" = in.ryanl.filesharing.agent
    test "$(/usr/libexec/PlistBuddy -c 'Print :BundleProgram' "$plist")" = Contents/MacOS/FileSharingService
    test "$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$plist")" = true
    test "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")" = FileSharingService
    test "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist")" = run
    test -x "$binary"
}

if [ "$mode" = check ]; then
    verify_app "$app"
    exit 0
fi

payload="$stage/volume"
mkdir -p "$payload" "$stage/mount"
ditto "$app" "$payload/FileSharingService.app"
ln -s /Applications "$payload/Applications"
install -m 755 "$root/scripts/open-installed-app.command" "$payload/Open FileSharingService.command"
cat > "$payload/安装说明.txt" <<'TEXT'
1. 将 FileSharingService 拖进 Applications。
2. 双击 Open FileSharingService.command，或从 Applications 打开 FileSharingService。
3. macOS 如拦截首次打开，在「系统设置 → 隐私与安全性」选择「仍要打开」。
4. 首次启动会注册后台服务。系统要求确认时，请在「登录项与扩展」允许 FileSharingService。
5. 再次打开 App 可以查看状态或停用后台服务。
TEXT

image="$stage/FileSharingService.dmg"
hdiutil create -quiet -volname FileSharingService -srcfolder "$payload" -format UDZO -fs HFS+ "$image"
hdiutil verify -quiet "$image"
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$stage/mount" "$image"
mount="$stage/mount"
verify_app "$mount/FileSharingService.app"
test "$(readlink "$mount/Applications")" = /Applications
test -x "$mount/Open FileSharingService.command"
diskutil eject "$mount" >/dev/null
mount=""
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
name="FileSharingService-$version.dmg"
mv "$image" "$root/artifacts/$name"
cd "$root/artifacts"
shasum -a 256 "$name" > "$name.sha256"
printf '%s\n' "$root/artifacts/$name"
