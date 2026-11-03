import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installedSdk } from './installed.mjs';

test('installed public SDK entrypoints use import-only exports from the chosen consumer', async () => {
  const consumer = await realpath(await mkdtemp(join(tmpdir(), 'catalog-consumer-')));
  try {
    await writeFile(join(consumer, 'package.json'), '{"type":"module"}');
    for (const name of ['sandbox', 'sandbox-docker']) {
      const directory = join(consumer, 'node_modules/@agen-ai', name); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@agen-ai/${name}`, type: 'module',
        exports: { '.': { import: './index.mjs' }, './node': { import: './node.mjs' } } }));
      await writeFile(join(directory, 'index.mjs'), `export const entrypoint = '${name}:root';`);
      await writeFile(join(directory, 'node.mjs'), `export const entrypoint = '${name}:node';`);
    }
    const sdk = await installedSdk(consumer);
    assert.equal(sdk.sandbox.entrypoint, 'sandbox:root'); assert.equal(sdk.sandboxNode.entrypoint, 'sandbox:node');
    assert.equal(sdk.docker.entrypoint, 'sandbox-docker:root'); assert.equal(sdk.dockerNode.entrypoint, 'sandbox-docker:node');
    assert.equal(sdk.loader.sources.length, 1); assert.equal(sdk.loader.sources[0].name, 'sdk.mjs');
  } finally { await rm(consumer, { recursive: true, force: true }); }
});
