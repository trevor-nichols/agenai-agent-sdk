import { reserveSandboxCredentialProcess } from '@agen-ai/sandbox/node';
import type { Sandbox } from '@agen-ai/sandbox';
import { captureSandboxCredentialValue, captureSandboxSavedCredential, readSandboxCredentialJson, captureSandboxRecipeFields, parseSandboxCliExecutable, parseSandboxCliPrompt, sandboxNativeEgress } from '../credentials/index.js';
import { selectCursorAccount } from './credentials.js';
import type { SandboxApiKeyCredential, SandboxSavedCredential } from '../credentials/index.js';

// The native campaign observed api.cursor.com alongside the documented API hosts.
const destinations = Object.freeze(['api.cursor.com', 'api2.cursor.sh', 'api5.cursor.sh', 'agent.api5.cursor.sh', 'agentn.api5.cursor.sh',
  'agent.us.api5.cursor.sh', 'agentn.us.api5.cursor.sh', 'agent.global.api5.cursor.sh', 'agentn.global.api5.cursor.sh']
  .map((host) => `https://${host}:443`));

export type SandboxCursorToken = Readonly<{ kind: 'auth_token'; value: string }>;
export type SandboxCursorCredential = SandboxApiKeyCredential | SandboxCursorToken | SandboxSavedCredential;
export interface SandboxCursorInput<Credential extends SandboxCursorCredential = SandboxApiKeyCredential> {
  readonly credential: Credential;
  readonly guestExecutable: '/opt/agenai/native/cursor-agent';
  /** Caller-selected account-admitted model. There is no automatic choice or fallback. */
  readonly model: string;
  /** Bounded nonsecret prompt text, passed as one native operand after `--`; never a shell fragment or option. */
  readonly task: string;
  readonly signal?: AbortSignal;
}

/** Existing inline callers remain synchronous; saved-file preparation is asynchronous. */
export function reserveSandboxCursor(sandbox: Sandbox, input: SandboxCursorInput<SandboxApiKeyCredential | SandboxCursorToken>): ReturnType<typeof launchCursor>;
export function reserveSandboxCursor(sandbox: Sandbox, input: SandboxCursorInput<SandboxSavedCredential>): Promise<ReturnType<typeof launchCursor>>;
export function reserveSandboxCursor(sandbox: Sandbox, input: SandboxCursorInput<SandboxCursorCredential>): ReturnType<typeof launchCursor> | Promise<ReturnType<typeof launchCursor>>;
export function reserveSandboxCursor(sandbox: Sandbox, input: SandboxCursorInput<SandboxCursorCredential>) {
  const fields = captureSandboxRecipeFields(input, ['credential', 'guestExecutable', 'model', 'task'], ['signal']);
  const selected = captureSandboxRecipeFields(fields.credential, ['kind'], ['value', 'path', 'lineage', 'bootstrapExecutable', 'preparationTimeoutMs']);
  const credential: SandboxCursorCredential = selected.kind === 'api_key' || selected.kind === 'auth_token'
    ? { kind: selected.kind, value: captureSandboxCredentialValue(selected, selected.kind) } : captureSandboxSavedCredential(selected, 'auth_json');
  const signal = fields.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Select an optional Cursor cancellation signal.');
  const executable = parseSandboxCliExecutable(fields.guestExecutable);
  const task = parseSandboxCliPrompt(fields.task);
  const model = fields.model;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(model) || model.toLowerCase() === 'auto') {
    throw new TypeError('Select one explicit bounded Cursor model.');
  }
  if (executable !== '/opt/agenai/native/cursor-agent' || sandbox.workspace !== '/workspace/work') {
    throw new TypeError('The prepared Cursor layout does not match this recipe.');
  }
  const egress = sandboxNativeEgress(sandbox, destinations);
  signal?.throwIfAborted();
  if (credential.kind !== 'auth_json') return launchCursor(sandbox, credential, model, task, egress);
  return readSandboxCredentialJson(credential, selectCursorAccount, signal).then((bytes) => {
    try { signal?.throwIfAborted(); return launchCursor(sandbox, { ...credential, bytes }, model, task, egress); }
    finally { bytes.fill(0); }
  });
}

function launchCursor(sandbox: Sandbox,
  credential: SandboxApiKeyCredential | SandboxCursorToken | (SandboxSavedCredential & Readonly<{ bytes: Uint8Array }>),
  model: string, task: string, egress: Readonly<Record<string, string>>) {
  const file = credential.kind === 'auth_json';
  const process = { executable: file ? '/bin/sh' : '/opt/agenai/native/cursor-agent', cwd: sandbox.workspace,
    // The explicit `agent` command and `--` keep task text out of native subcommand and option parsing.
    args: [...(file ? ['/opt/agenai/examples/cursor/launch-cursor.sh'] : []), 'agent', '--disable-auto-update', '--disable-project-configs', '--print', '--force', '--trust', '--output-format', 'stream-json',
      '--model', model, '--', task],
    env: {
      HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: file ? '/home/sandbox/.agenai-credentials' : '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data',
      XDG_CACHE_HOME: '/home/sandbox/cache', XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
      ...(credential.kind === 'api_key' ? { CURSOR_API_KEY: credential.value }
        : credential.kind === 'auth_token' ? { CURSOR_AUTH_TOKEN: credential.value } : {}),
      AGENT_CLI_CREDENTIAL_STORE: file ? 'file' : 'memory', DIRENV_DISABLE: '1',
      CURSOR_CONFIG_DIR: '/home/sandbox/cursor/config', CURSOR_DATA_DIR: '/home/sandbox/cursor/data',
      CURSOR_API_ENDPOINT: 'https://api2.cursor.sh', ...egress,
    } };
  const reservation = credential.kind !== 'auth_json' ? sandbox.reserveProcess(process) : reserveSandboxCredentialProcess(sandbox, {
    bootstrapExecutable: credential.bootstrapExecutable, preparationTimeoutMs: credential.preparationTimeoutMs,
    process, file: { name: 'auth.json', bytes: credential.bytes },
  });
  return Object.freeze({ reservation, preflight: Object.freeze({
    provider: 'cursor', version: '2026.10.22-27dcf5f', transport: 'native_cli_stream_json', credentialRoute: credential.kind,
    sourceKind: credential.kind === 'api_key' ? 'explicit_api_key' : file ? 'explicit_native_auth_file' : 'explicit_account_token',
    nativeDestination: credential.kind === 'api_key' ? 'CURSOR_API_KEY' : file
      ? '/home/sandbox/.agenai-credentials/cursor/auth.json' : 'CURSOR_AUTH_TOKEN',
    httpsDestinations: destinations,
    keyExchange: credential.kind === 'api_key' ? 'https://api2.cursor.sh:443/auth/exchange_user_api_key' : 'not_selected', endpointEvidence: credential.kind === 'api_key' ? 'observed_in_ms005_native_campaign' : 'see_handoff_for_exact_route_and_platform_evidence',
    endpointSetSufficiency: credential.kind === 'api_key' ? 'observed_for_cli_tasks_excluding_account_mcp' : 'see_handoff_for_exact_route_and_platform_evidence',
    nativeQualification: credential.kind === 'api_key' ? 'recorded_linux_x64_and_desktop_native_arm64' : 'see_handoff_for_exact_route_and_platform_evidence', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  }) });
}
