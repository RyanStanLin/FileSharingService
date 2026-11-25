#!/bin/bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-dmg}"
case "$mode" in test|check|dmg) ;; *) printf '%s\n' 'Usage: scripts/build-agent.sh test|check|dmg [expected-version]' >&2; exit 1;; esac

settings="$root/src/MacApp/Build.xcconfig"
build_setting() {
    awk -v key="$1" '$1 == key && $2 == "=" { print $3 }' "$settings"
}
minimum_macos="$(build_setting MACOSX_DEPLOYMENT_TARGET)"
version="$(build_setting MARKETING_VERSION)"
build_number="$(build_setting CURRENT_PROJECT_VERSION)"
: "${minimum_macos:?Missing MACOSX_DEPLOYMENT_TARGET in $settings}"
: "${version:?Missing MARKETING_VERSION in $settings}"
: "${build_number:?Missing CURRENT_PROJECT_VERSION in $settings}"
if [ "${2:-$version}" != "$version" ]; then
    printf 'Release tag v%s requires app version %s, but Build.xcconfig specifies %s.\n' "$2" "$2" "$version" >&2
    exit 1
fi

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

if [ "$mode" = test ]; then
    swiftc -swift-version 5 -O -target "$(uname -m)-apple-macosx$minimum_macos" -D FILESHARING_TEST \
        "$root"/src/Mac/*.swift -o "$stage/FileSharingAgent.loopback"
    mv "$stage/FileSharingAgent.loopback" "$root/artifacts/FileSharingAgent.loopback"
    exit 0
fi

origin="${FILESHARING_ORIGIN:-https://filesharing.ryanl.in}"
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
    local info="$bundle/Contents/Info.plist"
    local plist="$bundle/Contents/Library/LaunchAgents/in.ryanl.filesharing.agent.plist"
    local arch binary_minimum
    if [ ! -x "$binary" ]; then
        printf 'App executable is missing or cannot be executed at %s.\n' "$binary" >&2
        return 1
    fi
    for arch in arm64 x86_64; do
        lipo "$binary" -verify_arch "$arch"
        binary_minimum="$(xcrun vtool -arch "$arch" -show-build "$binary" | awk '$1 == "minos" { print $2 }')"
        if [ "$binary_minimum" != "$minimum_macos" ]; then
            printf 'The %s binary requires macOS %s. Expected macOS %s.\n' "$arch" "$binary_minimum" "$minimum_macos" >&2
            return 1
        fi
    done
    plutil -lint "$info" "$plist"
    codesign --verify --strict "$bundle"
    if [ "$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$info")" != "$minimum_macos" ]; then
        printf 'The app Info.plist must specify macOS %s as the minimum system version.\n' "$minimum_macos" >&2
        return 1
    fi
    if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info")" != "$version" ] ||
        [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$info")" != "$build_number" ]; then
        printf 'The app Info.plist must specify version %s and build %s.\n' "$version" "$build_number" >&2
        return 1
    fi
    test "$("$binary" version)" = "$version"
    test "$(/usr/libexec/PlistBuddy -c 'Print :FileSharingOrigin' "$info")" = "$origin"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$info")" = FileSharing
    test -s "$bundle/Contents/Resources/FileSharing.icns"
    test -s "$bundle/Contents/Resources/Assets.car"
    test "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist")" = in.ryanl.filesharing.agent
    test "$(/usr/libexec/PlistBuddy -c 'Print :BundleProgram' "$plist")" = Contents/MacOS/FileSharingService
    test "$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$plist")" = true
    test "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")" = FileSharingService
    test "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist")" = run
}

verify_app "$app"
if [ "$mode" = check ]; then
    exit 0
fi

payload="$stage/volume"
mkdir -p "$payload"
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
printf '%s\n' 'xattr -dr com.apple.quarantine' > "$payload/xattr.txt"

image="$stage/FileSharingService.dmg"
hdiutil create -quiet -volname FileSharingService -srcfolder "$payload" -format UDZO -fs HFS+ "$image"
hdiutil verify -quiet "$image"
mount="$(hdiutil attach -readonly -nobrowse -mountrandom "$stage" -plist "$image" | python3 -c '
import plistlib
import sys

entities = plistlib.loads(sys.stdin.buffer.read())["system-entities"]
mounts = [entity["mount-point"] for entity in entities if "mount-point" in entity]
if len(mounts) != 1:
    raise SystemExit("Expected one mounted volume in the DMG.")
print(mounts[0])
')"
for ((attempt = 0; attempt < 5; attempt++)); do
    if [ -x "$mount/FileSharingService.app/Contents/MacOS/FileSharingService" ]; then
        break
    fi
    sleep 1
done
verify_app "$mount/FileSharingService.app"
test "$(readlink "$mount/Applications")" = /Applications
test -x "$mount/Open FileSharingService.command"
printf '%s\n' 'xattr -dr com.apple.quarantine' | cmp - "$mount/xattr.txt"
diskutil eject "$mount" >/dev/null
mount=""
name="FileSharingService-$version.dmg"
mv "$image" "$root/artifacts/$name"
cd "$root/artifacts"
shasum -a 256 "$name" > "$name.sha256"
printf '%s\n' "$root/artifacts/$name"
