import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupMember, continuity, networkProof, reserveMember, startMember, stopAndExport } from './member.mjs';
import { failure } from './evidence.mjs';
import { captureRetainedFence } from './control-loss.mjs';
import { awaitVmStopped, createForeignNetwork, healthReads, removeForeignNetwork } from './desktop-idle.mjs';

const RESTARTED = 'Desktop Engine restarted while the coordinator owned resources in its VM.';
const TOPOLOGY = 'External Desktop Engine topology changed.';

const messages = (record) => record ? [record.message, ...messages(record.cause), ...(record.errors ?? []).flatMap(messages)] : [];

/** Names the SDK check whose error the fenced owner retained first. */
export function firstFenceCheck(retainedError) {
  const chain = messages(retainedError);
  return chain.includes(RESTARTED) ? 'engine_restart' : chain.includes(TOPOLOGY) ? 'external_topology' : 'other';
}

async function admit(context, label, hostname) {
  const entry = await reserveMember(context, label, hostname);
  await startMember(context, entry);
  await continuity(context, entry, `${label}-ready`);
  await networkProof(context, entry, hostname, hostname === 'github.com' ? 'example.com' : 'github.com', `${label}-ready`);
  return entry;
}

async function retire(context, entry) {
  await stopAndExport(context, entry); await cleanupMember(context, entry);
}

function requireActive(context, phase, members) {
  const state = context.coordinator.state;
  assert.equal(state.kind, 'active', `${phase}: the open coordinator must remain active.`);
  assert.equal(state.generation, context.authority.generation); assert.equal(state.members.length, members);
  return { phase, at: new Date().toISOString(), state };
}

async function awaitFence(context) {
  const deadline = performance.now() + context.input.capabilities.limits.requestMs;
  while (context.coordinator.state.kind !== 'fenced') {
    context.signal.throwIfAborted();
    assert(performance.now() < deadline, 'The coordinator did not fence the group.');
    await delay(25, undefined, { signal: context.signal });
  }
  const retained = await captureRetainedFence(context.coordinator, context.evidence);
  assert.equal(retained.captureFailure, null);
  return { state: context.coordinator.state, retained, check: firstFenceCheck(retained.retainedError) };
}

async function admissionClosed(context, entry) {
  let rejected; try { await entry.sandbox.files.stat('.'); } catch (error) { rejected = error; }
  assert(rejected instanceof context.sdk.SandboxStateError, 'A group fence must close live-file admission.');
  return { label: entry.label, failure: failure(rejected), state: entry.owner.state };
}

async function single(context) {
  await retire(context, await admit(context, 'a', 'github.com'));
}

async function joint(context, outcome) {
  const a = await reserveMember(context, 'a', 'github.com'); const b = await reserveMember(context, 'b', 'example.com');
  await Promise.all([a, b].map((entry) => startMember(context, entry)));
  for (const [entry, denied] of [[a, 'example.com'], [b, 'github.com']]) {
    await continuity(context, entry, 'both-ready'); await networkProof(context, entry, entry.report.hostname, denied, 'both-ready');
  }
  assert.notEqual(a.report.process.identity.session, b.report.process.identity.session);
  assert.notEqual(a.owner.recoveryRecord.sandboxId, b.owner.recoveryRecord.sandboxId);
  outcome.distinct = { sessions: [a, b].map((entry) => entry.report.process.identity.session),
    sandboxes: [a, b].map((entry) => entry.owner.recoveryRecord.sandboxId) };
  for (const entry of [b, a]) await retire(context, entry);
}

async function idleReentry(context, outcome) {
  await retire(context, await admit(context, 'a', 'github.com'));
  outcome.idle = [await awaitVmStopped(context, 'after-a', Date.now())];
  outcome.checks = [requireActive(context, 'stopped-without-members', 0)];
  const network = await createForeignNetwork(context, 'foreign');
  try {
    await healthReads(context, Date.now());
    outcome.checks.push(requireActive(context, 'foreign-network-present', 0));
  } finally { outcome.foreignNetwork = await removeForeignNetwork(context, network); }
  await healthReads(context, Date.now());
  outcome.checks.push(requireActive(context, 'foreign-network-removed', 0));
  outcome.idle.push(await awaitVmStopped(context, 'before-c', outcome.foreignNetwork.removedAt));
  await retire(context, await admit(context, 'c', 'github.com'));
  outcome.checks.push(requireActive(context, 'after-c', 0));
}

async function foreignNetwork(context, outcome) {
  const a = await admit(context, 'a', 'github.com');
  const network = await createForeignNetwork(context, 'foreign');
  try {
    outcome.fence = await awaitFence(context);
    assert.equal(outcome.fence.check, 'external_topology', 'The fence must name the external topology change.');
    outcome.admission = [await admissionClosed(context, a)];
    await cleanupMember(context, a);
  } finally { outcome.foreignNetwork = await removeForeignNetwork(context, network); }
}

async function engineRestart(context, outcome) {
  const a = await admit(context, 'a', 'github.com');
  await stopAndExport(context, a);
  outcome.idle = [await awaitVmStopped(context, 'retained-a', Date.now())];
  // Cached replies may already differ from the live Engine; a fence at this point is the first check, recorded as such.
  outcome.atStop = context.coordinator.state;
  const entries = [a];
  if (outcome.atStop.kind === 'active') {
    const b = await reserveMember(context, 'b', 'example.com'); entries.unshift(b);
    try { await startMember(context, b); outcome.admission = { label: 'b', result: 'completed' }; }
    catch (error) { outcome.admission = { label: 'b', result: 'rejected', failure: failure(error), state: b.owner.state }; }
  }
  outcome.fence = await awaitFence(context);
  assert.equal(outcome.fence.state.failure.kind, 'authority_lost');
  if (outcome.fence.check === 'engine_restart') assert.equal(outcome.fence.state.failure.source, 'engine');
  for (const entry of entries) await cleanupMember(context, entry);
}

const SCENARIOS = { single, joint, 'idle-reentry': idleReentry, 'foreign-network': foreignNetwork, 'engine-restart': engineRestart };

export async function runResourceSaver(context) {
  const outcome = { kind: context.scenario.kind, startedAt: new Date().toISOString(), generation: context.authority.generation };
  context.report.resourceSaver = outcome;
  try { await SCENARIOS[context.scenario.kind](context, outcome); }
  finally {
    outcome.finishedAt = new Date().toISOString();
    outcome.evidence = await context.evidence.file('resource-saver-outcome.json', outcome);
  }
}
