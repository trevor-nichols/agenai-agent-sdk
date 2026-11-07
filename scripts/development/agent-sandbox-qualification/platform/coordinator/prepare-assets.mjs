import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { absolute, addStageLabels, prepareImages } from '../../capabilities/native-harness/preparation.mjs';
import { atomicJson } from '../../capabilities/production/evidence.mjs';
import { CANDIDATE_VERSION } from '../../scalability/identity.mjs';

export const usage = `Usage:
  node scripts/development/agent-sandbox-qualification/platform/coordinator/prepare-assets.mjs --consumer /absolute/installed/consumer --engine unix:///absolute/docker.sock --source-image sha256:<arm64 node> --toolchain-image sha256:<arm64 gcc> --host-toolchain /absolute/toolchain.json --output /new/absolute/assets

Builds the coordinated rows' egress, filesystem and VM-observer images offline from exact local base images, then
compiles the Darwin host observer and coordinator helper twice each from the installed SDK recipes. Writes assets.json.
`;
const HELPER_USER = Object.freeze({ uid: 65534, gid: 65534 });
const run = promisify(execFile);
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

/** Runs an SDK data-only recipe after verifying the selected compiler, retaining every command's output. */
async function runRecipe(preparation, toolchain) {
  assert.equal(await sha256(toolchain.compiler.path), toolchain.compiler.sha256, 'The selected host compiler changed.');
  const commands = [];
  for (const step of preparation.commands) {
    const { stdout, stderr } = await run(step.executable, [...step.arguments], { cwd: preparation.directory, maxBuffer: 1024 ** 2 });
    commands.push({ ...step, stdout, stderr });
  }
  const path = join(preparation.directory, preparation.executable);
  const digest = await sha256(path);
  assert(commands.some(({ executable, stdout }) => executable === '/usr/bin/shasum' && stdout.startsWith(`${digest} `)));
  return { executable: { path, sha256: digest }, sourceDigest: preparation.sourceDigest, commands };
}

export async function prepare(options) {
  const toolchain = JSON.parse(await readFile(absolute(options['host-toolchain']), 'utf8'));
  const result = await prepareImages(options, {
    schema: 'agenai.desktop-coordinator-asset-preparation.v1', packageVersion: CANDIDATE_VERSION, ownerPrefix: 'ms003-assets',
    tagPrefix: 'agenai-ms003', sourceImage: options['source-image'], toolchainImage: options['toolchain-image'],
    protocol: 'agenai.desktop-coordinator.v1', user: HELPER_USER, architecture: 'arm64',
  }, async ({ output, report, sdk, save, build }) => {
    const image = async (key, role, prepareContext) => {
      const directory = join(output, `${role}-context`);
      const preparation = await prepareContext(directory);
      await addStageLabels(join(directory, 'Dockerfile'), report.owner);
      report[key] = { imageDigest: (await build(role, directory)).Id, sourceDigest: preparation.sourceDigest, preparation };
      await save();
    };
    await image('egress', 'egress', (directory) => sdk.node.prepareDockerSandboxEgressHelpers({ directory,
      baseImageDigest: options['source-image'], user: HELPER_USER }));
    await image('filesystem', 'filesystem', (directory) => sdk.node.prepareDockerSandboxFilesystemHelper({ directory,
      toolchainImageDigest: options['toolchain-image'], user: HELPER_USER }));
    await image('vmObserver', 'vm-observer', (directory) => sdk.node.prepareDockerDesktopVmRouteObserver({ directory,
      toolchainImageDigest: options['toolchain-image'], baseImageDigest: options['source-image'], user: HELPER_USER }));
    report.hostObserver = await runRecipe(await sdk.node.prepareDockerDesktopHostNetworkObserver({
      directory: join(output, 'host-observer'), toolchain }), toolchain);
    report.helper = { protocol: 'agenai.desktop-coordinator.v1', ...await runRecipe(await sdk.node.prepareDockerDesktopCoordinatorHelper({
      directory: join(output, 'coordinator-helper'), toolchain }), toolchain) };
    await save();
  });
  const report = JSON.parse(await readFile(result.report, 'utf8'));
  const assets = { format: 'agenai.desktop-coordinator-assets.v1', report: result.report, owner: result.owner, package: report.package,
    sourceImage: options['source-image'], toolchainImage: options['toolchain-image'], user: HELPER_USER,
    ...Object.fromEntries(['egress', 'filesystem', 'vmObserver'].map((role) => [role,
      { imageDigest: report[role].imageDigest, sourceDigest: report[role].sourceDigest }])),
    hostObserver: { executable: report.hostObserver.executable, sourceDigest: report.hostObserver.sourceDigest },
    helper: { protocol: report.helper.protocol, executable: report.helper.executable, sourceDigest: report.helper.sourceDigest } };
  await atomicJson(join(options.output, 'assets.json'), assets);
  return assets;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
  else {
    const names = ['consumer', 'engine', 'source-image', 'toolchain-image', 'host-toolchain', 'output'];
    const { values } = parseArgs({ strict: true, options: Object.fromEntries(names.map((name) => [name, { type: 'string' }])) });
    assert.deepEqual(Object.keys(values).sort(), [...names].sort());
    process.stdout.write(`${JSON.stringify(await prepare(values))}\n`);
  }
}
