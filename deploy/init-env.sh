#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
if [ -e .env ] || [ -L .env ]; then
    printf '%s\n' 'Using the existing deployment .env'
    exit 0
fi
candidate="$(mktemp .env.XXXXXXXX)"
trap 'rm -f "$candidate"' EXIT
cat .env.example > "$candidate"
printf 'FILESHARING_BOOTSTRAP_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$candidate"
printf 'FILESHARING_GATEWAY_KEY=%s\n' "$(openssl rand -hex 32)" >> "$candidate"
chmod 600 "$candidate"
ln "$candidate" .env
printf '%s\n' 'Created deploy/.env'
