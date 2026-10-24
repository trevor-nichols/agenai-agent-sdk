#!/usr/bin/env bash
set -euo pipefail

# This operation is deliberately unavailable to local qualification runs.
if [[ "${SANDBOX_RUNNER_ENVIRONMENT:-}" != "github-hosted" || "${SANDBOX_RUNNER_OS:-}" != "Linux" || "${ImageOS:-}" != "ubuntu24" || "${RUNNER_ARCH:-}" != "X64" ]]; then
  echo 'Sandbox daemon provisioning requires the ephemeral GitHub-hosted Ubuntu 24.04 x64 runner.' >&2
  exit 1
fi
if [[ "$#" == 1 && "$1" == '--cleanup' ]]; then
  if [[ -z "${SANDBOX_CI_UNIT:-}" ]]; then exit 0; fi
  if [[ "${SANDBOX_CI_UNIT}" != "agenai-sdk-sandbox-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}" || "${SANDBOX_CI_ROOT:-}" != "${RUNNER_TEMP:?}/${SANDBOX_CI_UNIT}" ]]; then
    echo 'Refusing daemon cleanup without the exact ephemeral operation identity.' >&2
    exit 1
  fi
  sandbox_cleanup_status=0
  sudo journalctl --unit "${SANDBOX_CI_UNIT}" --no-pager > "${SANDBOX_CI_ROOT}/daemon.log" || sandbox_cleanup_status=$?
  if [[ "$(systemctl show "${SANDBOX_CI_UNIT}" --property LoadState --value)" != 'not-found' ]]; then
    sudo systemctl stop "${SANDBOX_CI_UNIT}" || sandbox_cleanup_status=$?
  fi
  if [[ -n "${SANDBOX_APPARMOR_USERNS_ORIGINAL:-}" ]]; then
    if [[ ! "${SANDBOX_APPARMOR_USERNS_ORIGINAL}" =~ ^[01]$ ]]; then
      echo 'Invalid recorded AppArmor namespace setting.' >&2
      sandbox_cleanup_status=1
    else
      sudo sysctl --write "kernel.apparmor_restrict_unprivileged_userns=${SANDBOX_APPARMOR_USERNS_ORIGINAL}" || sandbox_cleanup_status=$?
    fi
  fi
  exit "${sandbox_cleanup_status}"
fi
if [[ "$#" != 1 || "$1" != /* || -e "$1" || -z "${GITHUB_ENV:-}" ]]; then
  echo 'A new absolute operation directory and GITHUB_ENV are required.' >&2
  exit 1
fi

sandbox_root="$1"
sandbox_unit="agenai-sdk-sandbox-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
if [[ "${sandbox_root}" != "${RUNNER_TEMP:?}/${sandbox_unit}" ]]; then
  echo 'The daemon root must be the exact ephemeral operation directory.' >&2
  exit 1
fi
mkdir -m 700 -- "${sandbox_root}"
printf 'SANDBOX_CI_UNIT=%s\nSANDBOX_CI_ROOT=%s\nAGENAI_SANDBOX_CI_ENGINE=unix://%s/engine.sock\n' "${sandbox_unit}" "${sandbox_root}" "${sandbox_root}" >> "${GITHUB_ENV}"

# The complete packed-consumer graph also exercises native history fixtures.
if ! command -v bwrap > /dev/null || [[ "$(bwrap --help)" != *'--ro-bind-fd'* || "$(bwrap --help)" != *'--bind-fd'* ]]; then
  sudo apt-get update
  sudo apt-get install --yes --no-install-recommends bubblewrap
fi
sandbox_apparmor_original=$(sysctl --values kernel.apparmor_restrict_unprivileged_userns)
if [[ ! "${sandbox_apparmor_original}" =~ ^[01]$ ]]; then
  echo 'The runner must expose a known AppArmor namespace restriction.' >&2
  exit 1
fi
printf 'SANDBOX_APPARMOR_USERNS_ORIGINAL=%s\n' "${sandbox_apparmor_original}" >> "${GITHUB_ENV}"
if [[ "${sandbox_apparmor_original}" != 0 ]]; then
  sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
fi

# Fetch exact packages through Docker's signed apt repository without installing
# them into the host. The runtime component versions are retained by run-ci.mjs.
# https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository
mkdir -p "${sandbox_root}/apt/lists/partial" "${sandbox_root}/apt/cache/archives/partial" "${sandbox_root}/packages" "${sandbox_root}/tools"
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg --output "${sandbox_root}/apt/docker.asc"
printf 'deb [arch=amd64 signed-by=%s/apt/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' "${sandbox_root}" > "${sandbox_root}/apt/docker.list"
apt_options=(-o "Dir::Etc::sourcelist=${sandbox_root}/apt/docker.list" -o Dir::Etc::sourceparts=- -o "Dir::State::lists=${sandbox_root}/apt/lists" -o "Dir::Cache=${sandbox_root}/apt/cache" -o APT::Get::List-Cleanup=0)
apt-get "${apt_options[@]}" update
(
  cd "${sandbox_root}/packages"
  apt-get "${apt_options[@]}" download \
    'docker-ce=5:29.1.4-1~ubuntu.24.04~noble' \
    'docker-ce-cli=5:29.1.4-1~ubuntu.24.04~noble' \
    'containerd.io=2.2.2-1~ubuntu.24.04~noble'
  for sandbox_package in ./*.deb; do
    dpkg-deb --extract "${sandbox_package}" "${sandbox_root}/tools"
  done
)

# Avoid two daemons competing for host firewall rules on this disposable VM.
if systemctl is-active --quiet docker.service || systemctl is-active --quiet docker.socket; then
  sudo systemctl stop docker.service docker.socket
fi
printf '{}\n' > "${sandbox_root}/daemon.json"
sandbox_path="${sandbox_root}/tools/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
printf '%s\n' "${sandbox_root}/tools/usr/bin" >> "${GITHUB_PATH:?}"
sudo systemd-run --unit "${sandbox_unit}" --collect --property Delegate=yes --property KillMode=mixed \
  --setenv "PATH=${sandbox_path}" \
  "${sandbox_root}/tools/usr/bin/dockerd" \
  --config-file "${sandbox_root}/daemon.json" \
  --host "unix://${sandbox_root}/engine.sock" --group "$(id -gn)" \
  --data-root "${sandbox_root}/data" --exec-root "${sandbox_root}/exec" --pidfile "${sandbox_root}/engine.pid" \
  --bridge none --storage-driver overlayfs --feature containerd-snapshotter=true \
  --exec-opt native.cgroupdriver=systemd --default-cgroupns-mode private

for sandbox_attempt in {1..60}; do
  if "${sandbox_root}/tools/usr/bin/docker" --host "unix://${sandbox_root}/engine.sock" info > "${sandbox_root}/info.txt" 2> "${sandbox_root}/startup-error.txt"; then
    exit 0
  fi
  sleep 1
done
sudo journalctl --unit "${sandbox_unit}" --no-pager > "${sandbox_root}/daemon.log"
echo 'Owned sandbox daemon did not become ready.' >&2
exit 1
