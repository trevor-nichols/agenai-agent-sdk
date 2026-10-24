// ------------------------------------------------------------------------------------------------
//                acp.ts - Packed synthetic ACP → MCP → managed child and inbox qualification
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseAgentTurnId } from '@agen-ai/agent-protocol';
import { AcpProtocolError } from '@agen-ai/acp-transport';
import { AgentProviderContractError, type AgentProviderSession, type AgentSessionHostBinding } from '@agen-ai/agent-runtime';
import { openAcpInstallationStore, type AcpInstallationStore } from '@agen-ai/acp-registry/node';
import { createDelegationHostBinding, type DelegationAdmissionReceipt, type DelegationClient,
  type DelegationToolTaskStatus } from '@agen-ai/agent-orchestration';
import { installFixture, prepareArtifacts, type InstalledFixture } from '../registry-provider/installation.js';
import { FixtureOwnership, withCleanup } from './acp-ownership.js';
import { proveSetupFailureOwnership } from './acp-failures.js';
import { createManagedHost, createRetainedPeer, openParent, parentScope, peerReports, type RetainedPeer } from './acp-host.js';

interface DelegatedResult {
  readonly admission: DelegationAdmissionReceipt;
  readonly status: DelegationToolTaskStatus;
  readonly toolNames: readonly string[];
}

async function prompt(session: AgentProviderSession, command: Readonly<Record<string, unknown>>): Promise<unknown> {
  let text = '';
  let completed = 0;
  let outputCount = 0;
  for await (const output of session.startTurn({ turnId: parseAgentTurnId(randomUUID()), interactionMode: 'default',
    parts: [{ type: 'text', text: JSON.stringify(command) }], deadlineAt: new Date(Date.now() + 10_000).toISOString(), signal: AbortSignal.timeout(15_000) }).outputs) {
    assert.ok(++outputCount <= 64, 'Qualification consumes a bounded native output stream.');
    assert.equal(output.kind, 'event');
    if (output.kind !== 'event') continue;
    if (output.event.type === 'content.delta') text += output.event.payload.delta;
    if (output.event.type === 'turn.completed') {
      assert.equal(output.event.payload.outcome, 'completed');
      completed += 1;
    }
    assert.ok(Buffer.byteLength(text) <= 24_576);
  }
  assert.equal(completed, 1);
  return JSON.parse(text) as unknown;
}

function qualify(peer: RetainedPeer, label: string, result: unknown): DelegatedResult {
  const calls = peer.invocations.filter((invocation) => invocation.sessionId === `synthetic-parent-session-${label}`);
  assert.ok(calls.some((invocation) => invocation.toolName === 'delegate_task'),
    'Synthetic qualification requires a real delegate_task invocation; accepting MCP configuration is insufficient.');
  assert.deepEqual(calls.map((invocation) => invocation.toolName), ['delegation_targets', 'delegate_task', 'task_status']);
  assert.ok(result && typeof result === 'object' && 'admission' in result && 'status' in result && 'toolNames' in result);
  const delegated = result as DelegatedResult;
  assert.equal(typeof delegated.admission.taskId, 'string');
  assert.equal(typeof delegated.admission.runId, 'string');
  assert.equal(delegated.admission.duplicate, false);
  assert.equal(delegated.status.waitStatus, 'settled');
  assert.equal(delegated.status.task.taskId, delegated.admission.taskId);
  const run = delegated.status.runs.items[0];
  assert.ok(run);
  assert.equal(run.runId, delegated.admission.runId);
  assert.equal(run.outcome?.kind, 'succeeded');
  assert.ok(delegated.toolNames.includes('delegate_task'));
  assert.equal(Object.hasOwn(run, 'input'), false);
  return delegated;
}

async function binding(client: DelegationClient): Promise<AgentSessionHostBinding> {
  const created = await createDelegationHostBinding({ client });
  assert.ok(created);
  return created;
}

async function unsupported(store: AcpInstallationStore, root: string, fixture: InstalledFixture, client: DelegationClient, ownership: FixtureOwnership) {
  const peer = await createRetainedPeer(store, root, fixture, ownership);
  await withCleanup(async () => {
    const raw = await binding(client);
    let releases = 0;
    await assert.rejects(openParent(peer, 'unsupported', { ...raw, async release() {
      await raw.release(); releases += 1;
    } }), (error: unknown) => error instanceof AgentProviderContractError && error.code === 'host_binding_unsupported');
    assert.equal(releases, 1);
    assert.deepEqual(peer.bindingCounts(), { acquired: 0, released: 0 });
    assert.ok((await peerReports(fixture)).every((report) => !report.methods.includes('session/new') && report.promptCount === 0));
    await peer.assertRetained();
  }, () => peer.close());
}

async function unexposed(store: AcpInstallationStore, root: string, fixture: InstalledFixture, client: DelegationClient, ownership: FixtureOwnership) {
  const peer = await createRetainedPeer(store, root, fixture, ownership);
  let session: AgentProviderSession | undefined;
  await withCleanup(async () => {
    // Ordinary opening remains transport configuration. This explicit fixture qualifies actual tool use.
    session = await openParent(peer, 'unexposed', await binding(client));
    const result = await prompt(session, { action: 'delegate', operationId: randomUUID(), label: 'unexposed' });
    assert.deepEqual(result, { transportAccepted: true, toolsExposed: false });
    assert.throws(() => qualify(peer, 'unexposed', result), /requires a real delegate_task invocation/u);
    assert.deepEqual(peer.invocations, []);
    const report = (await peerReports(fixture)).find((candidate) => candidate.promptCount === 1);
    assert.ok(report);
    assert.equal(report.serverCount, 1);
    assert.deepEqual(report.toolNames, []);
    assert.deepEqual(report.toolCalls, []);
    await peer.assertRetained();
  }, async () => {
    await session?.close({ reason: 'shutdown' });
    await peer.close();
  });
}

async function strictExtensions(store: AcpInstallationStore, root: string, fixture: InstalledFixture,
  client: DelegationClient, ownership: FixtureOwnership) {
  const references: { acquired: number; released: number } = { acquired: 0, released: 0 };
  const countedStore: AcpInstallationStore = { ...store,
    async acquire(input) { const reference = await store.acquire(input); references.acquired += 1; return reference; },
    async release(reference) { await store.release(reference); references.released += 1; },
  };
  const peer = await createRetainedPeer(countedStore, root, fixture, ownership, { unknownExtensionPolicy: 'reject' });
  let rawBindingReleased = 0;
  await withCleanup(async () => {
    const raw = await binding(client);
    await assert.rejects(openParent(peer, 'strict-extension', { ...raw, async release() {
      await raw.release(); rawBindingReleased += 1;
    } }), (error: unknown) => error instanceof AcpProtocolError && error.reasonCode === 'acp_unknown_critical_extension');
    assert.equal(rawBindingReleased, 1, 'A rejected opening must release its exact runtime-owned binding.');
    assert.deepEqual(peer.bindingCounts(), { acquired: 1, released: 1 });
    assert.deepEqual(peer.invocations, []);
    const reports = await peerReports(fixture);
    assert.equal(reports.length, 1, 'The negotiated process is retained through the rejected parent opening.');
    assert.ok(reports.every((report) => report.promptCount === 0 && report.toolCalls.length === 0));
    const rejected = reports.find((report) => report.serverCount === 1);
    assert.ok(rejected);
    assert.ok(rejected.methods.includes('session/new'));
    assert.equal(rejected.vendorRequests, 1);
    assert.equal(rejected.vendorMethodNotFoundReplies, 0, 'Explicit reject must close instead of answering optional vendor traffic.');
    await peer.assertRetained();
  }, () => peer.close());
  assert.deepEqual(references, { acquired: 1, released: 1 });
  assert.ok((await peerReports(fixture)).every((report) => report.exited));
  assert.equal(rawBindingReleased, 1);
  assert.deepEqual(peer.bindingCounts(), { acquired: 1, released: 1 });
}

async function positive(store: AcpInstallationStore, root: string, fixtures: readonly InstalledFixture[], ownership: FixtureOwnership) {
  const peer = await createRetainedPeer(store, root, fixtures[0]!, ownership);
  const managed = await createManagedHost(peer, store, root).catch((error: unknown) => ownership.unwind({ release: () => peer.close() }, error));
  const parents: AgentProviderSession[] = [];
  let primaryError: unknown;
  let failed = false;
  try {
    const clients = await Promise.all(['A', 'B'].map((label) => managed.coordinator.bindParent({ scope: parentScope(label) })));
    for (const [index, label] of ['A', 'B'].entries()) parents.push(await openParent(peer, label, await binding(clients[index]!)));
    assert.deepEqual(peer.bindingCounts(), { acquired: 2, released: 0 });
    const delegated: DelegatedResult[] = [];
    // Parent lifetimes overlap; child admissions follow each child's observed resource release.
    for (const [index, session] of parents.entries()) {
      const label = ['A', 'B'][index]!;
      const result = qualify(peer, label, await prompt(session, { action: 'delegate', label, operationId: randomUUID() }));
      delegated.push(result);
      await managed.waitForChildResourceRelease(result.admission.runId);
    }
    assert.notEqual(delegated[0]!.admission.taskId, delegated[1]!.admission.taskId);
    for (const [index, result] of delegated.entries()) {
      const view = await clients[index]!.inspect({ taskId: result.admission.taskId });
      assert.equal(view.runs.items[0]?.outcome?.kind, 'succeeded');
      const outcome = view.runs.items[0]?.outcome;
      assert.ok(outcome?.kind === 'succeeded');
      assert.equal(outcome.result.text, `Certified child output: Managed child result for ${['A', 'B'][index]}`);
      assert.deepEqual(result.admission.target, managed.catalog.targets[0]!.reference);
    }
    const inboxDeadline = Date.now() + 5_000;
    while (managed.envelopes.size !== 2 && Date.now() < inboxDeadline) await delay(10);
    assert.equal(managed.envelopes.size, 2);
    for (const [index, result] of delegated.entries()) {
      const entry = [...managed.envelopes.values()].find(({ envelope }) => envelope.taskId === result.admission.taskId);
      assert.ok(entry);
      assert.equal(entry.envelope.runId, result.admission.runId);
      assert.deepEqual(entry.envelope.parent, parentScope(['A', 'B'][index]!));
      assert.equal(entry.envelope.policy, 'automatic');
      assert.equal(entry.envelope.outcome.kind, 'succeeded');
    }
    for (const [index, session] of parents.entries()) {
      const foreign = await prompt(session, { action: 'foreign', taskId: delegated[1 - index]!.admission.taskId });
      assert.ok(foreign && typeof foreign === 'object' && 'foreignDenied' in foreign);
      assert.ok(Array.isArray(foreign.foreignDenied));
      assert.deepEqual(foreign.foreignDenied.map((entry: { tool: string }) => entry.tool), ['task_status', 'task_send', 'task_cancel']);
      assert.equal(session.configuration.kind, 'selectable');
      if (session.configuration.kind !== 'selectable') throw new Error('Parent configuration must remain observable.');
      const current = await session.configuration.listConfiguration();
      const model = current.fields.find((field) => field.key === managed.field.key);
      assert.ok(model && model.fieldKind === 'single_select');
      assert.equal(model.currentValue, managed.field.initialOptionId, 'Child selection cannot mutate its parent session.');
    }
    const reports = await peerReports(peer.fixture);
    assert.ok(reports.every((report) => report.vendorRequests === (report.methods.includes('session/new') ? 1 : 0)
      && report.vendorMethodNotFoundReplies === report.vendorRequests
      && report.vendorRequestId === report.vendorReplyId), 'Default standard policy must correlate every unknown vendor request before continuing.');
    const parentReports = reports.filter((report) => report.serverCount === 1);
    assert.equal(parentReports.length, 2);
    assert.ok(parentReports.every((report) => report.promptCount === 2), 'Inbox acceptance must not dispatch another parent model turn.');
    const childReports = reports.filter((report) => report.serverCount === 0 && report.promptCount === 1);
    assert.equal(childReports.length, 2);
    for (const report of childReports) {
      assert.equal(report.selectedModel, 'certified');
      assert.notEqual(report.workingDirectory, root);
      assert.ok(report.methods.indexOf('session/set_config_option') < report.methods.indexOf('session/prompt'));
      assert.equal(report.exited, true, 'Runtime cleanup must quiesce a child before its resource reference releases.');
    }
    await peer.assertRetained();
    await unsupported(store, root, fixtures[1]!, clients[0]!, ownership);
    await unexposed(store, root, fixtures[2]!, clients[0]!, ownership);
    await strictExtensions(store, root, fixtures[3]!, clients[0]!, ownership);
    assert.equal(managed.envelopes.size, 2);
  } catch (error) {
    primaryError = error;
    failed = true;
    throw error;
  } finally {
    try {
      for (const session of parents) await session.close({ reason: 'shutdown' });
      await managed.close();
      await peer.close();
    } catch (cleanupError) {
      if (failed) throw new AggregateError([primaryError, cleanupError], 'Synthetic qualification and cleanup both failed.');
      throw cleanupError;
    }
  }
  assert.deepEqual(managed.counts(), { acquired: 2, released: 2, grantsReleased: 2 });
}

const consumerRoot = fileURLToPath(new URL('../../', import.meta.url));
const privateRoot = process.argv[2];
assert.ok(privateRoot);
for (const entrypoint of ['@agen-ai/agent-orchestration', '@agen-ai/agent-orchestration/mcp', '@agen-ai/provider-acp/node', '@agen-ai/acp-registry/node']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(entrypoint)));
  assert.ok(resolved.startsWith(join(consumerRoot, 'node_modules') + sep), 'Qualification must load installed public tarballs.');
  assert.equal(resolved.startsWith(privateRoot + sep), false);
}
const root = await mkdtemp(join(tmpdir(), 'agenai-packed-managed-acp-'));
const ownership = new FixtureOwnership(root);
let primaryError: unknown;
let failed = false;
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts += 1; throw new Error('Registry and artifact network access are disabled for this offline proof.'); };
try {
  const { artifactRoot, tools } = await prepareArtifacts(root, join(consumerRoot, 'orchestration-fixtures'));
  const storeRoot = join(root, 'store');
  const store = await openAcpInstallationStore({ root: storeRoot });
  const fixtures: InstalledFixture[] = [];
  for (const mode of ['permission', 'cancel', 'malformed'] as const) {
    fixtures.push(await installFixture({ store, root, artifactRoot, tools, kind: 'binary', mode }));
  }
  const strictRoot = join(root, 'strict-extension');
  await mkdir(strictRoot);
  fixtures.push(await installFixture({ store, root: strictRoot, artifactRoot, tools, kind: 'binary', mode: 'permission' }));
  await proveSetupFailureOwnership(store, root, { artifactRoot, tools }, ownership);
  await rm(artifactRoot, { recursive: true });
  await positive(await openAcpInstallationStore({ root: storeRoot }), root, fixtures, ownership);
  assert.deepEqual(await readdir(join(storeRoot, 'installations')), []);
  assert.equal(fetchAttempts, 0);
  process.stdout.write(JSON.stringify({ proofKind: 'synthetic-packed-managed-acp-qualification',
    schemaProfile: 'schema-v1.23.0', parents: 2, managedChildren: 2, completionEnvelopes: 2,
    crossParentToolsDenied: 6, unsupportedHttpRejectedBeforeOpen: true, acceptedButUnexposedFailsQualification: true,
    defaultStandardCorrelatedVendorErrors: true, explicitRejectBeforePromptAndTools: true, explicitRejectCleanupClosed: true,
    childConfigurationBeforePrompt: true, installationReferencesReleasedAfterProcesses: true,
    registryFetchAttempts: fetchAttempts }) + '\n');
  process.stdout.write('External packed ACP managed delegation qualification passed.\n');
} catch (error) {
  primaryError = error;
  failed = true;
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  try { await ownership.retire(); }
  catch (cleanupError) {
    process.stderr.write(JSON.stringify({ retainedFixtureRoot: root, responsibilities: ownership.responsibilities }) + '\n');
    if (failed) throw new AggregateError([primaryError, cleanupError], 'Synthetic qualification failed; cleanup ownership and its root remain retained.');
    throw cleanupError;
  }
}
