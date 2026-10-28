import type { Sandbox } from '@agen-ai/sandbox';
import { captureSandboxApiKey, captureSandboxRecipeFields, parseSandboxCliExecutable, parseSandboxCliPrompt, sandboxNativeEgress } from '../credentials/index.js';
import type { SandboxApiKeyCredential } from '../credentials/index.js';

// The native campaign observed api.cursor.com alongside the documented API hosts.
const destinations = Object.freeze(['api.cursor.com', 'api2.cursor.sh', 'api5.cursor.sh', 'agent.api5.cursor.sh', 'agentn.api5.cursor.sh',
  'agent.us.api5.cursor.sh', 'agentn.us.api5.cursor.sh', 'agent.global.api5.cursor.sh', 'agentn.global.api5.cursor.sh']
  .map((host) => `https://${host}:443`));

export interface SandboxCursorInput {
  readonly credential: SandboxApiKeyCredential;
  readonly guestExecutable: '/opt/agenai/native/cursor-agent';
  /** Caller-selected account-admitted model. There is no automatic choice or fallback. */
  readonly model: string;
  /** Bounded nonsecret prompt text, passed as one native operand after `--`; never a shell fragment or option. */
  readonly task: string;
}

/** Explicit user-key CLI recipe; neither the Cursor SDK nor browser-login reuse. */
export function reserveSandboxCursor(sandbox: Sandbox, input: SandboxCursorInput) {
  const fields = captureSandboxRecipeFields(input, ['credential', 'guestExecutable', 'model', 'task']);
  const key = captureSandboxApiKey(fields.credential);
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
  const reservation = sandbox.reserveProcess({ executable, cwd: sandbox.workspace,
    // The explicit `agent` command and `--` keep task text out of native subcommand and option parsing.
    args: ['agent', '--disable-auto-update', '--disable-project-configs', '--print', '--force', '--trust', '--output-format', 'stream-json',
      '--model', model, '--', task],
    env: {
      HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data',
      XDG_CACHE_HOME: '/home/sandbox/cache', XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
      CURSOR_API_KEY: key, AGENT_CLI_CREDENTIAL_STORE: 'memory',
      CURSOR_CONFIG_DIR: '/home/sandbox/cursor/config', CURSOR_DATA_DIR: '/home/sandbox/cursor/data',
      CURSOR_API_ENDPOINT: 'https://api2.cursor.sh', ...egress,
    } });
  return Object.freeze({ reservation, preflight: Object.freeze({
    provider: 'cursor', version: '2026.10.22-27dcf5f', transport: 'native_cli_stream_json', credentialRoute: 'api_key',
    sourceKind: 'explicit_api_key', nativeDestination: 'CURSOR_API_KEY',
    httpsDestinations: destinations,
    keyExchange: 'https://api2.cursor.sh:443/auth/exchange_user_api_key', endpointEvidence: 'observed_in_ms005_native_campaign', endpointSetSufficiency: 'observed_for_cli_tasks_excluding_account_mcp',
    nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  }) });
}
