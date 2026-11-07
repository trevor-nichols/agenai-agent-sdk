import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupMember, continuity, networkProof, reserveMember, startMember, stopAndExport } from './member.mjs';
import { observe } from './evidence.mjs';
import { runControlLoss } from './control-loss.mjs';
import { resourceSaverScenario } from './configuration.mjs';
import { runResourceSaver } from './resource-saver.mjs';

async function stagedMembers(context) {
  const a = await reserveMember(context, 'a', 'github.com');
  const aStarting = startMember(context, a); a.tasks.push(aStarting); await aStarting;
  await continuity(context, a, 'a-before-b'); await networkProof(context, a, 'github.com', 'example.com', 'a-before-b');
  const b = await reserveMember(context, 'b', 'example.com');
  context.faultMember = b;
  let done = false; let failed;
  const starting = startMember(context, b).catch((error) => { failed = error; }).finally(() => { done = true; }); b.tasks.push(starting);
  while (!done) {
    context.signal.throwIfAborted();
    await continuity(context, a, 'a-during-b-startup');
    await context.evidence.event({ kind: 'staged-startup-coordinator', state: context.coordinator.state });
    if (!done) await delay(250, undefined, { signal: context.signal });
  }
  await starting; if (failed) throw failed;
  await continuity(context, a, 'both-ready-a'); await continuity(context, b, 'both-ready-b');
  await networkProof(context, a, 'github.com', 'example.com', 'both-ready-a');
  await networkProof(context, b, 'example.com', 'github.com', 'both-ready-b');
  assert.notEqual(a.report.process.identity.session, b.report.process.identity.session);
  assert.notEqual(a.owner.recoveryRecord.sandboxId, b.owner.recoveryRecord.sandboxId);
  return [a, b];
}

async function survivor(context, entry, phase, previous) {
  await continuity(context, entry, phase, previous);
  await networkProof(context, entry, entry.report.hostname, entry.report.hostname === 'github.com' ? 'example.com' : 'github.com', phase);
}

export async function runScenario(context) {
  if (resourceSaverScenario(context.scenario)) { await runResourceSaver(context); return; }
  const [a, b] = await stagedMembers(context);
  const selected = context.scenario;
  if (selected.kind === 'control-loss') { await runControlLoss(context, a, b); return; }
  if (selected.kind === 'handoff' || selected.kind === 'lost-ack') {
    if (selected.kind === 'handoff' && selected.at === 'two-active') await context.handoff('two-active');
    else {
      assert.equal(selected.fault.operation, 'delete', 'Create/start handoff must occur during staged B startup.');
      await cleanupMember(context, b);
    }
    assert.fail('An external-handoff exploration cannot become a successful live scenario after resuming.');
  }
  const order = selected.kind === 'ms004' ? [b, a] : selected.removalOrder.map((label) => label === 'a' ? a : b);
  const [first, remaining] = order;
  const previous = remaining.session.lastTick.counter;
  first.session.expectStop();
  const cancelling = first.process.stop(); first.tasks.push(cancelling);
  await observe(cancelling, 60_000, `Original ${first.label} process cancellation with sandbox stop scope`);
  await context.evidence.event({ kind: 'original-process-cancelled', label: first.label, stopScope: first.process.stopScope, state: first.owner.state });
  await stopAndExport(context, first);
  await survivor(context, remaining, `${remaining.label}-after-${first.label}-stop`, previous);
  await cleanupMember(context, first);
  await survivor(context, remaining, `${remaining.label}-after-${first.label}-destroy`);
  if (selected.kind === 'ms004') return;
  await stopAndExport(context, remaining);
  const zero = context.coordinator.state;
  assert.equal(zero.kind, 'active'); assert.equal(zero.generation, context.authority.generation);
  assert.equal(zero.observation, 'retained', 'Stopped members must not supply active observer authority.');
  assert.equal(zero.members.length, 1); assert.equal(zero.members[0].kind, 'retained');
  await context.evidence.event({ kind: 'zero-observers-with-retained-stopped-member', state: zero,
    retained: remaining.owner.recoveryRecord });
  const c = await reserveMember(context, 'c', 'github.com');
  await startMember(context, c); await survivor(context, c, 'c-after-zero-observer-reentry');
  await cleanupMember(context, remaining);
  await survivor(context, c, 'c-after-retained-member-destroy');
  await stopAndExport(context, c); await cleanupMember(context, c);
}
