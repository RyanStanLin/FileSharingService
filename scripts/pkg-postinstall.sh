#!/bin/bash
set -eu
[ "${3:-/}" = / ] || exit 0

daemon=/Library/LaunchDaemons/in.ryanl.filesharing.power.plist
agent=/Library/LaunchAgents/in.ryanl.filesharing.agent.plist
managedUser='MANAGED_USER'
if [ -n "$managedUser" ]; then
    uidNumber="$(id -u "$managedUser" 2>/dev/null || true)"
else
    uidNumber="$(stat -f %u /dev/console 2>/dev/null || true)"
fi
launchctl bootout system "$daemon" 2>/dev/null || true
launchctl bootstrap system "$daemon"

if [ -n "$uidNumber" ] && [ "$uidNumber" -ge 501 ] && launchctl print "gui/$uidNumber" >/dev/null 2>&1; then
    launchctl bootout "gui/$uidNumber" "$agent" 2>/dev/null || true
    launchctl bootstrap "gui/$uidNumber" "$agent"
fi
