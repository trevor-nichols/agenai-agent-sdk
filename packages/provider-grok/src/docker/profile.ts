import { createHash } from 'node:crypto';
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import type { DockerSandboxProfile } from '@agen-ai/sandbox-docker';
import type { GrokDockerApprovalIdentity } from '../types.js';
import type { GrokDockerApprovalProfile } from './contracts.js';
import { fields, invalid } from './data.js';

export const WORKSPACE = '/workspace/work';
export const GROK_HOME = '/opt/agenai/grok-home';
export const CLIENT = 'agenai-sdk-grok';
export const LAUNCHER = '/opt/agenai/bin/launch-grok';
export const BOOTSTRAP = '/opt/agenai/bin/agenai-credential-bootstrap';
export const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const PROCESS_ENV = Object.freeze({ HOME: '/home/sandbox', TMPDIR: '/tmp', PATH });
export const GRANT_SCOPE = `${GROK_HOME}/sessions/%2Fworkspace%2Fwork`;
export const NATIVE = Object.freeze({
  'linux-x64': Object.freeze({ sha256: 'b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a', size: 201655392 }),
  'desktop-apple-virtualization-native-arm64': Object.freeze({ sha256: 'b30eee14a656124ef3c9da8577b5e783ef2cffabeb2b679c5c49633e77eed574', size: 171935112 }),
});
export type GrokDockerProfile = keyof typeof NATIVE;

export function profile(value: unknown): GrokDockerProfile {
  if (value !== 'linux-x64' && value !== 'desktop-apple-virtualization-native-arm64') invalid();
  return value;
}

export function identity(value: unknown): GrokDockerApprovalIdentity {
  const input = fields(value, ['instanceId', 'nativeSessionId', 'policy']);
  const instanceId = parseAgentInstanceId(input.instanceId);
  if (typeof input.nativeSessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.nativeSessionId)
    || (input.policy !== 'host' && input.policy !== 'provider_auto_review' && input.policy !== 'provider_bypass')) invalid();
  return Object.freeze({ instanceId, nativeSessionId: input.nativeSessionId, policy: input.policy });
}

export interface ProfileArtifact { readonly path: string; readonly bytes: Uint8Array; readonly mode: number }
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export const EMPTY_DIRECTORIES = Object.freeze([
  `${GROK_HOME}/bundled`, `${GROK_HOME}/staged`, `${GROK_HOME}/hooks`, '/opt/agenai/home',
]);
export const ABSENCES = Object.freeze([
  '/etc/grok', '/etc/claude-code', '/usr/share/grok', '/root/.grok', '/root/.claude',
  '/home/node/.grok', '/home/node/.claude', '/home/sandbox/.grok', '/home/sandbox/.agenai-credentials',
  `${GROK_HOME}/staged/managed_config_refresh.json`,
]);

export function artifacts(input: GrokDockerApprovalProfile): readonly ProfileArtifact[] {
  const mode = input.policy === 'host' ? 'default' : input.policy === 'provider_auto_review' ? 'auto' : 'bypassPermissions';
  const profileText = `---\nname: agenai-shell-${input.policy}\ndescription: Restricted foreground shell coding agent\npermissionMode: ${mode}\ninjectDefaultTools: false\ndiscoverSkills: false\nagentsMd: false\nskills: []\ntools: [Bash]\ndisallowedTools: [search_tool, use_tool, Agent]\n---\nUse the configured foreground terminal tool for coding tasks.\n`;
  const launchFlags = input.policy === 'provider_bypass' ? 'agent --always-approve'
    : `--permission-mode ${mode} agent`;
  const environment = {
    HOME: '/opt/agenai/home', GROK_HOME, GROK_AUTH_PATH: '/home/sandbox/.agenai-credentials/auth.json',
    HTTPS_PROXY: 'http://127.0.0.1:3128', HTTP_PROXY: 'http://127.0.0.1:3128', NO_PROXY: '127.0.0.1,localhost',
    https_proxy: 'http://127.0.0.1:3128', http_proxy: 'http://127.0.0.1:3128', no_proxy: '127.0.0.1,localhost',
    TMPDIR: '/home/sandbox/tmp', PATH, SHELL: '/bin/sh', GROK_AUTO_PERMISSION_MODE: '1', GROK_FOLDER_TRUST: '1',
    GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: 'false', GROK_TRACE_UPLOAD: 'false',
    GROK_INSTRUMENTATION: 'disabled', GROK_FEEDBACK_ENABLED: 'false', GROK_MANAGED_CONFIG: '0',
    GROK_SESSION_REGISTRY: '0', GROK_RELAY_SYNC_ENABLED: '0', GROK_MANAGED_MCPS_ENABLED: '0',
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0', GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0',
    GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0', GROK_WEB_FETCH: '0', GROK_WORKFLOWS: '0',
    GROK_GOAL: '0', GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_AUTO_WAKE: '0', GROK_LSP_TOOLS: '0',
    GROK_LOG_FILE: '/home/sandbox/logs/native.log', RUST_LOG: 'info',
  };
  const launcher = `#!/bin/sh\nset -eu\n[ "$#" -eq 0 ] || exit 64\n[ "$(id -u)" -ne 0 ] || exit 64\n[ "\${HOME-}" = /home/sandbox ] || exit 64\n[ "$(pwd -P)" = ${WORKSPACE} ] || exit 64\ncase "$(cat /proc/sys/fs/suid_dumpable)" in 0|2) ;; *) exit 64 ;; esac\numask 077\nmkdir -m 700 /home/sandbox/session /home/sandbox/logs /home/sandbox/tmp\nexec /usr/bin/env -i ${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(' ')} /opt/agenai/bin/grok ${launchFlags} --no-leader --agent-profile ${GROK_HOME}/agenai-shell.md --model grok-4.6 --cli-chat-proxy-base-url https://cli-chat-proxy.grok.com --xai-api-base-url https://cli-chat-proxy.grok.com stdio\n`;
  const reviewer = '[auto_mode]\nenabled = true\nprompt_type = "full"\nclassifier_model = "grok-4.6"\nreasoning_effort = "low"\nclassify_timeout_ms = 60000\n';
  const config = `[features]\nremote_fetch = false\nmanaged_config = false\nsession_search = false\nturn_summary = false\nsession_recap = false\n[models]\ndefault = "grok-4.6"\nallowed_models = ["grok-4.6"]\nmax_retries = 0\n[model."grok-4.6"]\nmodel = "grok-4.6"\nbase_url = "https://cli-chat-proxy.grok.com/v1"\napi_base_url = "https://cli-chat-proxy.grok.com/v1"\napi_backend = "responses"\nagent_type = "grok-build"\ncontext_window = 256000\nsupports_reasoning_effort = true\nreasoning_effort = "high"\nsupports_backend_search = false\nmax_retries = 0\n${reviewer}[cli]\nuse_leader = false\nleader_enabled = false\nsession_registry = false\nauto_update = false\n[session]\nload_envrc = false\n[ui]\nremember_tool_approvals = false\n[subagents]\nenabled = false\n[goal]\nenabled = false\n[memory]\nenabled = false\n[relay]\nenabled = false\n[claude_compat]\nimported = true\n[managed_mcps]\nenabled = false\ngateway_tools_enabled = false\n[compat.claude]\nmcps = false\nhooks = false\n[compat.cursor]\nmcps = false\nhooks = false\n`;
  const grant = 'allowed_bash_commands = []\nallowed_bash_globs = []\nallowed_mcp_servers = []\nvalidated_mcp_server_grants_version = 1\n';
  const denyRules = (input.deniedBashPatterns ?? []).map((pattern) =>
    `[[permission.rules]]\naction = "deny"\ntool = "bash"\npattern = ${JSON.stringify(pattern)}\n`).join('');
  return Object.freeze([
    { path: '/opt/agenai/profile.json', bytes: Buffer.from(`${JSON.stringify({
      mapping: 'grok-build-1.0.77-controlled-shell-v1', nativeBuild: '50ca579fa996', clientIdentifier: CLIENT,
      instanceId: input.instanceId, nativeSessionId: input.nativeSessionId, policy: input.policy,
      workingDirectory: WORKSPACE, model: 'grok-4.6',
      ...(input.deniedBashPatterns === undefined ? {} : { deniedBashPatterns: input.deniedBashPatterns }),
    }, null, 2)}\n`), mode: 0o444 },
    { path: LAUNCHER, bytes: Buffer.from(launcher), mode: 0o555 },
    { path: `${GROK_HOME}/agenai-shell.md`, bytes: Buffer.from(profileText), mode: 0o444 },
    { path: `${GROK_HOME}/config.toml`, bytes: Buffer.from(config + denyRules), mode: 0o444 },
    { path: `${GROK_HOME}/requirements.toml`, bytes: Buffer.from(`allow_managed_hooks_only = true\nallowed_mcp_servers = []\nenable_all_project_mcp_servers = false\nplugin_auto_update = false\n[features]\nremote_fetch = false\nmanaged_config = false\n[managed_mcps]\nenabled = false\n${reviewer}`), mode: 0o444 },
    { path: `${GROK_HOME}/managed_config.toml`, bytes: Buffer.from('# Empty immutable managed defaults.\n'), mode: 0o444 },
    { path: `${GROK_HOME}/trusted_folders.toml`, bytes: Buffer.from('# Empty immutable trust store.\n'), mode: 0o444 },
    { path: `${GROK_HOME}/managed_config.lock`, bytes: Buffer.alloc(0), mode: 0o444 },
    { path: `${GRANT_SCOPE}/permission.toml`, bytes: Buffer.from(grant), mode: 0o444 },
    { path: `${GRANT_SCOPE}/permission_${CLIENT}.toml`, bytes: Buffer.from(grant), mode: 0o444 },
  ].map((entry) => Object.freeze(entry)));
}

export function nativePlatform(value: DockerSandboxProfile): 'linux/amd64' | 'linux/arm64' {
  return profile(value) === 'linux-x64' ? 'linux/amd64' : 'linux/arm64';
}
