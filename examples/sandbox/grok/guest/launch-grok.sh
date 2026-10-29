#!/bin/sh
# Fixed nonsecret preparation inside the one reserved process. No controller callbacks.
set -eu
[ "$#" -le 1 ] || exit 64
route=${1-api_key}
case "$route" in api_key|auth_json) ;; *) exit 64 ;; esac
[ "$(id -u)" -ne 0 ] || exit 64
[ "${HOME-}" = /home/sandbox ] || exit 64
[ "${GROK_HOME-}" = /home/sandbox/grok ] || exit 64
[ "$(pwd -P)" = /workspace/work ] || exit 64
previous_umask=$(umask)
umask 077
mkdir -m 700 /home/sandbox/grok
cat /opt/agenai/examples/grok/config.toml > /home/sandbox/grok/config.toml
case "$route" in
  api_key)
    [ -n "${XAI_API_KEY-}" ] && [ -z "${GROK_AUTH_PATH-}" ] || exit 64
    printf '\nbase_url = "https://api.x.ai/v1"\nenv_key = "XAI_API_KEY"\n' >> /home/sandbox/grok/config.toml
    ;;
  auth_json)
    [ -z "${XAI_API_KEY-}" ] && [ "${GROK_AUTH_PATH-}" = /home/sandbox/.agenai-credentials/auth.json ] || exit 64
    printf '\nbase_url = "https://cli-chat-proxy.grok.com/v1"\n' >> /home/sandbox/grok/config.toml
    ;;
esac
chmod 600 /home/sandbox/grok/config.toml
umask "$previous_umask"
exec /opt/agenai/native/grok agent --no-leader --model grok-build-0.1 stdio
