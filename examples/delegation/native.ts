import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSeparateOutput, publishNativeReport, reserveNativeOutput } from './native/artifacts.js';
import { parseNativeCandidate, parseNativeSelection } from './native/contracts.js';
import { digest, exact, NativeInputError, readNativeInput, semanticDigest } from './native/json.js';
import { assertNativeExecution, assertNativeSelection, parseNativeEnvelope } from './native/reports.js';
import type { NativeOperationResult } from './native/run.js';

type Command = 'discover' | 'execute' | 'check';

function argumentsFor(argv: readonly string[]): { command: Command; values: ReadonlyMap<string, string> } {
  const command = argv[0];
  if (command !== 'discover' && command !== 'execute' && command !== 'check') throw new NativeInputError('command_invalid');
  const common = ['manifest', 'manifest-sha256'];
  const execution = ['discovery', 'discovery-sha256', 'selection', 'selection-sha256'];
  const required = command === 'discover' ? [...common, 'launch', 'output']
    : command === 'execute' ? [...common, ...execution, 'launch', 'output', 'allow-live-inference']
      : [...common, ...execution, 'evidence', 'expect'];
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith('--') || !required.includes(flag.slice(2)) || values.has(flag.slice(2))) throw new NativeInputError('arguments_invalid');
    const key = flag.slice(2);
    const value = key === 'allow-live-inference' ? 'true' : argv[++index];
    if (value === undefined || value.startsWith('--')) throw new NativeInputError('argument_value_required');
    values.set(key, value);
  }
  if (required.some((key) => !values.has(key))) throw new NativeInputError('arguments_missing');
  for (const key of required.filter((key) => key.endsWith('-sha256'))) digest(values.get(key));
  if (command === 'check') exact(values.get('expect'), 'qualified');
  else if (!['direct', 'registry'].includes(values.get('launch')!)) throw new NativeInputError('launch_invalid');
  return { command, values };
}

async function main(): Promise<void> {
  const { command, values } = argumentsFor(process.argv.slice(2));
  const get = (key: string) => values.get(key)!;
  const manifest = await readNativeInput(get('manifest'), get('manifest-sha256'), 262_144);
  const candidate = parseNativeCandidate(manifest.value);
  const discoveryFile = command === 'discover' ? undefined : await readNativeInput(get('discovery'), get('discovery-sha256'), 524_288);
  const discovery = discoveryFile ? parseNativeEnvelope(discoveryFile.value, candidate, manifest.fileDigest, 'discovery') : undefined;
  const selectionFile = command === 'discover' ? undefined : await readNativeInput(get('selection'), get('selection-sha256'), 262_144);
  const selection = selectionFile ? parseNativeSelection(selectionFile.value) : undefined;
  if (selection && discovery) assertNativeSelection(candidate, selection, discovery);
  if (command === 'check') {
    const file = await readNativeInput(join(get('evidence'), 'evidence.json'), undefined, 1_048_576);
    const evidence = parseNativeEnvelope(file.value, candidate, manifest.fileDigest, 'execution');
    if (evidence.report.outcome !== 'qualified') throw new NativeInputError(evidence.report.reason ?? 'qualification_failed');
    assertNativeExecution(candidate, selection!, discovery!, evidence, { discovery: discoveryFile!.fileDigest, selection: selectionFile!.fileDigest });
    process.stdout.write(`${JSON.stringify({ outcome: 'qualified', runId: evidence.input.runId, launch: evidence.launch })}\n`);
    return;
  }
  // Import the inert launcher before acquiring an invocation root or registering signal handlers.
  // The offline path above never imports a launcher or reads the credential facility.
  const { failedNativeReport, runNativeOperation } = await import('./native/run.js');
  const launch = get('launch') as 'direct' | 'registry';
  if (discovery) exact(discovery.launch, launch);
  const inputs = [get('manifest'), candidate.credential.path];
  if (command === 'execute') inputs.push(get('discovery'), get('selection'));
  assertSeparateOutput(get('output'), inputs);
  const destination = await reserveNativeOutput(get('output'));
  const root = await mkdtemp(join(tmpdir(), 'agenai-native-qualification-'));
  const rootIdentity = await lstat(root);
  let rootRetired = false;
  const retireRoot = async () => {
    if (rootRetired) return;
    const current = await lstat(root);
    if (!current.isDirectory() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || await realpath(root) !== root) {
      throw new NativeInputError('cleanup_pending');
    }
    await rm(root, { recursive: true });
    rootRetired = true;
  };
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let operation: (Omit<NativeOperationResult, 'processProof'> & { readonly processProof?: NativeOperationResult['processProof'] }) | undefined;
  const startedAt = new Date().toISOString();
  try {
    try {
      operation = await runNativeOperation({ command, candidate, launch, root, signal: lifetime.signal, ...(selection ? { selection } : {}) });
    } catch (error) {
      // A preflight failure has no process observations. The runner retains ownership instead of throwing after uncertain cleanup.
      if (!(error instanceof NativeInputError) || error.code !== 'source_identity_drift' && error.code !== 'budget_exhausted') throw error;
      operation = { report: failedNativeReport(command, error.code), allocations: [], cleanup: 'closed' };
    }
    if (operation.cleanup === 'closed') {
      try { await retireRoot(); }
      catch {
        operation = { ...operation, cleanup: 'pending', retryCleanup: retireRoot, report: { ...operation.report,
          outcome: 'cleanup_pending', reason: 'cleanup_pending', failedGates: [...operation.report.failedGates, { gate: 'cleanup', reason: 'cleanup_pending' }] } };
      }
    }
    const { retryCleanup: _retry, ...serializable } = operation;
    const body = { format: 'agenai-native-qualification-v1', kind: command === 'discover' ? 'discovery' : 'execution',
      runId: randomUUID(), startedAt, endedAt: new Date().toISOString(), launch, candidateFileDigest: manifest.fileDigest,
      candidateDigest: semanticDigest(candidate), sdk: candidate.sdk, runnerDigest: candidate.runnerDigest,
      credentialMechanism: 'explicit_api_key_environment', operation: serializable,
      ...(selection ? { discoveryFileDigest: discoveryFile!.fileDigest, discoveryDigest: semanticDigest(discovery!.input),
        selectionFileDigest: selectionFile!.fileDigest, selectionDigest: semanticDigest(selection) } : {}) };
    const envelope = parseNativeEnvelope({ ...body, evidenceDigest: semanticDigest(body) }, candidate, manifest.fileDigest, body.kind as 'discovery' | 'execution');
    if (command === 'execute' && envelope.report.outcome === 'qualified') {
      assertNativeExecution(candidate, selection!, discovery!, envelope, { discovery: discoveryFile!.fileDigest, selection: selectionFile!.fileDigest });
    }
    await publishNativeReport(destination, command === 'discover' ? 'discovery.json' : 'evidence.json', body);
    process.stdout.write(`${JSON.stringify({ outcome: envelope.report.outcome, reason: envelope.report.reason, output: destination.path })}\n`);
    if (envelope.report.outcome !== 'qualified') process.exitCode = 1;
  } finally {
    if (operation?.cleanup === 'pending') {
      if (!operation.retryCleanup) throw new NativeInputError('cleanup_authority_missing');
      // A deadline is not quiescence. Keep the original lease, process, and roots until cleanup is proven.
      let closed = false;
      while (!closed) {
        try { await operation.retryCleanup(); await retireRoot(); closed = true; }
        catch { process.stderr.write('{"outcome":"cleanup_pending"}\n'); await delay(30_000); }
      }
    }
    await retireRoot();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof NativeInputError && /^[a-z_]{1,100}$/u.test(error.code) ? error.code : 'qualification_failed';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 1;
});
