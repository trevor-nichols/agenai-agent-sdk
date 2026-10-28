import type { Sandbox } from '@agen-ai/sandbox';
import { captureSandboxApiKey, captureSandboxRecipeFields, parseSandboxCliExecutable, sandboxNativeEgress } from '../credentials/index.js';
import type { SandboxApiKeyCredential } from '../credentials/index.js';

const destinations = Object.freeze(['https://api.x.ai:443/v1/chat/completions', 'https://api.x.ai:443/v1/models',
  'https://api.x.ai:443/v1/api-key']);

export interface SandboxGrokInput {
  readonly credential: SandboxApiKeyCredential;
  readonly guestExecutable: '/opt/agenai/native/grok';
}

/** The fixed guest launcher creates nonsecret model config, then execs this exact native tuple. */
export function reserveSandboxGrok(sandbox: Sandbox, input: SandboxGrokInput) {
  const fields = captureSandboxRecipeFields(input, ['credential', 'guestExecutable']);
  const key = captureSandboxApiKey(fields.credential);
  const executable = parseSandboxCliExecutable(fields.guestExecutable);
  if (executable !== '/opt/agenai/native/grok' || sandbox.workspace !== '/workspace/work') {
    throw new TypeError('The prepared Grok layout does not match this recipe.');
  }
  const egress = sandboxNativeEgress(sandbox, destinations);
  const reservation = sandbox.reserveProcess({ executable: '/bin/sh',
    args: ['/opt/agenai/examples/grok/launch-grok.sh'], cwd: sandbox.workspace,
    env: {
      HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data',
      XDG_CACHE_HOME: '/home/sandbox/cache', XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
      XAI_API_KEY: key, GROK_HOME: '/home/sandbox/grok', GROK_XAI_API_BASE_URL: 'https://api.x.ai/v1',
      GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: 'false', GROK_TRACE_UPLOAD: 'false', GROK_INSTRUMENTATION: 'disabled',
      GROK_FOLDER_TRUST: '0', GROK_AUTO_WAKE: '0', GROK_WORKER_THREADS: '1', GROK_SUBAGENT_WORKER_THREADS: '1',
      GROK_GIX_STATUS_THREADS: '1', RUST_LOG: 'error',
      GROK_CLAUDE_SKILLS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CLAUDE_AGENTS_ENABLED: '0',
      GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0', GROK_CURSOR_SKILLS_ENABLED: '0',
      GROK_CURSOR_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0',
      ...egress,
    } });
  return Object.freeze({ reservation, preflight: Object.freeze({
    provider: 'grok', version: '1.0.62', revision: '1474f9cbdd91', transport: 'acp_schema_v1.23.0', credentialRoute: 'api_key',
    sourceKind: 'explicit_api_key', nativeDestination: 'XAI_API_KEY', model: 'grok-build-0.1',
    httpsDestinations: destinations, endpointEvidence: 'observed_in_ms005_native_campaign',
    nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  }) });
}
