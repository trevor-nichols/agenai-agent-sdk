import type { Sandbox } from '@agen-ai/sandbox';
import { captureSandboxApiKey, captureSandboxRecipeFields, parseSandboxCliExecutable, parseSandboxCliPrompt, sandboxNativeEgress } from '../credentials/index.js';
import type { SandboxApiKeyCredential } from '../credentials/index.js';

const destinations = Object.freeze(['https://api.anthropic.com:443/v1/messages']);

export interface SandboxOpenCodeInput {
  readonly credential: SandboxApiKeyCredential;
  readonly guestExecutable: '/opt/agenai/native/opencode';
  /** Bounded nonsecret prompt text, passed as one native operand after `--`; never a shell fragment or option. */
  readonly task: string;
}

/** Borrow a caller-prepared sandbox; this cannot inspect or attest its image or executable. */
export function reserveSandboxOpenCode(sandbox: Sandbox, input: SandboxOpenCodeInput) {
  const fields = captureSandboxRecipeFields(input, ['credential', 'guestExecutable', 'task']);
  const key = captureSandboxApiKey(fields.credential);
  const executable = parseSandboxCliExecutable(fields.guestExecutable);
  const task = parseSandboxCliPrompt(fields.task);
  if (executable !== '/opt/agenai/native/opencode' || sandbox.workspace !== '/workspace/work') {
    throw new TypeError('The prepared OpenCode layout does not match this recipe.');
  }
  const model = 'anthropic/claude-haiku-4-5-20251001';
  const egress = sandboxNativeEgress(sandbox, destinations);
  const reservation = sandbox.reserveProcess({ executable, cwd: sandbox.workspace,
    // `--` keeps task text out of native flag parsing; everything after it becomes the run message.
    args: ['run', '--standalone', '--format', 'json', '--model', model, '--agent', 'build', '--auto', '--', task],
    env: {
      HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data',
      XDG_CACHE_HOME: '/home/sandbox/cache', XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
      ANTHROPIC_API_KEY: key, OPENCODE_DB: '/home/sandbox/data/opencode/opencode.db',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_FREE_MODELS: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_FILEWATCHER_DISABLE: '1', OPENCODE_DISABLE_FFF: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model, providers: { anthropic: { settings: { baseURL: 'https://api.anthropic.com/v1' } } },
        warming: false, update: 'disable', snapshots: false, plugins: ['-opencode.browser'],
        compaction: { auto: false }, default_agent: 'build',
        experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' },
          { action: 'provider.use', resource: 'anthropic', effect: 'allow' }] } }),
      ...egress,
    } });
  return Object.freeze({ reservation, preflight: Object.freeze({
    provider: 'opencode', version: '2.1.2', transport: 'native_cli_json', credentialRoute: 'api_key',
    sourceKind: 'explicit_api_key', nativeDestination: 'ANTHROPIC_API_KEY', model,
    httpsDestinations: destinations,
    endpointEvidence: 'observed_in_ms005_native_campaign', nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  }) });
}
