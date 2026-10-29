// ------------------------------------------------------------------------------------------------
//                identity.mjs - Complete installed candidate identity and owned qualification copy
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { boundedFile } from '../native/configuration.mjs';
import { physicalDirectory } from './configuration.mjs';
import { hashFile } from './manifests.mjs';

const names = ['validation', 'agent-protocol', 'agent-runtime', 'agent-orchestration', 'agent-history',
  'acp-transport', 'provider-acp', 'acp-registry', 'sandbox', 'sandbox-docker'];

export function within(root, target) {
  const local = relative(root, target);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

export async function installedIdentity(consumer) {
  await physicalDirectory(consumer);
  const modules = join(consumer, 'node_modules');
  await physicalDirectory(modules);
  const scope = join(modules, '@agen-ai');
  assert.deepEqual((await readdir(scope)).sort(), [...names].sort(), 'Complete coordinated ten-package installed candidate required.');
  const packages = [];
  for (const name of names) {
    const root = await realpath(join(scope, name));
    assert(within(modules, root), 'Installed package must stay within consumer node_modules.');
    const manifest = JSON.parse((await boundedFile(join(root, 'package.json'), 1024 ** 2)).toString('utf8'));
    assert.equal(manifest.name, `@agen-ai/${name}`);
    assert.equal(manifest.version, '0.4.7');
    assert.equal(manifest.type, 'module');
    const digest = createHash('sha256');
    let files = 0;
    let bytes = 0;
    const visit = async (directory, prefix) => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const local = `${prefix}${entry.name}`;
        const path = join(directory, entry.name);
        assert(!entry.isSymbolicLink(), 'Installed package cannot contain symlinks.');
        if (entry.isDirectory()) await visit(path, `${local}/`);
        else {
          assert(entry.isFile(), 'Regular installed package contents required.');
          const actual = await hashFile(path);
          files += 1;
          bytes += actual.byteLength;
          assert(files <= 10_000 && bytes <= 256 * 1024 ** 2, 'Installed SDK identity envelope exceeded.');
          digest.update(`${local}\0${actual.byteLength}\0${actual.sha256}\n`);
        }
      }
    };
    await visit(root, '');
    packages.push({ name: manifest.name, version: manifest.version, files, bytes, sha256: digest.digest('hex') });
  }
  return packages;
}

export async function admitOutput(output, consumer) {
  await physicalDirectory(dirname(output));
  const repository = await realpath(new URL('../../../../', import.meta.url));
  assert(!within(repository, output) && !within(output, repository) && !within(consumer, output) && !within(output, consumer), 'Output must be separate from source and installed consumer.');
  await assert.rejects(lstat(output), { code: 'ENOENT' }, 'Output must be new.');
}

export async function copyController(consumer) {
  return copyQualificationSources(consumer, { name: 'sandbox-scale', source: new URL('./', import.meta.url),
    files: ['controller.mjs', 'configuration.mjs', 'dataset.mjs', 'guest.mjs', 'manifests.mjs', 'resources.mjs'] });
}

export async function copyQualificationSources(consumer, { name, source, files }) {
  assert(/^[a-z][a-z0-9-]{1,63}$/u.test(name));
  const root = join(consumer, 'qualification');
  try { await physicalDirectory(root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(root, { mode: 0o700 }); }
  const destination = join(root, `${name}-${randomUUID()}`);
  await mkdir(destination, { mode: 0o700 });
  const sources = [];
  for (const file of files) {
    assert(/^[a-z][a-zA-Z0-9/-]*\.mjs$/u.test(file) && !file.includes('..'));
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(new URL(file, source), target);
    const actual = await hashFile(target);
    sources.push({ name: file, bytes: actual.byteLength, sha256: actual.sha256 });
  }
  return { directory: destination, sources };
}
