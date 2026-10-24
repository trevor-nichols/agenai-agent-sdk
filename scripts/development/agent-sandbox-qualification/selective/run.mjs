// ------------------------------------------------------------------------------------------------
//                run.mjs - Explicit source-qualified installed selective export qualification
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialFreeEnvironment, sourceImage, verifyProfile } from '../ci-profile.mjs';
import { boundedFile } from '../native/configuration.mjs';
import { failure } from '../scalability/configuration.mjs';
import { admitOutput, copyQualificationSources, installedIdentity } from '../scalability/identity.mjs';
import { cleanupFixtureImage, prepareFixtureImage } from '../scalability/image.mjs';
import { hashFile } from '../scalability/manifests.mjs';
import { runObservedController } from '../scalability/memory.mjs';
import { diskPreflight, engineControl } from '../scalability/resources.mjs';
import { parseArguments, usage } from './configuration.mjs';
import { verifyRetainedFixture } from './fixture.mjs';

const copiedFiles = ['selective/controller.mjs', 'selective/fixture.mjs', 'selective/guest.mjs', 'selective/cases.mjs',
  'selective/safety.mjs', 'selective/owner.mjs', 'selective/proxy/index.mjs', 'selective/proxy/http.mjs',
  'selective/proxy/upgrade.mjs', 'selective/proxy/trace.mjs', 'scalability/configuration.mjs', 'scalability/resources.mjs',
  'scalability/manifests.mjs', 'scalability/guest.mjs'];

async function run(options) {
  await admitOutput(options.output, options.consumer);
  const identity = await installedIdentity(options.consumer);
  const retained = await verifyRetainedFixture(options);
  const socket = await lstat(options.endpoint.slice(7));
  assert(socket.isSocket() && !socket.isSymbolicLink());
  const sourceManifest = JSON.parse((await boundedFile(options.sourceManifest, 64 * 1024)).toString('utf8'));
  assert.equal(sourceManifest.format, 'agenai.sandbox-selected-traversal-source.v1');
  assert.equal(sourceManifest.commit, 'fbf3ed25f893e6ce21336f1101590e40a13934f4');
  assert.equal(sourceManifest.installedBinary.path, '/usr/bin/dockerd');
  const binary = await hashFile(sourceManifest.installedBinary.path);
  assert.equal(binary.sha256, sourceManifest.installedBinary.sha256, 'Installed dockerd differs from the source-qualified binary identity.');
  await boundedFile(options.sourceProof, 128 * 1024);
  const sourceEvidence = { proof: { input: options.sourceProof, ...(await hashFile(options.sourceProof)) },
    source: { input: options.sourceManifest, ...(await hashFile(options.sourceManifest)) }, commit: sourceManifest.commit,
    installedBinary: sourceManifest.installedBinary, limits: sourceManifest.limits };
  await mkdir(options.output, { mode: 0o700 });
  await copyFile(options.sourceProof, join(options.output, 'selected-traversal-proof.md'));
  await copyFile(options.sourceManifest, join(options.output, 'selected-traversal-source.json'));
  const dockerConfig = join(options.output, 'docker-config'); await mkdir(dockerConfig, { mode: 0o700 });
  const env = credentialFreeEnvironment(process.env, dockerConfig);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Selective qualification launcher interrupted.'));
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const preparation = join(options.output, 'preparation');
  const report = { format: 'agenai.sandbox-selective-launcher.v1', status: 'running', options, startedAt: new Date().toISOString(),
    installedIdentity: identity, retainedFixture: retained, sourceEvidence, profile: null, imageDigest: null, imageRemoved: false,
    selectedImagePreserved: false, primaryFailure: null, cleanupFailures: [], memory: null };
  const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;
  const checkpoint = () => writeFile(join(options.output, 'launcher-report.json'), encode(report), { mode: 0o600 });
  let preparationEntered = false;
  let commandQuiescent = true;
  try {
    const version = (await engineControl(options.endpoint, 'GET', '/version')).value;
    const info = (await engineControl(options.endpoint, 'GET', '/info')).value;
    report.profile = verifyProfile(version, info);
    assert.equal(version.GitCommit, '29.1.3-0ubuntu4.1'); assert.equal(version.GoVersion, 'go1.24.13');
    assert.equal(version.GitCommit, sourceManifest.daemonVersion.GitCommit); assert.equal(version.GoVersion, sourceManifest.daemonVersion.GoVersion);
    report.qualifiedBuild = { GitCommit: version.GitCommit, GoVersion: version.GoVersion, installedBinarySha256: binary.sha256,
      scope: sourceManifest.installedBinary.scope };
    report.diskPreflight = await diskPreflight(options.output, info.DockerRootDir);
    const source = (await engineControl(options.endpoint, 'GET', `/images/${encodeURIComponent(options.image)}/json`)).value;
    assert.equal(source.Id, options.image);
    assert(source.RepoDigests?.some((value) => value.endsWith(`@${sourceImage.split('@')[1]}`)));
    preparationEntered = true; await checkpoint();
    try { report.imageDigest = await prepareFixtureImage({ endpoint: options.endpoint, sourceImage: options.image, preparation, env, signal: cancellation.signal }); }
    catch (error) { commandQuiescent = error.quiescent === true; throw error; }
    report.controller = await copyQualificationSources(options.consumer, { name: 'sandbox-selective', source: new URL('../', import.meta.url), files: copiedFiles });
    const configurationPath = join(options.output, 'controller.json');
    await writeFile(configurationPath, encode({ ...options, imageDigest: report.imageDigest, sourceEvidence }), { flag: 'wx', mode: 0o600 });
    await checkpoint();
    report.memory = await runObservedController({ controllerPath: join(report.controller.directory, 'selective', 'controller.mjs'), configurationPath,
      consumer: options.consumer, output: options.output, budgets: { rssBytes: 1024 ** 3, externalBytes: 256 * 1024 ** 2 }, env, signal: cancellation.signal });
    commandQuiescent = report.memory.commandQuiescent;
    assert.equal(report.memory.failure, null, 'Selective controller failed or exceeded the selected qualification memory budget.');
    const controlled = JSON.parse((await boundedFile(join(options.output, 'report.json'), 256 * 1024)).toString('utf8'));
    assert.equal(controlled.status, 'passed'); assert.equal(controlled.comparison.passed, true);
    assert(controlled.rows.every((row) => row.status === 'passed'));
    assert(controlled.workspaces.every((workspace) => workspace.status === 'passed' && workspace.cleanupFailures.length === 0));
    assert.deepEqual(await installedIdentity(options.consumer), identity);
    assert.deepEqual(await verifyRetainedFixture(options), retained, 'Borrowed fixture changed.');
  } catch (error) { report.primaryFailure = failure(error); }
  finally {
    if (preparationEntered) {
      try { report.imageRemoved = await cleanupFixtureImage({ endpoint: options.endpoint, sourceImage: options.image, preparation,
        daemonId: report.profile.info.ID, commandsQuiescent: commandQuiescent }); }
      catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    try {
      assert.equal((await engineControl(options.endpoint, 'GET', `/images/${encodeURIComponent(options.image)}/json`)).value.Id, options.image);
      report.selectedImagePreserved = true;
    } catch (error) { report.cleanupFailures.push(failure(error)); }
    report.status = report.primaryFailure || report.cleanupFailures.length ? 'failed' : 'passed';
    report.finishedAt = new Date().toISOString(); await checkpoint();
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: join(options.output, 'launcher-report.json') })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
  else await run(parseArguments(process.argv.slice(2)));
} catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`); process.exitCode = 1; }
