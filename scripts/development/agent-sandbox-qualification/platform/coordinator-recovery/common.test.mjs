import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha } from '../coordinator/evidence.mjs';
import { compareEngineInventory, loadOriginal, originalCanonical } from './common.mjs';

async function retainedOriginal(directory, { format = 'agenai.desktop-coordinator-resource-saver.v1', b = { kind: 'destroyed' }, vmPreparation } = {}) {
  const output = join(directory, 'controller'); await mkdir(output, { recursive: true });
  const engine = 'unix:///engine.sock', id = 'engine-id';
  const config = { output, platform: { engine, profile: 'desktop-apple-virtualization-native-arm64', expected: { controller: { nodeVersion: process.versions.node } } },
    capabilities: { network: { routeAuthority: { engine: { id } } } }, ...(vmPreparation === undefined ? {} : { vmPreparation }) };
  const record = { namespace: 'ms003-a', operationId: 'operation-a', sandboxId: 'sandbox-a', resources: [{ identity: { kind: 'identified' } }] };
  const originalInput = join(directory, 'controller-input.json'), checkpoint = join(output, 'checkpoint-0001.json');
  const write = async (path, value) => { const bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes); return { path, bytes: bytes.length, sha256: sha(bytes) }; };
  const input = await write(originalInput, config), stored = await write(checkpoint, record);
  const retainedReport = join(output, 'retained-report-001.json');
  await write(retainedReport, { format, input, status: 'retained_cleanup', socket: { endpoint: engine }, engine: { id },
    coordinator: { generation: '10077b20-1d2e-406e-8a1b-ceb45d613ea6' },
    members: [{ label: 'a', namespace: record.namespace, checkpoints: [stored], originalRecord: record }, { label: 'b', finalState: b }] });
  return { originalInput, retainedReport, checkpoint };
}

test('original-generation cleanup selects the one retained member of an MS003 report and refuses another retained member or report family', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-oc-')));
  try {
    await assert.rejects(loadOriginal(await retainedOriginal(join(directory, 'retained-b'), { b: { kind: 'stopped' } })), /every other original member/u);
    await assert.rejects(loadOriginal(await retainedOriginal(join(directory, 'ms005'), { format: 'agenai.desktop-coordinator-ms005-exploratory.v1' })),
      /accepts only an MS004 or MS003/u);
  } finally { await rm(directory, { recursive: true }); }
});

test('cleanup inventory allows a Resource Saver boot to replace only the default bridge', () => {
  const record = { resources: [{ role: 'export', identity: { kind: 'identified', id: 'export' } }] };
  const before = { daemonId: 'd', containers: ['export', 'other'], volumes: [], networks: ['bridge-1', 'host'], defaultBridge: 'bridge-1' };
  const after = { daemonId: 'd', containers: ['other'], volumes: [], networks: ['bridge-2', 'host'], defaultBridge: 'bridge-2' };
  assert.deepEqual(compareEngineInventory(before, after, record, { coldVm: true }), { before: 'bridge-1', after: 'bridge-2' });
  assert.throws(() => compareEngineInventory(before, after, record), /introduced a new Engine resource identity/u);
  assert.equal(compareEngineInventory(before, { ...after, networks: before.networks, defaultBridge: 'bridge-1' }, record, { coldVm: true }), null);
  assert.throws(() => compareEngineInventory(before, { ...after, networks: ['bridge-2'] }, record, { coldVm: true }),
    /changed an unrelated original Engine identity/u);
});

test('original-generation cleanup loads a retained MS003 or MS004 member and allows a bridge replacement only for an unprepared VM',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-oc-')));
    try {
      for (const format of ['agenai.desktop-coordinator-resource-saver.v1', 'agenai.desktop-coordinator-ms004-exploratory.v1']) {
        const loaded = await loadOriginal(await retainedOriginal(join(directory, format), { format }));
        assert.equal(loaded.member.label, 'a'); assert.equal(loaded.record.operationId, 'operation-a');
        assert.equal(loaded.generation, '10077b20-1d2e-406e-8a1b-ceb45d613ea6'); assert.equal(loaded.coldVm, true);
      }
      const prepared = await retainedOriginal(join(directory, 'prepared'), { vmPreparation: join(directory, 'vm-preparation/report.json') });
      assert.equal((await loadOriginal(prepared)).coldVm, false);
    } finally { await rm(directory, { recursive: true }); }
  });

test('canonical evidence preserves complete native framing and refuses corrupt or truncated original bytes', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-oc-')));
  const path = join(directory, 'canonical.bin'); const engine = 'c'.repeat(64);
  const payload = Buffer.from(JSON.stringify({ format: 'agenai.docker-desktop-coordinator.v1', engineKey: `sha256:${engine}`,
    generation: { kind: 'dirty', identity: { generationId: 'original' } } }));
  const bytes = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${engine}\n${sha(payload)}\n`), payload]);
  try {
    await writeFile(path, bytes); const original = await originalCanonical(path);
    assert.deepEqual(original.bytes, bytes); assert.equal(original.identity.sha256, sha(bytes));
    assert.equal(original.payload.sha256, sha(payload)); assert.equal(original.value.generation.identity.generationId, 'original');
    assert.deepEqual(await readFile(path), bytes);
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 2] ^= 1; await writeFile(path, corrupt);
    await assert.rejects(originalCanonical(path), /checksum differs/u);
    await writeFile(path, Buffer.from('AGENAI-SNAPSHOT-1\n'));
    await assert.rejects(originalCanonical(path), /framing is incomplete/u);
  } finally { await rm(directory, { recursive: true }); }
});
