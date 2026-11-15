import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSandboxRelativePath } from '@agen-ai/sandbox';
import { createFileRestrictions } from '../src/node/restrictions.js';

test('pathological model globs and caller selectors finish through real broker search before an external watchdog', { timeout: 30_000 }, () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./support/search-child.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
  });
  assert.equal(child.signal, null, `the watchdog killed the search: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  const matching = `${'a'.repeat(40)}b`;
  assert.deepEqual(JSON.parse(child.stdout), { glob: matching, grep: `${matching}:1:needle`, read: ['completed', 'needle'] });
});

test('selectors keep their grammar: ** spans directories, **/ may match none, * and ? stay inside one name, the rest is literal', () => {
  const restrictions = createFileRestrictions({
    denyRead: ['**/.secret/**', 'logs/*.log', 'a?c.txt', 'build**', 'x/**/y.txt', 'v1.(final)+[1].md'], askRead: [], denyEdit: [], askEdit: [],
  });
  const expected: Record<string, 'deny' | 'allow'> = {
    '.secret/key': 'deny', 'deep/er/.secret/key': 'deny', '.secret': 'allow', 'not.secret/key': 'allow',
    'logs/app.log': 'deny', 'logs/.log': 'deny', 'logs/sub/app.log': 'allow', 'logs/app.log.1': 'allow',
    'abc.txt': 'deny', 'aéc.txt': 'deny', 'ac.txt': 'allow', 'a/c.txt': 'allow', 'abbc.txt': 'allow',
    build: 'deny', 'build/out/x': 'deny', buildx: 'deny', 'src/build': 'allow',
    'x/y.txt': 'deny', 'x/m/n/y.txt': 'deny', 'xy.txt': 'allow', 'x/y.txt/z': 'allow',
    'v1.(final)+[1].md': 'deny', 'v1x(final)+[1].md': 'allow', 'v1.final1.md': 'allow',
  };
  const actual = Object.fromEntries(Object.keys(expected).map((path) => [path, restrictions.read(parseSandboxRelativePath(path))]));
  assert.deepEqual(actual, expected);
});

test('a restriction decision that exhausts its matching work is denied rather than allowed', () => {
  const restrictions = createFileRestrictions({ denyRead: [], askRead: [`${'*a'.repeat(200)}c`], denyEdit: [], askEdit: [] });
  const path = parseSandboxRelativePath('a'.repeat(250));
  assert.deepEqual([restrictions.read(path), restrictions.edit(path), restrictions.read(path, { steps: 1_000 })], ['allow', 'allow', 'deny']);
});
