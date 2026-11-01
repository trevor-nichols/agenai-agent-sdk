import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Evidence } from '../coordinator/evidence.mjs';
import { originalFile } from '../coordinator-recovery/common.mjs';
import { retainOriginalHandoff } from './handoff.mjs';
import { joinOriginalChild } from './child.mjs';
import { originalCut } from './test-support/handoff.mjs';


test('joined original cut survives lost admission and cleanup-input publication before exact recovery', async (context) => {
  for (const point of ['before-admission', 'before-publication', 'after-publication', 'partial-publication']) await context.test(point, async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-negative-cut-'));
    try {
      const original = await originalCut(directory), report = { evidenceFailures: [] };
      const evidence = new Evidence(join(directory, 'outer')); await evidence.initialize({ point });
      let publicationFailure = point !== 'before-admission';
      const writer = { directory: evidence.directory, async file(name, value) {
        if (publicationFailure) {
          publicationFailure = false;
          if (point === 'after-publication') await evidence.file(name, value);
          if (point === 'partial-publication') await evidence.file(name, Buffer.from('{"consumer":'));
          throw new Error('original metadata acknowledgement lost');
        }
        return evidence.file(name, value);
      } };
      const handoff = retainOriginalHandoff({ ...original, consumer: '/fresh-installed-copy', output: join(directory, 'recovery'), evidence: writer, report });
      if (point === 'before-admission') {
        const output = join(directory, 'joined-command'); await mkdir(output);
        await assert.rejects(joinOriginalChild({ command: process.execPath, args: ['-e', 'process.stdout.write("original-cut-joined")'],
          cwd: directory, env: { PATH: '/usr/bin:/bin' }, output,
          async onSpawn() { throw new Error('joined supervisor metadata unavailable'); } }), /joined supervisor metadata unavailable/u);
        assert.equal(await readFile(join(output, 'controller-stdout.log'), 'utf8'), 'original-cut-joined');
      } else {
        assert.equal((await handoff.admit()).kind, 'cut');
        await assert.rejects(handoff.cleanupInput(), /metadata acknowledgement lost/u);
      }
      const selected = await handoff.cleanupInput(), parsed = await originalFile(selected.path, 1024 ** 2);
      assert.deepEqual(parsed.identity, selected); assert.equal(parsed.value.originalInput, original.originalInput.path);
      assert.equal(parsed.value.originalReport, original.retained.path);
      assert.equal((await handoff.admit()).predecessor.value.barrier.generation, 'ed902f37-52eb-4af9-ae99-7b803ec740de');
      assert.deepEqual(await readFile(original.canonicalPath), original.canonical);
      assert.equal((await originalFile(original.retained.path, 4 * 1024 ** 2)).value.coordinator.final, undefined);
      assert.deepEqual(await handoff.cleanupInput(), selected); await evidence.close();
      if (point === 'partial-publication') {
        assert.notEqual(selected.path, join(evidence.directory, 'cleanup-only-input.json'));
        assert.equal(await readFile(join(evidence.directory, 'cleanup-only-input.json'), 'utf8'), '{"consumer":');
        assert.equal(report.evidenceFailures.length, 1);
      }
    } finally { await rm(directory, { recursive: true }); }
  });
});
