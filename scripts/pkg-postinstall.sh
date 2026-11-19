#!/bin/bash
set -eu
[ "${3:-/}" = / ] || exit 0

daemon=/Library/LaunchDaemons/in.ryanl.filesharing.power.plist
agent=/Library/LaunchAgents/in.ryanl.filesharing.agent.plist
uidNumber="$(id -u MANAGED_USER 2>/dev/null || true)"
launchctl bootout system "$daemon" 2>/dev/null || true
launchctl bootstrap system "$daemon"

if [ -n "$uidNumber" ] && launchctl print "gui/$uidNumber" >/dev/null 2>&1; then
    launchctl bootout "gui/$uidNumber" "$agent" 2>/dev/null || true
    launchctl bootstrap "gui/$uidNumber" "$agent"
fi
