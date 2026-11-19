#!/bin/bash
set -eu
app='/Applications/FileSharingService.app'
if [ ! -d "$app/Contents" ]; then
    printf '%s\n' '请先把 FileSharingService.app 拖进「应用程序」。'
    exit 1
fi
open "$app"
printf '%s\n' '如果 macOS 拦住首次打开，请在「系统设置 → 隐私与安全性」找到 FileSharingService，选择「仍要打开」。'
