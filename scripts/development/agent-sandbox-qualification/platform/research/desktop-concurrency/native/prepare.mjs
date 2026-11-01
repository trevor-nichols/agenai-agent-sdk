import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installed } from './installed.mjs';

const [inputPath] = process.argv.slice(2);
assert.equal(process.argv.length, 3);
const input = JSON.parse(await readFile(inputPath, 'utf8'));
assert.deepEqual(Object.keys(input).sort(), ['consumer', 'directory', 'baseImageDigest', 'toolchainImageDigest', 'user'].sort());
await mkdir(input.directory, { mode: 0o700 });
const { api, identity } = await installed(input.consumer, '@agen-ai/sandbox-docker', './node');
const egress = await api.prepareDockerSandboxEgressHelpers({ directory: join(input.directory, 'egress'),
  baseImageDigest: input.baseImageDigest, user: input.user });
const vm = await api.prepareDockerDesktopVmRouteObserver({ directory: join(input.directory, 'vm'),
  baseImageDigest: input.baseImageDigest, toolchainImageDigest: input.toolchainImageDigest, user: input.user });
const filesystem = await api.prepareDockerSandboxFilesystemHelper({ directory: join(input.directory, 'filesystem'),
  toolchainImageDigest: input.toolchainImageDigest, user: input.user });
await writeFile(join(input.directory, 'preparation.json'), `${JSON.stringify({ format: 'agenai.desktop-concurrency-research-preparation.v1',
  at: new Date().toISOString(), identity, egress, vm, filesystem,
  effects: 'Offline source preparation only. Builds and image admission are separate explicit commands.' }, null, 2)}\n`,
{ flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ directory: input.directory, sources: {
  egress: egress.sourceDigest, vm: vm.sourceDigest, filesystem: filesystem.sourceDigest } })}\n`);
