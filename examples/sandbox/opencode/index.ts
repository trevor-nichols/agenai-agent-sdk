import type { Sandbox } from '@agen-ai/sandbox';
import { reserveSandboxCredentialProcess } from '@agen-ai/sandbox/node';
import { captureSandboxApiKey, captureSandboxRecipeFields, parseSandboxCliExecutable, parseSandboxCliPrompt,
  readSandboxCredentialJson, sandboxNativeEgress } from '../credentials/index.js';
import { createOpenCodeKeyExport, selectOpenCodeAccount } from './credentials.js';
import { captureOpenCodeConfiguration } from './input.js';
import { openCodeProcess } from './recipe.js';
import type { SandboxOpenCodeConfiguredInput, SandboxOpenCodeInput } from './types.js';
export type { SandboxOpenCodeAccount, SandboxOpenCodeConfiguredInput, SandboxOpenCodeInput, SandboxOpenCodeSelection } from './types.js';

const destinations = Object.freeze(['https://api.anthropic.com:443/v1/messages']);
type Launch = Readonly<{ reservation: ReturnType<Sandbox['reserveProcess']>; preflight: Readonly<{
  provider: string; version: string; transport: string; credentialRoute: string; sourceKind: string; nativeDestination: string;
  model: string; httpsDestinations: readonly string[]; endpointEvidence: string; nativeQualification: string;
  preparation: string; nativeProvider?: string; refresh?: 'not_supplied' | 'native_owned' | 'not_applicable';
}> }>;

/** Borrow a caller-prepared sandbox; this cannot inspect or attest its image or executable. */
export function reserveSandboxOpenCode(sandbox: Sandbox, input: SandboxOpenCodeConfiguredInput): Promise<Launch>;
export function reserveSandboxOpenCode(sandbox: Sandbox, input: SandboxOpenCodeInput): Launch;
export function reserveSandboxOpenCode(sandbox: Sandbox, input: SandboxOpenCodeInput | SandboxOpenCodeConfiguredInput): Launch | Promise<Launch>;
export function reserveSandboxOpenCode(sandbox: Sandbox, input: SandboxOpenCodeInput | SandboxOpenCodeConfiguredInput): Launch | Promise<Launch> {
  const fields = captureSandboxRecipeFields(input, ['credential', 'guestExecutable', 'task'], ['selection', 'preparation', 'signal']);
  const executable = parseSandboxCliExecutable(fields.guestExecutable);
  const task = parseSandboxCliPrompt(fields.task);
  if (executable !== '/opt/agenai/native/opencode' || sandbox.workspace !== '/workspace/work') {
    throw new TypeError('The prepared OpenCode layout does not match this recipe.');
  }
  if (Object.hasOwn(fields, 'selection') || Object.hasOwn(fields, 'preparation')) return reserveConfigured(sandbox, fields, task);
  if (Object.hasOwn(fields, 'signal')) throw new TypeError('Cancellation signals require the configured OpenCode recipe.');
  const key = captureSandboxApiKey(fields.credential);
  const model = 'anthropic/claude-haiku-4-5-20251001';
  const reservation = sandbox.reserveProcess(openCodeProcess(sandbox, task, 'anthropic', model, sandboxNativeEgress(sandbox, destinations), { kind: 'legacy_key', key }));
  return Object.freeze({ reservation, preflight: Object.freeze({
    provider: 'opencode', version: '2.1.2', transport: 'native_cli_json', credentialRoute: 'api_key',
    sourceKind: 'explicit_api_key', nativeDestination: 'ANTHROPIC_API_KEY', model, httpsDestinations: destinations,
    endpointEvidence: 'observed_in_ms005_native_campaign', nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64',
    preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
  }) });
}

async function reserveConfigured(sandbox: Sandbox, fields: Record<string, unknown>, task: string): Promise<Launch> {
  const { selection, credential, preparation, signal } = captureOpenCodeConfiguration(fields);
  const egress = sandboxNativeEgress(sandbox, selection.httpsDestinations);
  signal?.throwIfAborted();
  const bytes = credential.kind === 'api_key' ? createOpenCodeKeyExport(credential.value, selection.provider)
    : await readSandboxCredentialJson(credential, (input) => selectOpenCodeAccount(input, credential.credentialId, selection.provider, credential.lineage), signal);
  try {
    signal?.throwIfAborted();
    const process = openCodeProcess(sandbox, task, selection.provider, selection.model, egress, { kind: 'import' });
    const reservation = reserveSandboxCredentialProcess(sandbox, { ...preparation, file: { name: 'auth-export.json', bytes },
      process: { ...process, executable: '/bin/sh', args: ['/opt/agenai/examples/opencode/launch-opencode.sh',
        `${(preparation.preparationTimeoutMs / 1000).toFixed(3)}s`, ...process.args] } });
    return Object.freeze({ reservation, preflight: Object.freeze({
      provider: 'opencode', version: '2.1.2', transport: 'native_cli_json', credentialRoute: credential.kind,
      sourceKind: credential.kind === 'api_key' ? 'explicit_api_key' : 'explicit_native_auth_export',
      refresh: credential.kind === 'api_key' ? 'not_applicable' : credential.lineage === 'access_token_only' ? 'not_supplied' : 'native_owned',
      nativeDestination: 'native_auth_import_private_database', nativeProvider: selection.provider, model: selection.model,
      httpsDestinations: selection.httpsDestinations, endpointEvidence: 'caller_declared_native_integration',
      nativeQualification: 'see_handoff_for_exact_route_and_platform_evidence', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
    }) });
  } finally { bytes.fill(0); }
}
