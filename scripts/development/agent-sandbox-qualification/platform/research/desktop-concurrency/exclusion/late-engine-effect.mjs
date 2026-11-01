// Explicit MS001 fixture. The root researcher must review it before invoking --run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as controller from './controller.mjs';
import { observeEndpoint, assertBoundObservation } from './endpoint-binding.mjs';
import { prepare } from './prepare.mjs';
import { createGateway } from './late-engine-gateway.mjs';
import { selectSubnet } from './late-engine-ipam.mjs';
import { requestJson, sha256, writeReceipt } from './late-engine-transport.mjs';

export const fixturePlan = Object.freeze({ researchOnly: true, requiresExplicitRun: true,
  originalControllerDeath: 'SIGKILL after independent parent gateway durably accepts one original request',
  engineEffects: ['at most one internal IPv4 bridge-network create', 'at most one delete by its exact returned ID'],
  lateAuthority: 'request is retained in the independent parent gateway before actual Engine dispatch; never replayed',
  dirtyBarrier: 'same native helper journal and daemon-derived key in one unique scratch authority root',
  cleanup: 'join original acknowledgement, verify exact original labels/IPAM/ID, persist delete intent, verify exact absence',
  unsupported: 'production crash settlement, arbitrary proxy recovery, Engine-internal queued request proof, workload survival' });

const until = async (operation) => {
  for (let index = 0; index < 250; index++) { if (await operation()) return; await delay(20); }
  throw new Error('fixture_bounded_wait_expired');
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childReady = (child) => new Promise((resolve, reject) => {
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('controller_ready_timeout')); }, 15000);
  createInterface({ input: child.stdout }).once('line', (line) => {
    clearTimeout(deadline);
    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
  });
  child.once('exit', (code, signal) => { clearTimeout(deadline); reject(new Error(`controller_before_ready:${code}:${signal}:${stderr}`)); });
  child.once('error', (error) => { clearTimeout(deadline); reject(error); });
});
const bounded = (promise, milliseconds, name) => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error(name)), milliseconds);
  promise.then((value) => { clearTimeout(deadline); resolve(value); }, (error) => { clearTimeout(deadline); reject(error); });
});

export async function runLateEngineEffect(frozenInput) {
  const bytes = await readFile(frozenInput);
  const input = JSON.parse(bytes);
  const endpoint = input.platform.engine;
  const expected = input.platform.expected.daemon;
  assert.equal(endpoint, 'unix:///Users/tan/.docker/run/docker.sock');
  assert.equal(expected.id, input.capabilities.network.routeAuthority.engine.id);
  const attempt = await mkdtemp('/private/tmp/agenai-ms001-exclusion-');
  const prepared = await prepare(attempt);
  const sourceNames = ['lock-holder.c', 'controller.mjs', 'prepare.mjs', 'endpoint-binding.mjs',
    'late-engine-effect.mjs', 'late-engine-controller.mjs', 'late-engine-gateway.mjs', 'late-engine-ipam.mjs', 'late-engine-transport.mjs'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceNames.map(async (name) =>
    [name, sha256(await readFile(new URL(name, import.meta.url)))])));
  const engineReceipts = [];
  const identityReceipts = [];
  const events = [];
  const event = (stage, value = {}) => events.push({ at: new Date().toISOString(), stage, ...value });
  const engineSocket = decodeURIComponent(new URL(endpoint).pathname);
  const originalBinding = await observeEndpoint(endpoint, expected, identityReceipts);
  const census = await requestJson(engineSocket, 'GET', '/v1.52/networks', undefined, engineReceipts);
  assert.equal(census.status, 200);
  const ipam = selectSubnet(census.body);
  const attemptId = randomUUID();
  const requestId = randomUUID();
  const name = `agenai-ms001-late-${attemptId}`;
  const manifest = { mode: 'explicit-run', attempt, attemptId, requestId, endpoint, engineSocket, expected,
    binary: prepared.binary, gateway: join(attempt, 'held-create.sock'), name,
    subnet: ipam.subnet, gatewayAddress: ipam.gatewayAddress,
    bridgeName: `ag${sha256(Buffer.from(attemptId)).slice(0, 13)}` };
  const manifestPath = join(attempt, 'fixture-manifest.json');
  await writeReceipt(manifestPath, manifest);
  await writeReceipt(join(attempt, 'preflight.json'), { originalBinding, ipam, networkCensus: census });
  let gateway, child, childExited, ready, cleanupHolder, cleanupJournal, originalIntent, acknowledgement, exactId;
  let deleteEntered = false, deleteAcknowledged = false, absenceVerified = false, cleanPersisted = false;
  let failure;
  const checkEndpoint = async () => {
    const observed = await observeEndpoint(endpoint, expected, identityReceipts);
    assertBoundObservation(originalBinding, observed);
    return observed;
  };
  const inspect = async (identity) => requestJson(engineSocket, 'GET', `/v1.52/networks/${identity}`, undefined, engineReceipts);
  const checkpoint = async (record) => {
    const body = { sequence: cleanupJournal.sequence + 1, previous: cleanupJournal.previous, record };
    const checksum = controller.digest(body);
    await cleanupHolder.command(`APPEND ${JSON.stringify({ ...body, checksum })}`);
    cleanupJournal = { ...cleanupJournal, record, sequence: body.sequence, previous: checksum };
  };
  const verifyOriginal = (receipt) => {
    assert.equal(receipt.status, 200);
    const actual = receipt.body;
    assert.equal(actual.Id, exactId);
    assert.equal(actual.Name, name);
    assert.equal(actual.Driver, 'bridge');
    assert.equal(actual.Internal, true);
    assert.equal(actual.EnableIPv6, false);
    assert.equal(Object.keys(actual.Containers ?? {}).length, 0);
    assert.deepEqual(actual.Labels, originalIntent.body.Labels);
    assert.deepEqual(actual.IPAM.Config, originalIntent.body.IPAM.Config);
    assert.equal(actual.Options['com.docker.network.bridge.name'], manifest.bridgeName);
    return actual;
  };
  const acquireCleanup = async () => {
    cleanupHolder ??= await controller.openHolder(prepared.binary, expected.id);
    cleanupJournal = controller.parseJournal((await cleanupHolder.command('SNAPSHOT')).text);
    assert.equal(cleanupJournal.record.generation, originalIntent.generation);
    assert.equal(cleanupJournal.record.engineId, expected.id);
    assert.equal(cleanupJournal.record.members.length, 1);
    assert.equal(cleanupJournal.record.members[0].binding, controller.immutableMemberBinding(originalIntent.original));
  };
  const cleanupExactOnce = async () => {
    if (!exactId || deleteEntered || gateway.state !== 'joined' || gateway.forwardCount !== 1) throw new Error('cleanup_without_joined_original_effect');
    await checkEndpoint();
    if (!cleanupHolder) await acquireCleanup();
    const identified = verifyOriginal(await inspect(exactId));
    const fingerprint = `sha256:${controller.digest({ Id: identified.Id, Name: identified.Name,
      Labels: identified.Labels, IPAM: identified.IPAM, Options: identified.Options })}`;
    const memberIdentified = { ...originalIntent.original, phase: 'destroying',
      resources: [{ role: 'network', name, identity: { kind: 'identified', id: exactId, fingerprint } }] };
    await writeReceipt(join(attempt, 'original-member-identified.json'), memberIdentified);
    await checkpoint({ ...cleanupJournal.record, transition: { ...cleanupJournal.record.transition, state: 'identified',
      returned: { id: exactId, fingerprint }, fixtureOriginalJoined: { requestId, forwardCount: 1 } } });
    await checkpoint({ ...cleanupJournal.record, transition: { binding: controller.immutableMemberBinding(originalIntent.original),
      state: 'cleanup_delete_authorized', originalId: exactId, originalRequestId: requestId } });
    await checkEndpoint();
    deleteEntered = true;
    const removed = await requestJson(engineSocket, 'DELETE', `/v1.52/networks/${exactId}`, undefined, engineReceipts);
    await writeReceipt(join(attempt, 'original-delete-acknowledgement.json'), removed);
    assert.equal(removed.status, 204);
    deleteAcknowledged = true;
    const absentId = await inspect(exactId);
    const absentName = await inspect(name);
    assert.equal(absentId.status, 404);
    assert.equal(absentName.status, 404);
    const independent = await requestJson(engineSocket, 'GET', '/v1.52/networks', undefined, engineReceipts);
    assert.equal(independent.status, 200);
    assert.equal(independent.body.some((network) => network.Id === exactId || network.Name === name), false);
    const absence = { exactId: absentId, originalName: absentName,
      independentCensusSha256: independent.responseSha256, originalRequestJoined: true, forwardCount: gateway.forwardCount };
    await writeReceipt(join(attempt, 'original-exact-absence.json'), absence);
    absenceVerified = true;
    await checkEndpoint();
    const terminal = { ...memberIdentified, phase: 'destroyed' };
    await writeReceipt(join(attempt, 'original-member-destroyed.json'), terminal);
    await checkpoint({ ...cleanupJournal.record, members: [], transition: null, phase: 'clean',
      retiredMembers: [{ binding: controller.immutableMemberBinding(originalIntent.original), originalId: exactId }],
      fixtureSettlement: { requestId, createStatus: acknowledgement.status, deleteStatus: removed.status,
        knownEffectJoined: true, exactAbsenceVerified: true, absenceDigest: controller.digest(absence) } });
    cleanPersisted = true;
    event('original_exact_resource_removed_and_generation_clean', { exactId });
  };

  try {
    assert.equal((await inspect(name)).status, 404);
    gateway = await createGateway(manifest, engineReceipts);
    child = spawn(process.execPath, [fileURLToPath(new URL('./late-engine-controller.mjs', import.meta.url)), manifestPath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    childExited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) => resolve({ error: error.message }));
    });
    ready = await childReady(child);
    const accepted = await bounded(gateway.entered, 15000, 'original_gateway_admission_timeout');
    originalIntent = JSON.parse(await readFile(join(attempt, 'original-create-intent.json'), 'utf8'));
    assert.equal(originalIntent.generation, ready.generation);
    assert.equal(accepted.requestBodySha256, originalIntent.requestBodySha256);
    await writeReceipt(join(attempt, 'original-group-before-controller-death.json'),
      controller.parseJournal(await readFile(join(prepared.root, `${controller.engineKey(expected.id)}.journal`), 'utf8')).record);
    event('gateway_holds_original_message_before_engine_dispatch', { requestId, forwardCount: gateway.forwardCount });
    child.kill('SIGKILL');
    const death = await bounded(childExited, 5000, 'controller_death_timeout');
    assert.equal(death.signal, 'SIGKILL');
    await until(() => !alive(ready.helperPid));
    await bounded(gateway.disconnected, 5000, 'original_client_disconnect_timeout');
    await checkEndpoint();
    const absentWhileHeld = await inspect(name);
    assert.equal(absentWhileHeld.status, 404);
    assert.equal(gateway.forwardCount, 0);
    await writeReceipt(join(attempt, 'absent_after_controller_death_before_original_forward.json'),
      { death, helperExited: true, originalClientDisconnected: true, forwardCount: 0, exactNameObservation: absentWhileHeld });
    const copied = await import(pathToFileURL(join(prepared.copies[1].directory, 'controller.mjs')).href);
    await assert.rejects(copied.activate(prepared.translatedBinary, expected.id,
      { namespace: 'fresh-after-death', profile: 'rosetta-amd64', journalRoot: '/not-canonical-authority' }), /dirty_generation/);
    await acquireCleanup();
    assert.equal(cleanupJournal.record.transition.state, 'authorized');
    event('released_kernel_claim_and_current_absence_do_not_clear_dirty_barrier', { generation: originalIntent.generation });
    const latestCensus = await requestJson(engineSocket, 'GET', '/v1.52/networks', undefined, engineReceipts);
    assert.equal(latestCensus.status, 200);
    const latestIpam = selectSubnet(latestCensus.body);
    assert.equal(latestIpam.subnet, manifest.subnet);
    await writeReceipt(join(attempt, 'pre-forward-collision-recheck.json'), { latestCensus, latestIpam });
    await checkEndpoint();
    // The only release of the original request. No retry/reconstruction route exists.
    acknowledgement = await gateway.releaseOriginalOnce();
    assert.equal(acknowledgement.status, 201);
    assert.equal(acknowledgement.requestSha256, originalIntent.requestBodySha256);
    exactId = acknowledgement.body?.Id;
    assert.match(exactId, /^[a-f0-9]{64}$/u);
    assert.equal(gateway.forwardCount, 1);
    event('same_original_request_completed_after_controller_death', { exactId, requestId });
    await cleanupExactOnce();
    await cleanupHolder.close();
    cleanupHolder = undefined;
    const next = await copied.activate(prepared.translatedBinary, expected.id, { namespace: 'fresh-after-proven-clean' });
    try { await next.clean(); } finally { await next.holder.close(); }
    await checkEndpoint();
    assert.equal((await inspect(exactId)).status, 404);
    assert.equal((await inspect(name)).status, 404);
    event('fresh_generation_and_independent_exact_absence_verified');
  } catch (error) {
    failure = error;
    event('fixture_failed_retaining_original_obligations', { message: error.message });
    // A known successful create may still need its one exact cleanup attempt.
    if (exactId && !deleteEntered && gateway?.state === 'joined') {
      try { await cleanupExactOnce(); }
      catch (cleanupError) { event('exact_cleanup_failed_dirty_retained', { message: cleanupError.message }); }
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (childExited) await bounded(childExited, 5000, 'final_controller_join_timeout');
    if (gateway?.joined) await gateway.joined.catch((error) => event('original_forward_transport_uncertain', { message: error.message }));
    if (cleanupHolder) await cleanupHolder.close();
    if (gateway) await gateway.close();
    const report = { format: 'agenai.ms001-late-engine-effect.v1', fixture: fixturePlan, at: new Date().toISOString(), attempt,
      frozenInput, frozenInputSha256: sha256(bytes), sourceHashes, sourceDigestEncoding: 'SHA-256 of raw file bytes',
      command: [process.execPath, ...process.argv.slice(1)],
      node: process.version, platform: process.platform, architecture: process.arch, manifest, ipam,
      originalIntent, acknowledgement, exactReturnedId: exactId, forwardCount: gateway?.forwardCount ?? 0,
      deleteEntered, deleteAcknowledged, absenceVerified, cleanPersisted,
      engineReceipts, identityReceipts, events, result: failure ? 'failed' : 'passed', failure: failure?.stack,
      productionRootTouched: false, replayedCreateRequests: 0,
      warning: 'Only the original child controller dies; independent parent gateway authority remains. Not production crash settlement.' };
    await writeReceipt(join(attempt, 'late-engine-effect-report.json'), report);
    process.stdout.write(`${JSON.stringify({ attempt, result: report.result, exactId, forwardCount: report.forwardCount,
      cleanPersisted, report: join(attempt, 'late-engine-effect-report.json') }, null, 2)}\n`);
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--describe') process.stdout.write(`${JSON.stringify(fixturePlan, null, 2)}\n`);
  else if (process.argv[2] === '--run' && process.argv[3]) await runLateEngineEffect(process.argv[3]);
  else throw new Error('Review required. Use --describe; only explicit --run <frozen-input.json> performs the bounded mutations.');
}
