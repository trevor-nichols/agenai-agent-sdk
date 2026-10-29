import { reserveSandboxCredentialProcess } from '@agen-ai/sandbox/node';
import type { Sandbox } from '@agen-ai/sandbox';
import { captureSandboxApiKey, captureSandboxRecipeFields, parseSandboxCliExecutable, sandboxNativeEgress } from '../credentials/index.js';
import { captureSandboxSavedCredential, readSandboxCredentialJson } from '../credentials/index.js';
import { selectGrokAccount } from './credentials.js';
import type { SandboxSavedCredential, SandboxApiKeyCredential, SandboxCredentialLineage } from '../credentials/index.js';

const keyDestinations = Object.freeze(['https://api.x.ai:443/v1/chat/completions', 'https://api.x.ai:443/v1/models',
  'https://api.x.ai:443/v1/api-key']);

export type SandboxGrokSavedCredential = SandboxSavedCredential<'auth_json', SandboxCredentialLineage>;
export type SandboxGrokCredential = SandboxApiKeyCredential | SandboxGrokSavedCredential;
export interface SandboxGrokInput<Credential extends SandboxGrokCredential = SandboxApiKeyCredential> {
  readonly credential: Credential;
  readonly guestExecutable: '/opt/agenai/native/grok';
  readonly signal?: AbortSignal;
}

/** Key calls remain synchronous; reading an explicitly selected account file is asynchronous. */
export function reserveSandboxGrok(sandbox: Sandbox, input: SandboxGrokInput<SandboxApiKeyCredential>): ReturnType<typeof launchGrok>;
export function reserveSandboxGrok(sandbox: Sandbox, input: SandboxGrokInput<SandboxGrokSavedCredential>): Promise<ReturnType<typeof launchGrok>>;
export function reserveSandboxGrok(sandbox: Sandbox, input: SandboxGrokInput<SandboxGrokCredential>): ReturnType<typeof launchGrok> | Promise<ReturnType<typeof launchGrok>>;
export function reserveSandboxGrok(sandbox: Sandbox, input: SandboxGrokInput<SandboxGrokCredential>) {
  const fields = captureSandboxRecipeFields(input, ['credential', 'guestExecutable'], ['signal']);
  const signal = fields.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Select an optional Grok cancellation signal.');
  const selected = captureSandboxRecipeFields(fields.credential, ['kind'], ['value', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']);
  const credential: SandboxGrokCredential = selected.kind === 'api_key'
    ? { kind: 'api_key', value: captureSandboxApiKey(selected) } : captureSandboxSavedCredential(selected, 'auth_json',
      selected.lineage === 'access_token_only' ? 'access_token_only' : 'caller_quiescent');
  const executable = parseSandboxCliExecutable(fields.guestExecutable);
  if (executable !== '/opt/agenai/native/grok' || sandbox.workspace !== '/workspace/work') {
    throw new TypeError('The prepared Grok layout does not match this recipe.');
  }
  const destinations = credential.kind === 'api_key' ? keyDestinations
    : Object.freeze(['https://cli-chat-proxy.grok.com:443', 'https://auth.x.ai:443']);
  const egress = sandboxNativeEgress(sandbox, destinations);
  signal?.throwIfAborted();
  if (credential.kind === 'api_key') return launchGrok(sandbox, credential, destinations, egress);
  return readSandboxCredentialJson(credential, (value) => selectGrokAccount(value, credential.lineage), signal).then((bytes) => {
    try { signal?.throwIfAborted(); return launchGrok(sandbox, { ...credential, bytes }, destinations, egress); }
    finally { bytes.fill(0); }
  });
}

function launchGrok(sandbox: Sandbox, credential: SandboxApiKeyCredential | (SandboxGrokSavedCredential & Readonly<{ bytes: Uint8Array }>),
  destinations: readonly string[], egress: Readonly<Record<string, string>>) {
  const key = credential.kind === 'api_key';
  const process = { executable: '/bin/sh',
    args: ['/opt/agenai/examples/grok/launch-grok.sh', ...(key ? [] : ['auth_json'])], cwd: sandbox.workspace,
    env: {
      HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data',
      XDG_CACHE_HOME: '/home/sandbox/cache', XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
      GROK_HOME: '/home/sandbox/grok',
      ...(credential.kind === 'api_key' ? { XAI_API_KEY: credential.value, GROK_XAI_API_BASE_URL: 'https://api.x.ai/v1' }
        : { GROK_AUTH_PATH: '/home/sandbox/.agenai-credentials/auth.json' }),
      GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: 'false', GROK_TRACE_UPLOAD: 'false', GROK_INSTRUMENTATION: 'disabled',
      GROK_FOLDER_TRUST: '0', GROK_AUTO_WAKE: '0', GROK_WORKER_THREADS: '1', GROK_SUBAGENT_WORKER_THREADS: '1',
      GROK_GIX_STATUS_THREADS: '1', RUST_LOG: 'error',
      GROK_CLAUDE_SKILLS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CLAUDE_AGENTS_ENABLED: '0',
      GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0', GROK_CURSOR_SKILLS_ENABLED: '0',
      GROK_CURSOR_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0',
      ...egress,
    } };
  const reservation = credential.kind === 'api_key' ? sandbox.reserveProcess(process) : reserveSandboxCredentialProcess(sandbox, {
    bootstrapExecutable: credential.bootstrapExecutable, preparationTimeoutMs: credential.preparationTimeoutMs,
    process, file: { name: 'auth.json', bytes: credential.bytes },
  });
  return Object.freeze({ reservation, preflight: Object.freeze({
    provider: 'grok', version: '1.0.62', revision: '1474f9cbdd91', transport: 'acp_schema_v1.23.0', credentialRoute: credential.kind,
    sourceKind: key ? 'explicit_api_key' : 'explicit_native_auth_file',
    refresh: credential.kind === 'api_key' ? 'not_applicable' : credential.lineage === 'access_token_only' ? 'disabled' : 'native_owned',
    nativeDestination: key ? 'XAI_API_KEY' : '/home/sandbox/.agenai-credentials/auth.json', model: 'grok-build-0.1',
    httpsDestinations: destinations, endpointEvidence: key ? 'observed_in_ms005_native_campaign' : 'pinned_native_synthetic_probe',
    nativeQualification: key ? 'recorded_linux_x64_and_desktop_native_arm64' : 'see_handoff_for_exact_route_and_platform_evidence', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  }) });
}
