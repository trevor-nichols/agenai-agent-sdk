// ------------------------------------------------------------------------------------------------
//                configuration.mjs - Explicit retained-fixture and pinned-source qualification inputs
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { absolutePath } from '../scalability/configuration.mjs';
import { within } from '../scalability/identity.mjs';

export const usage = `Usage:
  node scripts/development/agent-sandbox-qualification/selective/run.mjs --engine unix:///absolute/socket --consumer /absolute/current/consumer --output /new/absolute/run --prepare-source-image sha256:<exact-local-ID> --fixture /absolute/retained/source --fixture-device <decimal> --fixture-inode <decimal> --fixture-manifest-sha256 <64hex> --source-proof /absolute/ms004-selected-traversal-proof.md --source-manifest /absolute/ms004-selected-traversal-source.json

This credential-free lane compares the identical 4 MiB selected artifact in small
and retained >=12 GiB/25,000-file private workspaces on the exact source-qualified
Ubuntu Engine build. It records streaming HTTP paths/body counts and links the
pinned traversal proof; it does not observe filesystem syscalls or benchmark time.
The retained host fixture is borrowed and is NEVER removed by this lane.
`;

export function parseArguments(args) {
  const { values } = parseArgs({ args, options: Object.fromEntries(['engine', 'consumer', 'output', 'prepare-source-image', 'fixture',
    'fixture-device', 'fixture-inode', 'fixture-manifest-sha256', 'source-proof', 'source-manifest'].map((name) => [name, { type: 'string' }])) });
  assert(typeof values.engine === 'string' && /^unix:\/\/\/[^\0\r\n?#]+$/u.test(values.engine), 'Explicit Unix Engine required.');
  absolutePath(values.engine.slice(7));
  assert.match(values['prepare-source-image'], /^sha256:[a-f0-9]{64}$/u);
  assert.match(values['fixture-manifest-sha256'], /^[a-f0-9]{64}$/u);
  for (const name of ['fixture-device', 'fixture-inode']) assert(typeof values[name] === 'string' && /^[1-9][0-9]*$/u.test(values[name]));
  const fixture = absolutePath(values.fixture);
  const output = absolutePath(values.output);
  assert(!within(fixture, output) && !within(output, fixture), 'Output must be separate from the borrowed source fixture.');
  return { endpoint: values.engine, consumer: absolutePath(values.consumer), output,
    image: values['prepare-source-image'], fixture, fixtureDevice: values['fixture-device'],
    fixtureInode: values['fixture-inode'], fixtureManifestSha256: values['fixture-manifest-sha256'],
    sourceProof: absolutePath(values['source-proof']), sourceManifest: absolutePath(values['source-manifest']) };
}
