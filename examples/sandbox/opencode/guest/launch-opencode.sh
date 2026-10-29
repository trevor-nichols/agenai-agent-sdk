#!/bin/sh
set -eu
[ "$(id -u)" -ne 0 ] || exit 64
[ "${HOME-}" = /home/sandbox ] || exit 64
[ "${OPENCODE_DB-}" = /home/sandbox/.agenai-credentials/opencode.db ] || exit 64
[ "$(pwd -P)" = /workspace/work ] || exit 64
[ ! -e "$OPENCODE_DB" ] && [ ! -L "$OPENCODE_DB" ] || exit 64
import_timeout=$1
shift
umask 077
if ! /usr/bin/timeout --signal=TERM --kill-after=1 "$import_timeout" /opt/agenai/native/opencode auth import --standalone /home/sandbox/.agenai-credentials/auth-export.json >/dev/null 2>&1; then
  printf '%s\n' 'Selected OpenCode credential import failed.' >&2
  exit 65
fi
rm /home/sandbox/.agenai-credentials/auth-export.json
exec /opt/agenai/native/opencode "$@"
