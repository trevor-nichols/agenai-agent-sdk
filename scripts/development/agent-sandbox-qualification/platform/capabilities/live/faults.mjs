import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicationGate } from '../../../capabilities/live/publicationGate.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { SandboxStateError } from '@agen-ai/sandbox';
import { guest, send } from './installed.mjs';
import { sha } from './operations.mjs';

export function faultCases(context) {
  return [['published-commit-acknowledgement-withheld', async (run) => {
    let opened; let attached = false;
    const bytes = Buffer.from('single-native-publication-without-commit-ack');
    const gate = new PublicationGate(async (witness) => {
      run.evidence.publicationWitness = witness; await run.save();
      const native = await send(opened.session, { kind: 'digest', path: 'published-once.bin' });
      assert.equal(native.bytes, bytes.byteLength); assert.equal(native.sha256, sha(bytes));
      run.evidence.observations.push({ kind: 'native-publication-witness-before-acknowledgement-loss', native });
      await run.save();
    });
    const tracePath = join(run.directory, 'trace.jsonl');
    const proxy = await createTraceProxy({ socketPath: join(run.directory, 'e.sock'), upstreamEndpoint: context.config.endpoint, tracePath,
      observeUpgrade({ method, target, status, record }) {
        const helper = run.owners[0]?.owner.recoveryRecord.resources.find(({ role }) => role === 'filesystem');
        if (method !== 'POST' || helper?.identity.kind !== 'identified'
          || !target.startsWith(`/v1.52/containers/${helper.identity.id}/attach?`)) return;
        assert.equal(status, 101); assert.equal(attached, false); attached = true;
        return { input: (chunk) => gate.observeInput(chunk), async response(chunk, forward) {
          const result = await gate.observe(chunk, forward);
          if (result === 'close') record.fault = 'withheld-native-filesystem-commit-ack';
          return result;
        } };
      } });
    run.proxies.push(proxy); proxy.setRow('live-files');
    opened = await guest(run, context, { endpoint: proxy.endpoint });
    assert.equal(attached, true); gate.armed = true;
    run.evidence.fault = { kind: 'withhold-published-native-commit-frame-then-close-owned-control',
      path: 'published-once.bin', bytes: bytes.byteLength, sha256: sha(bytes) }; await run.save();
    const result = await opened.files.writeFile('published-once.bin', [bytes], { mode: 'create' });
    run.evidence.observations.push({ kind: 'public-write-settlement-after-native-commit-cut', result,
      nativePublicationReceipt: gate.captured?.receipt, commandCounts: { ...gate.commandCounts } });
    await run.save();
    assert(gate.captured); assert.equal(gate.captured.receipt.count, String(bytes.byteLength));
    assert.deepEqual(result, { kind: 'cancelled', reason: 'stopped', effect: 'unknown', bytes: null });
    assert.throws(() => opened.files.writeFile('published-once.bin', [Uint8Array.of(0)], { mode: 'replace' }), SandboxStateError);
    await opened.owner.stop();
    assert.equal(gate.commandCounts[5], 1); assert.equal(gate.commandCounts[6], 1); assert.equal(gate.commandCounts[7], 1);
    const paths = []; const actual = [];
    await opened.sandbox.exportTree({ kind: 'files', paths: ['published-once.bin'] }, async (entry) => {
      paths.push(entry.path); assert.equal(entry.kind, 'file'); for await (const chunk of entry.bytes) actual.push(Buffer.from(chunk));
    });
    assert.deepEqual(paths, ['published-once.bin']); assert.deepEqual(Buffer.concat(actual), bytes);
    run.evidence.observations.push({ kind: 'unknown-public-settlement-is-fenced-without-native-replay', result,
      commandCounts: gate.commandCounts, paths, exportedSha256: sha(Buffer.concat(actual)),
      counterMeaning: 'The native publication witness establishes its byte count separately; the interrupted public observation reports bytes:null while actual driver work settles.' });
    run.afterCleanup.push(async () => {
      const entries = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(entries.filter(({ fault }) => fault === 'withheld-native-filesystem-commit-ack').length, 1);
    });
  }]];
}
