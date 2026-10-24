// ------------------------------------------------------------------------------------------------
//                containment.test.ts - Real bounded failure workloads - Independent Engine/cgroup proof
// ------------------------------------------------------------------------------------------------

import { importFixtures, exportFixtures, type FixtureFile } from '../fixtures/trees.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import type { SandboxRecoveryRecord, SandboxRequest, SandboxReservation } from '@agen-ai/sandbox';
import { atomicJson, collectBytes, engineGet, failureSummary, inspectAbsent, openSuite,
  reservePersisted, resourceId, sandboxRequest } from './support/common.js';
import type { ResourceObservation, ResourceRole } from './support/common.js';
import { eventually, locateCgroup, observePeerControl, readCgroup, sendCommand } from './support/containment.js';
import { checkCleanupEvidence } from './support/evidence.js';
import { readKernelText } from './support/kernel.js';
import type { CleanupEvidenceEvent, CleanupEvidenceReport, CleanupEvidenceRow } from './support/evidence.js';

interface OwnedScenarioSandbox {
  readonly label: string;
  readonly request: SandboxRequest;
  readonly owner: SandboxReservation;
}

interface ScenarioContext {
  readonly owners: OwnedScenarioSandbox[];
  readonly checkpoints: ResourceObservation[];
  readonly observations: unknown[];
  readonly controls: ReturnType<typeof observePeerControl>[];
  readonly cleanupEvidenceRows: CleanupEvidenceRow[];
  reserve(label: string, request?: SandboxRequest): SandboxReservation;
}

async function readOutput(stream: Readable, maximum: number, slow = false) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let error: unknown;
  try {
    for await (const chunk of stream) {
      assert(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      assert(bytes <= maximum, 'The public reader exceeded the independent fixture collection bound.');
      chunks.push(Buffer.from(chunk));
      if (slow) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  } catch (cause) {
    if (cause instanceof assert.AssertionError) throw cause;
    error = cause;
  }
  return { bytes: Buffer.concat(chunks), error };
}

function counter(value: Readonly<Record<string, number>>, name: string): number {
  const count = value[name];
  assert(typeof count === 'number', `Kernel observation omitted ${name}.`);
  return count;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

test('real Docker contains finite failure workloads and preserves exact concurrent cleanup ownership', { timeout: 600_000 }, async (t) => {
  const suite = await openSuite('containment');
  const peer = await readFile(new URL('./fixtures/containment-peer.mjs', import.meta.url));
  const reports: unknown[] = [];
  const suiteCleanupRows: CleanupEvidenceRow[] = [];

  const observeClose = async (context: ScenarioContext, owner: SandboxReservation, label: string,
    close: () => Promise<void>, roles?: readonly ResourceRole[]) => {
    const record = owner.recoveryRecord;
    await close();
    const expected = record.resources.filter((resource) => !roles || roles.includes(resource.role)).map((resource) => {
      assert(resource.identity.kind === 'identified', 'A cleanup claim needs the exact identity retained before SDK close.');
      return { role: resource.role, id: resource.identity.id };
    });
    const events: CleanupEvidenceEvent[] = [{ sequence: 1, kind: 'sdk-close', result: 'fulfilled' }];
    context.cleanupEvidenceRows.push({ label, expected, events });
    const observed: ResourceObservation[] = [];
    try { await inspectAbsent(suite.endpoint, record, label, observed, roles); }
    finally {
      context.checkpoints.push(...observed);
      for (const observation of observed) events.push({ sequence: events.length + 1, kind: 'observation', source: 'independent-engine',
        role: observation.role, id: observation.id, httpStatus: observation.httpStatus });
    }
  };

  const run = async (name: string, body: (context: ScenarioContext) => Promise<void>) => {
    await t.test(name, { timeout: 120_000 }, async () => {
      const directory = path.join(suite.directory, name);
      await mkdir(directory, { mode: 0o700 });
      const owners: OwnedScenarioSandbox[] = [];
      const checkpoints: ResourceObservation[] = [];
      const observations: unknown[] = [];
      const controls: ReturnType<typeof observePeerControl>[] = [];
      const cleanupEvidenceRows: CleanupEvidenceRow[] = [];
      const cleanupFailures: Array<{ operation: string; label: string; error: unknown }> = [];
      const cleanupOutcomes: unknown[] = [];
      let primaryFailure: Readonly<{ error: unknown }> | undefined;
      const context: ScenarioContext = { owners, checkpoints, observations, controls, cleanupEvidenceRows,
        reserve(label, request = sandboxRequest({ executionTimeoutMs: 20_000 })) {
          const owner = reservePersisted(suite.backend, request, directory, label);
          owners.push({ label, request, owner });
          return owner;
        } };
      try {
        await body(context);
      } catch (error) { primaryFailure = { error }; }
      finally {
        for (const { label, owner } of owners) {
          let sdkDestroyFulfilled = false;
          try {
            await observeClose(context, owner, `${name}-${label}-finally-destroy`, async () => {
              await owner.destroy();
              sdkDestroyFulfilled = true;
              cleanupOutcomes.push({ label, operation: 'finally-sdk-destroy', verdict: 'passed' });
            });
          } catch (error) {
            cleanupFailures.push({ label, operation: sdkDestroyFulfilled ? 'independent-final-inspection' : 'finally-sdk-destroy', error });
            if (!sdkDestroyFulfilled) cleanupOutcomes.push({ label, operation: 'finally-sdk-destroy', verdict: 'failed', error: failureSummary(error) });
          }
          // Also retain the independently inspected final disposition if the SDK close itself failed.
          if (cleanupFailures.some((failure) => failure.label === label)) {
            try { await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'finally-failed-close-disposition', checkpoints); }
            catch (error) { cleanupFailures.push({ label, operation: 'independent-final-inspection', error }); }
          }
        }
        let controlsSettled = false;
        void Promise.all(controls.map((control) => control.settled)).then(() => { controlsSettled = true; });
        try { await eventually(async () => controlsSettled, (settled) => settled, 'Peer-control readers did not settle after SDK cleanup.'); }
        catch (error) { cleanupFailures.push({ label: name, operation: 'peer-control-join', error }); }
        const cleanupEvidence: CleanupEvidenceReport = { format: 'agenai.sandbox-cleanup-evidence.v1', rows: cleanupEvidenceRows };
        try { assert.equal(checkCleanupEvidence(cleanupEvidence).kind, 'accepted'); }
        catch (error) { cleanupFailures.push({ label: name, operation: 'cleanup-evidence-check', error }); }
        suiteCleanupRows.push(...cleanupEvidenceRows);
        const report = { name, verdict: primaryFailure || cleanupFailures.length ? 'failed' : 'passed',
          primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null,
          cleanupFailures: cleanupFailures.map((entry) => ({ ...entry, error: failureSummary(entry.error) })), cleanupOutcomes,
          records: owners.map(({ label, request, owner }) => ({ label, request, record: owner.recoveryRecord })),
          observations, checkpoints, cleanupEvidence,
          peerControls: controls.map((control) => ({ messages: control.messages, finalStreamFailure: failureSummary(control.failure) })) };
        reports.push(report);
        try { await atomicJson(path.join(directory, 'report.json'), report); }
        catch (error) { cleanupFailures.push({ label: name, operation: 'report-write', error }); }
      }
      if (primaryFailure || cleanupFailures.length) throw new AggregateError([
        ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures.map((entry) => entry.error),
      ], `Containment scenario ${name} failed; original and finally outcomes are separately retained.`);
    });
  };

  const startPeer = async (context: ScenarioContext, owner: SandboxReservation, scenario: string, marker: string,
    files: readonly FixtureFile[] = []) => {
    const sandbox = await owner.start();
    await importFixtures(sandbox, [{ path: 'containment-peer.mjs', bytes: peer, executable: false }, ...files]);
    const processOwner = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: [`${sandbox.workspace}/containment-peer.mjs`, scenario, marker],
      env: {}, cwd: sandbox.workspace });
    const streams = await processOwner.start();
    const control = observePeerControl(streams.stderr, marker);
    context.controls.push(control);
    const ready = await control.wait('ready');
    assert.equal(ready.node, 'v24.18.0');
    assert.equal(ready.scenario, scenario);
    assert(typeof ready.pid === 'number' && Number.isSafeInteger(ready.pid) && ready.pid > 0);
    context.observations.push({ kind: 'process-entered', processId: processOwner.id, computeId: resourceId(owner.recoveryRecord, 'compute'), ready });
    return { sandbox, streams, control };
  };

  const automaticClose = async (context: ScenarioContext, owner: SandboxReservation, checkpoint: string) => {
    const compute = resourceId(owner.recoveryRecord, 'compute');
    await eventually(() => engineGet(suite.endpoint, `/containers/${compute}/json`), (result) => result.status === 404,
      'The SDK did not automatically remove the exact workload before explicit cleanup.');
    await inspectAbsent(suite.endpoint, owner.recoveryRecord, checkpoint, context.checkpoints, ['compute']);
  };

  const sdkClose = async (context: ScenarioContext, owner: SandboxReservation) => {
    await observeClose(context, owner, `${owner.id}-sdk-stop-before-export`, () => owner.stop(), ['compute']);
  };

  await run('fork-without-exec-closed-stdio', async (context) => {
    const owner = context.reserve('fork');
    const sandbox = await owner.start();
    const marker = `agenai-ms005-${randomUUID()}`;
    const iterations = 10_000_000;
    const script = `(i=0; while [ "$i" -lt ${iterations} ]; do i=$((i + 1)); done) </dev/null >/dev/null 2>&1 & child=$!; printf '{"marker":"%s","pid":%s}\\n' "$0" "$child"; exit 17`;
    const processOwner = sandbox.reserveProcess({ executable: '/bin/sh', args: ['-c', script, marker], env: {}, cwd: sandbox.workspace });
    const streams = await processOwner.start();
    const [stdout, stderr, exit] = await Promise.all([collectBytes(streams.stdout), collectBytes(streams.stderr), streams.exit]);
    assert.deepEqual(exit, { kind: 'exited', code: 17 });
    assert.deepEqual(stderr, Buffer.alloc(0));
    const forked = object(JSON.parse(stdout.toString('utf8')));
    assert.equal(forked.marker, marker);
    assert(typeof forked.pid === 'number' && Number.isSafeInteger(forked.pid) && forked.pid > 0);
    const compute = resourceId(owner.recoveryRecord, 'compute');
    const top = await engineGet(suite.endpoint, `/containers/${compute}/top`);
    assert.equal(top.status, 200);
    const table = object(top.body);
    assert(Array.isArray(table.Titles) && table.Titles.every((entry: unknown) => typeof entry === 'string'));
    assert(Array.isArray(table.Processes));
    const rows = table.Processes.map((row: unknown) => { assert(Array.isArray(row) && row.every((field: unknown) => typeof field === 'string')); return row as string[]; });
    const descendants = rows.filter((row) => row.some((field) => field.includes(marker)));
    assert.equal(descendants.length, 1, 'The forked shell builtin must remain alive after its leader exits and output reaches EOF.');
    const pidColumn = table.Titles.indexOf('PID');
    assert(pidColumn >= 0);
    const hostPid = Number(descendants[0]?.[pidColumn]);
    assert(Number.isSafeInteger(hostPid) && hostPid > 0);
    const status = await readKernelText(`/proc/${hostPid}/status`);
    const namespacePids = /^NSpid:\s+(.+)$/mu.exec(status)?.[1]?.trim().split(/\s+/u).map(Number);
    assert(namespacePids && namespacePids.length >= 2);
    assert.equal(namespacePids.at(-1), forked.pid, 'The independently observed host PID must be the exact guest fork.');
    context.observations.push({ kind: 'fork-without-exec', marker, guestPid: forked.pid, hostPid,
      leaderExit: exit, finiteBuiltinIterations: iterations, stdio: 'closed-by-redirection', titles: table.Titles, row: descendants[0], namespacePids });
    await sdkClose(context, owner);
    assert.deepEqual(await streams.exit, { kind: 'exited', code: 17 });
  });

  await run('slow-reader-output-overflow', async (context) => {
    const maxOutputBytes = 32 * 1024;
    const maxBufferedOutputBytes = 16 * 1024;
    const highWaterMarkBytes = 4096;
    const owner = context.reserve('overflow', sandboxRequest({ executionTimeoutMs: 20_000,
      streams: { maxOutputBytes, maxBufferedOutputBytes, highWaterMarkBytes } }));
    const { streams, control } = await startPeer(context, owner, 'flood', `agenai-ms005-${randomUUID()}`);
    await sendCommand(streams.stdin, { command: 'begin' });
    await eventually(async () => streams.stdout.readableLength, (length) => length >= highWaterMarkBytes,
      'The paused public reader never retained its bounded first output chunk.');
    const bufferedBeforeRead = streams.stdout.readableLength;
    assert(bufferedBeforeRead <= maxBufferedOutputBytes);
    assert.notEqual(streams.stdout.readableFlowing, true);
    const compute = resourceId(owner.recoveryRecord, 'compute');
    const paused = await engineGet(suite.endpoint, `/containers/${compute}/json`);
    assert.equal(paused.status, 200);
    assert.equal(object(object(paused.body).State).Running, true);
    const output = await readOutput(streams.stdout, maxOutputBytes, true);
    const outputError = object(output.error);
    assert.equal(outputError.code, 'output_limit');
    assert(output.bytes.byteLength >= highWaterMarkBytes && output.bytes.byteLength <= maxOutputBytes);
    assert(output.bytes.every((byte) => byte === 0xa5), 'The slow reader must preserve the admitted flood bytes.');
    await automaticClose(context, owner, 'output-limit-auto-stop-before-explicit-cleanup');
    await sdkClose(context, owner);
    assert.equal(control.messages.some((message) => message.kind === 'flood-complete'), false);
    context.observations.push({ kind: 'slow-reader-output-limit', maxOutputBytes, maxBufferedOutputBytes, highWaterMarkBytes,
      bufferedBeforeRead, independentRunningWhilePaused: true, acceptedBytes: output.bytes.byteLength,
      failure: failureSummary(output.error), leaderExit: await streams.exit });
  });

  await run('execution-deadline', async (context) => {
    const executionTimeoutMs = 3000;
    const owner = context.reserve('deadline', sandboxRequest({ executionTimeoutMs }));
    const { streams, control } = await startPeer(context, owner, 'hold', `agenai-ms005-${randomUUID()}`);
    const output = readOutput(streams.stdout, 1024);
    await sendCommand(streams.stdin, { command: 'begin' });
    await control.wait('hold-entered');
    await automaticClose(context, owner, 'deadline-auto-stop-before-explicit-cleanup');
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
    assert.equal(control.messages.some((message) => message.kind === 'hold-complete'), false);
    assert.deepEqual((await output).bytes, Buffer.from('held-output\n'));
    await sdkClose(context, owner);
    context.observations.push({ kind: 'execution-deadline', executionTimeoutMs, guestHoldMs: 20_000,
      observedEnteredBeforeClosure: true, leaderExit: await streams.exit });
  });

  await run('memory-exhaustion', async (context) => {
    const memoryBytes = 256 * 1024 ** 2;
    const owner = context.reserve('memory', sandboxRequest({ memoryBytes, executionTimeoutMs: 20_000 }));
    const { sandbox, streams, control } = await startPeer(context, owner, 'memory', `agenai-ms005-${randomUUID()}`);
    const output = readOutput(streams.stdout, 1024);
    const compute = resourceId(owner.recoveryRecord, 'compute');
    const location = await locateCgroup(suite.endpoint, compute);
    const before = await readCgroup(location);
    assert.equal(before.memory.maximum, memoryBytes);
    assert.equal(before.memory.swapMaximum, 0);
    await sendCommand(streams.stdin, { command: 'begin' });
    const after = await eventually(() => readCgroup(location), (snapshot) => counter(snapshot.memory.events, 'oom_kill') > counter(before.memory.events, 'oom_kill'),
      'The touched-page memory workload did not independently increment its cgroup OOM-kill counter.');
    assert(counter(after.memory.events, 'oom') > counter(before.memory.events, 'oom'));
    assert.equal(after.memory.maximum, memoryBytes);
    const exit = await streams.exit;
    assert.deepEqual(exit, { kind: 'exited', code: 137 });
    const liveInspection = await engineGet(suite.endpoint, `/containers/${compute}/json`);
    assert.equal(liveInspection.status, 200, 'OOM evidence must be observed while the exact container still exists.');
    assert.equal(control.messages.some((message) => message.kind === 'memory-uncontained'), false);
    await sdkClose(context, owner);
    const files = await exportFixtures(sandbox, ['containment.json']);
    assert.equal(files.length, 1);
    const progress = object(JSON.parse(Buffer.from(files[0]!.bytes).toString('utf8')));
    assert.equal(progress.kind, 'memory-progress');
    assert.equal(progress.chunkBytes, 4 * 1024 ** 2);
    assert.equal(progress.allocationCeilingBytes, 384 * 1024 ** 2);
    assert(typeof progress.allocatedBytes === 'number' && progress.allocatedBytes > 0 && progress.allocatedBytes < memoryBytes);
    assert.deepEqual((await output).bytes, Buffer.alloc(0));
    context.observations.push({ kind: 'memory-exhaustion', computeId: compute, before, after, exit,
      independentContainerAfterOom: liveInspection.body, progress });
  });

  await run('pid-exhaustion', async (context) => {
    const pids = 32;
    const owner = context.reserve('pids', sandboxRequest({ pids, memoryBytes: 256 * 1024 ** 2, executionTimeoutMs: 20_000 }));
    const { sandbox, streams, control } = await startPeer(context, owner, 'pids', `agenai-ms005-${randomUUID()}`);
    const output = readOutput(streams.stdout, 1024);
    const compute = resourceId(owner.recoveryRecord, 'compute');
    const location = await locateCgroup(suite.endpoint, compute);
    const before = await readCgroup(location);
    assert.equal(before.pids.maximum, pids);
    await sendCommand(streams.stdin, { command: 'begin' });
    const result = await control.wait('pids-result');
    assert.equal(result.attempts, 64);
    assert(typeof result.spawned === 'number' && result.spawned > 0 && result.spawned < pids);
    assert.equal(result.rejected, 64 - result.spawned);
    assert.deepEqual(result.errors, { EAGAIN: result.rejected });
    const after = await readCgroup(location);
    assert.equal(after.pids.maximum, pids);
    assert.equal(after.pids.current, pids, 'The independent kernel census must reach the configured PID ceiling.');
    assert(counter(after.pids.events, 'max') > counter(before.pids.events, 'max'));
    const live = await engineGet(suite.endpoint, `/containers/${compute}/json`);
    assert.equal(live.status, 200);
    assert.equal(object(object(live.body).State).Running, true);
    await sdkClose(context, owner);
    const files = await exportFixtures(sandbox, ['containment.json']);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(Buffer.from(files[0]!.bytes).toString('utf8')), result);
    assert.deepEqual((await output).bytes, Buffer.alloc(0));
    context.observations.push({ kind: 'pid-exhaustion', computeId: compute, before, after, result, leaderExit: await streams.exit });
  });

  await run('abandoned-output-reader', async (context) => {
    const owner = context.reserve('abandoned');
    const { streams, control } = await startPeer(context, owner, 'hold', `agenai-ms005-${randomUUID()}`);
    await sendCommand(streams.stdin, { command: 'begin' });
    await control.wait('hold-entered');
    await eventually(async () => streams.stdout.readableLength, (length) => length === 12,
      'The abandoned reader must first own the exact held output bytes.');
    streams.stdout.destroy();
    await automaticClose(context, owner, 'reader-abandon-auto-stop-before-explicit-cleanup');
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
    assert.equal(control.messages.some((message) => message.kind === 'hold-complete'), false);
    await sdkClose(context, owner);
    context.observations.push({ kind: 'reader-abandoned', bufferedBytesAtAbandonment: 12, leaderExit: await streams.exit });
  });

  await run('paired-isolation-concurrent-cleanup', async (context) => {
    const ownerA = context.reserve('isolation-a');
    const ownerB = context.reserve('isolation-b');
    const markerA = `agenai-ms005-${randomUUID()}`;
    const markerB = `agenai-ms005-${randomUUID()}`;
    const fileA = `private-${randomUUID()}.txt`;
    const fileB = `private-${randomUUID()}.txt`;
    const [a, b] = await Promise.all([
      startPeer(context, ownerA, 'isolation', markerA, [{ path: fileA, bytes: Buffer.from(markerA), executable: false }]),
      startPeer(context, ownerB, 'isolation', markerB, [{ path: fileB, bytes: Buffer.from(markerB), executable: false }]),
    ]);
    await Promise.all([
      sendCommand(a.streams.stdin, { command: 'begin', ownFile: fileA, foreignFile: fileB, foreignMarker: markerB }),
      sendCommand(b.streams.stdin, { command: 'begin', ownFile: fileB, foreignFile: fileA, foreignMarker: markerA }),
    ]);
    const [resultA, resultB] = await Promise.all([a.control.wait('isolation-result'), b.control.wait('isolation-result')]);
    for (const [result, marker] of [[resultA, markerA], [resultB, markerB]] as const) {
      assert.equal(result.ownContent, marker);
      assert.equal(result.foreignFileStatus, 'absent');
      assert.deepEqual(result.foreignProcesses, []);
      assert(typeof result.visibleProcessCount === 'number' && result.visibleProcessCount >= 2 && result.visibleProcessCount < 32);
    }
    assert.notEqual(resourceId(ownerA.recoveryRecord, 'storage'), resourceId(ownerB.recoveryRecord, 'storage'));
    await sdkClose(context, ownerA);
    const computeB = resourceId(ownerB.recoveryRecord, 'compute');
    const stillRunningB = await engineGet(suite.endpoint, `/containers/${computeB}/json`);
    assert.equal(stillRunningB.status, 200);
    assert.equal(object(object(stillRunningB.body).State).Running, true);
    const nonce = randomUUID();
    await sendCommand(b.streams.stdin, { command: 'ping', nonce });
    const pong = await b.control.wait('pong');
    assert.deepEqual(pong, { kind: 'pong', nonce, ownContent: markerB, marker: markerB });
    await Promise.all([
      observeClose(context, ownerA, 'paired-a-concurrent-sdk-destroy', () => ownerA.destroy()),
      observeClose(context, ownerB, 'paired-b-concurrent-sdk-destroy', () => ownerB.destroy()),
    ]);
    context.observations.push({ kind: 'paired-isolation', markerA, markerB, fileA, fileB, resultA, resultB, pong,
      exactStorageIds: [resourceId(ownerA.recoveryRecord, 'storage'), resourceId(ownerB.recoveryRecord, 'storage')] });
  });

  await run('same-sandbox-concurrent-stop-destroy', async (context) => {
    const owner = context.reserve('concurrent');
    const { streams, control } = await startPeer(context, owner, 'hold', `agenai-ms005-${randomUUID()}`);
    const output = readOutput(streams.stdout, 1024);
    await sendCommand(streams.stdin, { command: 'begin' });
    await control.wait('hold-entered');
    const identities: SandboxRecoveryRecord = owner.recoveryRecord;
    let outcomes: PromiseSettledResult<void>[] = [];
    await observeClose(context, owner, 'same-sandbox-concurrent-sdk-stop-destroy-returned', async () => {
      outcomes = await Promise.allSettled([owner.stop(), owner.destroy(), owner.stop(), owner.destroy()]);
      assert.deepEqual(outcomes.map((entry) => entry.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    });
    assert.deepEqual(owner.state, { kind: 'destroyed' });
    assert.deepEqual((await output).bytes, Buffer.from('held-output\n'));
    assert.deepEqual(await streams.exit, { kind: 'unavailable', reason: 'sandbox_stopped' });
    context.observations.push({ kind: 'same-sandbox-concurrent-stop-destroy', outcomes: outcomes.map((entry) => entry.status),
      exactResourceIds: identities.resources.map((resource) => ({ role: resource.role, id: resource.identity.kind === 'identified' ? resource.identity.id : resource.name })),
      leaderExit: await streams.exit });
  });

  const cleanupEvidence: CleanupEvidenceReport = { format: 'agenai.sandbox-cleanup-evidence.v1', rows: suiteCleanupRows };
  await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-containment-evidence.v1',
    endpoint: suite.endpoint, namespace: suite.namespace, imageDigest: suite.imageDigest, user: suite.user,
    node: process.version, controllerPid: process.pid, scenarios: reports, cleanupEvidence, modelCalls: 0, credentialReads: 0 });
  assert.equal(checkCleanupEvidence(cleanupEvidence).kind, 'accepted');
});
