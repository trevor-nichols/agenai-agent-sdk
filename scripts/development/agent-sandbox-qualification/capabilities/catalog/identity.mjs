import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { digest } from './configuration.mjs';

const root = new URL('../../', import.meta.url);

export async function sourceClosure(entrypoints) {
  const sources = new Map();
  const visit = async (url) => {
    const path = fileURLToPath(url), name = relative(fileURLToPath(root), path);
    assert(!name.startsWith('..') && name.endsWith('.mjs'));
    if (sources.has(name)) return;
    assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert(bytes.length <= 256 * 1024);
    sources.set(name, { name, bytes: bytes.length, sha256: digest(bytes) });
    assert(sources.size <= 256);
    const text = bytes.toString('utf8');
    const imports = [...text.matchAll(/\b(?:from\s+|import\s*)['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]).filter((specifier) => specifier.startsWith('.'));
    for (const specifier of imports) await visit(new URL(specifier, url));
  };
  for (const url of entrypoints) await visit(url);
  return [...sources.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Capture the executable local import closure, the guest, and the observer's evaluated peer. */
export function harnessIdentity() {
  return sourceClosure([new URL('./run.mjs', import.meta.url), new URL('./guest/run.mjs', import.meta.url),
    new URL('./sdk.mjs', import.meta.url), new URL('../../platform/observer/peer.mjs', import.meta.url)]);
}
