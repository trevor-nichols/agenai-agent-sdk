#!/bin/sh
set -eu
[ "$(id -u)" -ne 0 ] || exit 64
[ "${HOME-}" = /home/sandbox ] || exit 64
[ "${XDG_CONFIG_HOME-}" = /home/sandbox/.agenai-credentials ] || exit 64
[ "${AGENT_CLI_CREDENTIAL_STORE-}" = file ] || exit 64
[ -z "${CURSOR_API_KEY-}" ] && [ -z "${CURSOR_AUTH_TOKEN-}" ] || exit 64
[ "$(pwd -P)" = /workspace/work ] || exit 64
previous_umask=$(umask)
umask 077
mkdir -m 700 /home/sandbox/.agenai-credentials/cursor
mv /home/sandbox/.agenai-credentials/auth.json /home/sandbox/.agenai-credentials/cursor/auth.json
umask "$previous_umask"
exec /opt/agenai/native/cursor-agent "$@"
