import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { validatePendingCut } from './cut.mjs';
import { sha } from './evidence.mjs';

function fixture(operation) {
  const id = 'a'.repeat(64); const name = 'original-compute';
  const identity = operation === 'create' ? { kind: 'creating' } : { kind: 'identified', id, fingerprint: 'original-fingerprint' };
  const record = { namespace: 'original-member', operationId: 'original-operation', sandboxId: 'original-sandbox',
    resources: [{ role: 'compute', name, identity }] };
  const pending = { kind: 'pending', effect: 17 };
  const ledger = { role: 'compute', create: operation === 'create' ? pending : { kind: 'settled', outcome: 'present' },
    start: operation === 'start' ? pending : { kind: 'not_entered' }, delete: operation === 'delete' ? pending : { kind: 'not_entered' } };
  const entered = { memberId: record.operationId, role: 'compute', action: operation, effectSequence: 17,
    reference: operation === 'create' ? name : id, result: { kind: 'unobserved' }, bindingDigest: 'original-binding', checkpointDigest: 'original-checkpoint' };
  const snapshot = { format: 'agenai.docker-desktop-coordinator.v1', engineKey: `sha256:${'b'.repeat(64)}`, daemonId: 'original-daemon',
    generation: { kind: 'dirty', identity: { generationId: 'original-generation' }, state: { kind: 'open' }, entered,
      members: [{ memberId: record.operationId, checkpoint: { record }, roles: [ledger] }] } };
  const target = operation === 'create' ? `/v1.52/containers/create?name=${name}`
    : `/v1.52/containers/${id}${operation === 'start' ? '/start' : '?force=true&v=false'}`;
  return { record, snapshot, target, operation, body: operation === 'create' ? JSON.stringify({ Id: id }) : '',
    method: operation === 'delete' ? 'DELETE' : 'POST' };
}

const childSource = `
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { Evidence, sha } from ${JSON.stringify(new URL('./evidence.mjs', import.meta.url).href)};
import { installLostAcknowledgement } from ${JSON.stringify(new URL('./effect-fault.mjs', import.meta.url).href)};
import { suspendAtResponse } from ${JSON.stringify(new URL('./cut.mjs', import.meta.url).href)};
const raw = readFileSync(process.argv[2]); const input = JSON.parse(raw);
const evidence = new Evidence(input.output); await evidence.initialize(raw); await mkdir(input.output + '/b');
const entry = { label: 'b', report: { namespace: input.record.namespace }, owner: { recoveryRecord: input.record, state: { kind: 'starting' } } };
const context = { input, evidence, report: { input: { path: process.argv[2], sha256: sha(raw) }, engine: { id: 'original-daemon' }, candidate: [], assets: [],
 sources: [{ original: process.argv[1], sha256: sha(readFileSync(process.argv[1])) }] }, scenario: { kind: input.phase === 'response-before-delivery' ? 'handoff' : 'lost-ack',
 fault: { operation: input.operation, role: 'compute' }, canonicalPath: input.canonical }, authority: { generation: 'original-generation' },
 members: [entry], faultMember: entry, signal: new AbortController().signal };
const cut = (receipt) => suspendAtResponse(context, input.phase, receipt);
installLostAcknowledgement({ socketPath: input.socketPath, select: () => true, evidence,
 ...(input.phase === 'response-before-delivery' ? { onResponseCut: cut } : { onErrorDeliveryCut: cut }) });
const request = http.request({ socketPath: input.socketPath, method: input.method, path: input.target, agent: false, headers: { connection: 'close' } },
 () => writeFileSync(input.marker + '-success', 'unexpected success'));
request.on('error', () => writeFileSync(input.marker + '-errors', 'first\\n', { flag: 'a' }));
request.on('error', () => writeFileSync(input.marker + '-errors', 'second\\n', { flag: 'a' }));
request.on('close', () => writeFileSync(input.marker + '-close', 'original close'));
request.end();
`;

for (const operation of ['create', 'start', 'delete']) for (const phase of ['response-before-delivery', 'request-error-listeners-returned']) {
  test(`real ${operation} HTTP ${phase} cut suspends its exact original child with the selected effect pending`, { timeout: 10_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-cut-'))); const socketPath = join(directory, 'e.sock');
    const selected = fixture(operation); const canonical = join(directory, 'canonical.bin');
    const payload = Buffer.from(JSON.stringify(selected.snapshot));
    const original = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${'b'.repeat(64)}\n${sha(payload)}\n`), payload]); await writeFile(canonical, original);
    const server = http.createServer((_request, response) => { response.statusCode = operation === 'create' ? 201 : 204; response.end(selected.body); });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const script = join(directory, 'child.mjs'); await writeFile(script, childSource);
    const input = { ...selected, canonical, socketPath, phase, output: join(directory, 'out'), marker: join(directory, 'marker') };
    const inputPath = join(directory, 'input.json'); await writeFile(inputPath, JSON.stringify(input));
    const child = spawn(process.execPath, [script, inputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let stderr = ''; child.stderr.on('data', (bytes) => { stderr += bytes; assert(stderr.length <= 64 * 1024); });
    try {
      const cut = await new Promise((resolve, reject) => {
        let raw = ''; const timer = setTimeout(() => reject(new Error(`Missing original cut: ${stderr}`)), 3000);
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`Original child exited before its cut: ${stderr}`)); });
        child.stdout.on('data', (bytes) => {
          raw += bytes; assert(raw.length <= 1024 ** 2);
          if (raw.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(raw.slice(0, raw.indexOf('\n')))); }
        });
      });
      assert.equal(cut.status, 'cut_ready'); assert.equal(cut.pid, child.pid); assert.equal(cut.phase, phase);
      // The child reports its cut before it suspends itself, so the stop may land just after the report.
      let stat = '';
      for (const deadline = Date.now() + 2000; !/T/u.test(stat) && Date.now() < deadline;) {
        ({ stdout: stat } = await promisify(execFile)('/bin/ps', ['-p', String(child.pid), '-o', 'stat=']));
        if (!/T/u.test(stat)) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(stat, /T/u);
      const report = JSON.parse(await readFile(cut.report.path, 'utf8'));
      assert.equal(report.handoff.pending.action, operation); assert.equal(report.handoff.pending.effectSequence, 17);
      assert.deepEqual(await readFile(report.handoff.preservedCanonical.path), original);
      assert.deepEqual(await readFile(canonical), original);
      await assert.rejects(readFile(input.marker + '-success'), { code: 'ENOENT' });
      await assert.rejects(readFile(input.marker + '-close'), { code: 'ENOENT' });
      if (phase === 'response-before-delivery') await assert.rejects(readFile(input.marker + '-errors'), { code: 'ENOENT' });
      else { assert.equal(await readFile(input.marker + '-errors', 'utf8'), 'first\nsecond\n'); assert.equal(report.handoff.receipt.errorListenersReturned, true); }
      if (operation === 'create' && phase === 'response-before-delivery') {
        child.kill('SIGCONT'); assert.equal((await closed).code, 0);
        const resumed = JSON.parse(await readFile(join(input.output, 'cut-resumed.json'), 'utf8'));
        assert.equal(resumed.pid, child.pid);
        assert.equal(await readFile(input.marker + '-errors', 'utf8'), 'first\nsecond\n');
        assert.equal(await readFile(input.marker + '-close', 'utf8'), 'original close');
        await assert.rejects(readFile(input.marker + '-success'), { code: 'ENOENT' });
      } else { child.kill('SIGKILL'); assert.equal((await closed).signal, 'SIGKILL'); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;
      await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true });
    }
  });
}

test('late settled, wrong-role and wrong-original-reference canonical records cannot qualify a pending response cut', () => {
  const selected = fixture('create'); const receipt = { complete: true, failures: [], selected: { method: selected.method, target: selected.target, status: 201 } };
  assert.equal(validatePendingCut(selected.snapshot, { operation: 'create', role: 'compute' }, selected.record, receipt).effectSequence, 17);
  for (const mutate of [
    (snapshot) => { snapshot.generation.entered = null; },
    (snapshot) => { snapshot.generation.entered.role = 'route_observer'; },
    (snapshot) => { snapshot.generation.entered.reference = 'another-original-resource'; },
    (snapshot) => { snapshot.generation.state = { kind: 'fenced' }; },
    (snapshot) => { snapshot.generation.members[0].roles[0].create = { kind: 'settled', outcome: 'present' }; },
  ]) {
    const snapshot = structuredClone(selected.snapshot); mutate(snapshot);
    assert.throws(() => validatePendingCut(snapshot, { operation: 'create', role: 'compute' }, selected.record, receipt));
  }
});
