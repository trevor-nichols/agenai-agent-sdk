import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { copyQualificationSources } from '../../../scalability/identity.mjs';
import { concurrencySourceClosure } from './closure.mjs';

const entry = 'platform/capabilities/concurrency/controller.mjs';

async function fixture(t, modules) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'concurrency-source-closure-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'); const consumer = join(directory, 'consumer');
  await mkdir(source); await mkdir(consumer);
  for (const [name, contents] of Object.entries({
    'platform/capabilities/concurrency/worker.mjs': 'export {};\n',
    'platform/capabilities/concurrency/recovery.mjs': 'export {};\n',
    'capabilities/desktop/guest.mjs': 'export {};\n', ...modules,
  })) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), contents);
  }
  return { source, consumer, async copy() {
    return copyQualificationSources(consumer, { name: 'closure-proof', source: pathToFileURL(`${source}/`),
      files: await concurrencySourceClosure(source) });
  } };
}

test('copied controller reads its module-relative peer and transitive URL assets from the frozen source tree', async (t) => {
  const selected = await fixture(t, {
    [entry]: "export { observe } from '../../observer/container.mjs';\n",
    'platform/observer/container.mjs': "import { readFile } from 'node:fs/promises';\nexport async function observe() { const peer = await import(new URL('./peer.mjs', import.meta.url)); return peer.observe(); }\n",
    'platform/observer/peer.mjs': "import { readFile } from 'node:fs/promises';\nexport function observe() { return readFile(new URL('payload.mjs', import.meta.url), 'utf8'); }\n",
    'platform/observer/payload.mjs': "export const original = 'copied peer payload';\n",
  });
  const copied = await selected.copy();
  const controller = await import(pathToFileURL(join(copied.directory, entry)).href);
  assert.equal(await controller.observe(), "export const original = 'copied peer payload';\n");
});

test('copied closure follows real ESM references and leaves embedded guest imports as program bytes', async (t) => {
  const selected = await fixture(t, {
    [entry]: "import './side-effect.mjs';\nexport { value } from './reexport.mjs';\nexport async function lazy() { return (await import('./lazy.mjs')).value; }\nexport const guest = String.raw`import './guest-only.mjs'; import('./guest-dynamic.mjs'); new URL('./guest-asset.mjs', import.meta.url);`;\n",
    'platform/capabilities/concurrency/side-effect.mjs': "import { writeFile } from 'node:fs/promises';\nawait writeFile(new URL('./effect.txt', import.meta.url), 'real side effect');\n",
    'platform/capabilities/concurrency/reexport.mjs': "export const value = 'static reexport';\n",
    'platform/capabilities/concurrency/lazy.mjs': "export const value = 'literal dynamic import';\n",
  });
  const copied = await selected.copy();
  const controller = await import(pathToFileURL(join(copied.directory, entry)).href);
  assert.equal(controller.value, 'static reexport');
  assert.equal(await controller.lazy(), 'literal dynamic import');
  assert.equal(await readFile(join(copied.directory, 'platform/capabilities/concurrency/effect.txt'), 'utf8'), 'real side effect');
  assert.equal(controller.guest, "import './guest-only.mjs'; import('./guest-dynamic.mjs'); new URL('./guest-asset.mjs', import.meta.url);");
});

test('source closure rejects module and URL asset references escaping its qualification root', async (t) => {
  for (const source of ["import '../../../../outside.mjs';\n", "export const asset = new URL('../../../../outside.mjs', import.meta.url);\n"]) {
    const selected = await fixture(t, { [entry]: source });
    await writeFile(join(dirname(selected.source), 'outside.mjs'), 'export {};\n');
    await assert.rejects(concurrencySourceClosure(selected.source), /qualification source closure/u);
  }
  const selected = await fixture(t, { [entry]: "export const asset = new URL('./borrowed.mjs', import.meta.url);\n" });
  const outside = join(dirname(selected.source), 'outside.mjs'); await writeFile(outside, 'export {};\n');
  await symlink(outside, join(selected.source, dirname(entry), 'borrowed.mjs'));
  await assert.rejects(concurrencySourceClosure(selected.source), /qualification source closure requires physical files/u);
});

test('copied real observer loads its peer before the first Engine boundary', async (t) => {
  const selected = await fixture(t, {});
  const source = new URL('../../../', import.meta.url);
  const copied = await copyQualificationSources(selected.consumer, { name: 'real-observer-closure', source,
    files: await concurrencySourceClosure(fileURLToPath(source)) });
  const { ObserverContainer } = await import(pathToFileURL(join(copied.directory, 'platform/observer/container.mjs')).href);
  const owner = new ObserverContainer(ObserverContainer.planned({ endpoint: 'unix:///explicit-unopened-engine.sock',
    imageDigest: `sha256:${'1'.repeat(64)}`, architecture: 'arm64' }), async () => {});
  const boundary = new Error('Stop before any Engine request is dispatched.');
  owner.engine.request = async () => { throw boundary; };
  await assert.rejects(owner.execute({ operation: 'probe' }), (error) => error === boundary,
    'The real copied observer must read its shipped peer before reaching the guarded Engine boundary.');
});
