import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { originalCanonical } from '../coordinator-recovery/common.mjs';
import { sha } from './evidence.mjs';
import { installedIdentity } from '../../scalability/identity.mjs';

export async function handoff(context, phase, receipt = null) {
  const { input, evidence, report } = context;
  assert(context.scenario.kind === 'handoff' || context.scenario.kind === 'lost-ack'); context.signal.throwIfAborted();
  for (const source of report.sources) assert.equal(sha(await readFile(source.original)), source.sha256, 'Executed source changed before handoff.');
  for (const asset of report.assets) assert.equal(sha(await readFile(asset.path)), asset.sha256, 'Prepared asset changed before handoff.');
  assert.deepEqual(await installedIdentity(input.consumer), report.candidate, 'Installed candidate changed before handoff.');
  assert.equal(sha(await readFile(report.input.path)), report.input.sha256, 'Original input changed before handoff.');
  const canonical = await originalCanonical(context.scenario.canonicalPath);
  assert.equal(canonical.value.generation.kind, 'dirty');
  assert.equal(canonical.value.generation.identity.generationId, context.authority.generation);
  assert.equal(canonical.value.daemonId, report.engine.id);
  const members = [];
  for (const entry of context.members) {
    const record = await evidence.file(`${entry.label}/handoff-record.json`, entry.owner.recoveryRecord, 65_536);
    members.push({ label: entry.label, namespace: entry.report.namespace, record, state: entry.owner.state,
      process: entry.report.process ?? null, session: entry.session?.summary() ?? null });
  }
  report.handoff = { phase, at: new Date().toISOString(), pid: process.pid, canonical: canonical.identity,
    preservedCanonical: await evidence.file('handoff-canonical-original.bin', canonical.bytes), members, receipt,
    resumeSignal: 'SIGUSR1',
    timingPolicy: 'Original SDK request errors, close events, deadlines and coordinator health remain active. This is a point-in-time byte witness. Immediately before any exact-PID external signal, the launcher must independently verify these exact canonical bytes again; any change rejects the planned crash row and preserves the new original state. No timeout or health publication is suppressed.',
    disposition: 'External controller owns any exact-PID termination. SIGUSR1 resumes into an explicit scenario failure and original-owner cleanup. A timeout also requests cleanup; no automatic replacement or signal is sent.' };
  assert.equal(sha(await readFile(canonical.identity.path)), canonical.identity.sha256, 'Canonical bytes changed before barrier publication.');
  report.handoff.canonicalVerifiedAt = new Date().toISOString();
  await evidence.file('handoff-report.json', report);
  assert.equal(sha(await readFile(canonical.identity.path)), canonical.identity.sha256, 'Canonical bytes changed while preserving the handoff report.');
  process.stdout.write(`${JSON.stringify({ status: 'handoff_ready', pid: process.pid, phase, generation: context.authority.generation,
    report: `${input.output}/handoff-report.json`, canonical: canonical.identity, verifiedAt: new Date().toISOString(),
    originalResponse: receipt?.selected ? { dispatchedAt: receipt.selected.dispatchedAt, responseAt: receipt.selected.responseAt,
      finishedAt: receipt.selected.finishedAt, transportErrorIssued: receipt.transportErrorIssued } : null })}\n`);
  let resumed = false; const resume = () => { resumed = true; };
  process.on('SIGUSR1', resume);
  try { while (!resumed) { context.signal.throwIfAborted(); await delay(100, undefined, { signal: context.signal }); } }
  finally { process.off('SIGUSR1', resume); }
  assert.fail('Explicit external handoff was resumed; exploratory row remains failed.');
}
