#!/bin/bash
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
dotnet build -p:RestoreLockedMode=true --nologo
scripts/build-agent.sh test
python3 tests/integration.py "$@"
