// ------------------------------------------------------------------------------------------------
//                configuration.test.mjs - Explicit borrowed reuse and source-correspondence admission
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from './configuration.mjs';

const input = ['--engine', 'unix:///var/run/docker.sock', '--consumer', '/var/tmp/consumer', '--output', '/var/tmp/new-selected',
  '--prepare-source-image', `sha256:${'a'.repeat(64)}`, '--fixture', '/var/tmp/retained-source', '--fixture-device', '66306',
  '--fixture-inode', '5153979', '--fixture-manifest-sha256', 'e'.repeat(64), '--source-proof', '/var/tmp/proof.md', '--source-manifest', '/var/tmp/source.json'];

test('selected lane requires explicit engine, borrowed-root identity, content manifest and source evidence', () => {
  const parsed = parseArguments(input);
  assert.equal(parsed.fixture, '/var/tmp/retained-source'); assert.equal(parsed.fixtureDevice, '66306'); assert.equal(parsed.fixtureInode, '5153979');
  assert.equal(parsed.fixtureManifestSha256, 'e'.repeat(64));
  for (const invalid of [input.slice(2), input.slice(0, -2), input.map((value) => value === '66306' ? '0' : value),
    input.map((value) => value === 'unix:///var/run/docker.sock' ? 'tcp://localhost:2375' : value),
    input.map((value) => value === '/var/tmp/retained-source' ? '/var/tmp/../someone-else' : value), [...input, '--delete-fixture']]) {
    assert.throws(() => parseArguments(invalid));
  }
  for (const invalid of [input.map((value) => value === '/var/tmp/new-selected' ? '/var/tmp/retained-source/new-output' : value),
    input.map((value) => value === '/var/tmp/retained-source' ? '/var/tmp/new-selected/fixture' : value)]) assert.throws(() => parseArguments(invalid), /separate from the borrowed/u);
});
