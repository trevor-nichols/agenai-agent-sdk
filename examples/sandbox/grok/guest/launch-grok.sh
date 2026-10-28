#!/bin/sh
# Fixed nonsecret preparation inside the one reserved process. No controller callbacks.
set -eu
[ "$#" -eq 0 ] || exit 64
[ "$(id -u)" -ne 0 ] || exit 64
[ "${HOME-}" = /home/sandbox ] || exit 64
[ "${GROK_HOME-}" = /home/sandbox/grok ] || exit 64
[ "$(pwd -P)" = /workspace/work ] || exit 64
previous_umask=$(umask)
umask 077
mkdir -m 700 /home/sandbox/grok
cat /opt/agenai/examples/grok/config.toml > /home/sandbox/grok/config.toml
chmod 600 /home/sandbox/grok/config.toml
umask "$previous_umask"
exec /opt/agenai/native/grok agent --no-leader --model grok-build-0.1 stdio
