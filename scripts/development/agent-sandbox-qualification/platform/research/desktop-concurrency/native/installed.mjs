import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function installed(consumer, name, subpath = '.') {
  assert.equal(await realpath(consumer), consumer);
  const require = createRequire(join(consumer, 'package.json'));
  const manifestPath = require.resolve(`${name}/package.json`);
  assert(manifestPath.startsWith(`${consumer}/node_modules/`), 'Research must load a separately installed package.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, '0.4.7', 'MS001 reproduction retains the published 0.4.7 contract.');
  const entry = manifest.exports[subpath]?.import;
  assert(typeof entry === 'string' && entry.startsWith('./'));
  const entryPath = join(dirname(manifestPath), entry);
  return { api: await import(pathToFileURL(entryPath).href),
    identity: { name, version: manifest.version, subpath, manifestPath, manifestSha256: sha(await readFile(manifestPath)),
      entryPath, entrySha256: sha(await readFile(entryPath)) } };
}

export function failure(error) {
  if (error instanceof AggregateError) return { name: error.name, message: error.message,
    errors: error.errors.map(failure), ...(error.cause ? { cause: failure(error.cause) } : {}) };
  return { name: error?.name ?? 'ThrownValue', message: error?.message ?? String(error),
    ...(error?.code ? { code: error.code } : {}), ...(error?.cause ? { cause: failure(error.cause) } : {}) };
}
