import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { compiledConcurrencyClosure } from './installed.mjs';

test('compiled public closure follows actual ESM modules while retaining embedded guest imports only as program bytes', async (t) => {
  const consumer = await realpath(await mkdtemp(join(tmpdir(), 'concurrency-esm-')));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const root = join(consumer, 'platform-dist/examples/sandbox/concurrency'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.js'), "export { program } from './program.js';\n");
  await writeFile(join(root, 'program.js'), "export const program=String.raw`import { connect } from './network.mjs'; import('guest-only.mjs');`;\n");
  const result = await compiledConcurrencyClosure(consumer);
  assert.deepEqual(result.map(({ path }) => basename(path)), ['index.js', 'program.js']);
  await writeFile(join(root, 'index.js'), "export const program=import('./program.js');\n");
  await assert.rejects(compiledConcurrencyClosure(consumer), /static installed module closure/u);
});
