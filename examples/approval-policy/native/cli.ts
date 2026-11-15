import { prepareGrokDockerApprovalProfile } from '@agen-ai/provider-grok/docker';
import { parseNativeConfiguration } from './config.js';
import { invalid, NativeExampleError, path } from './data.js';
import { readJson } from './files.js';
import { NativeCleanupPendingError, runNative } from './run.js';

export const nativeHelp = [
  'Explicit controlled Grok native example (native qualification is separate).',
  'Commands: help | --help | check-config --config ABS.json | prepare --config ABS.json | run --config ABS.json',
  'check-config is inert; prepare writes only an offline credential-free context. run explicitly executes one SDK turn.',
  'Only the fixed personal-account auth_json route is admitted. No API-key, model or native API endpoint override exists.',
  'Run consumes an exact-cent authorization reservation before credentials or Docker; this is not a provider billing cap.',
  'The caller owns and explicitly builds/deletes images. Failed work is never automatically replayed.',
].join('\n');
export async function nativeCommand(argv: readonly string[], signal?: AbortSignal): Promise<Readonly<{ exitCode: number; output: unknown }>> {
  if (argv.length === 1 && (argv[0] === 'help' || argv[0] === '--help')) return { exitCode: 0, output: { help: nativeHelp } };
  const command = argv[0];
  if (argv.length !== 3 || command === undefined || !['check-config', 'prepare', 'run'].includes(command) || argv[1] !== '--config') invalid();
  const config = parseNativeConfiguration(await readJson(path(argv[2])));
  if (argv[0] === 'check-config') return { exitCode: 0, output: { valid: true, format: config.format, provider: config.provider,
    mapping: config.mapping, requestedPolicy: config.profile.policy, nativeExecution: false } };
  if (argv[0] === 'prepare') {
    if (config.format !== 'agenai.approval-native-prepare.v1') invalid();
    const prepared = await prepareGrokDockerApprovalProfile({ profile: config.profile, ...config.preparation });
    return { exitCode: 0, output: { prepared: true, mapping: prepared.mapping, requestedPolicy: prepared.profile.policy,
      directory: prepared.directory, nativeExecution: false, imageOwnership: 'caller' } };
  }
  if (config.format !== 'agenai.approval-native-run.v1') invalid();
  const output = await runNative(config, signal);
  return { exitCode: output.status === 'completed' ? 0 : 1, output };
}
export function safeCommandFailure(error: unknown) {
  if (error instanceof NativeCleanupPendingError) return { ...error.report, cleanupOwner: 'original_in_process_retry_only',
    ...(error.report.inspectionCleanup ? { inspectionRestart: 'identity_evidence_only_not_executable_cleanup' } : {}), message: 'Retain the original retry owner. Checkpoints do not reopen sessions or replay work.' };
  return { failed: true, code: error instanceof NativeExampleError ? error.code : 'run_failed',
    message: 'Native example failed. Preserve its original safe checkpoints and cleanup ownership; do not rerun the attempt.' };
}
