// ------------------------------------------------------------------------------------------------
//                run.mjs - Explicit installed large-workspace qualification and exact image owner
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialFreeEnvironment, sourceImage, verifyProfile } from '../ci-profile.mjs';
import { boundedFile } from '../native/configuration.mjs';
import { failure, parseArguments, physicalDirectory, usage } from './configuration.mjs';
import { admitOutput, copyController, installedIdentity } from './identity.mjs';
import { runObservedController } from './memory.mjs';
import { cleanupFixtureImage, prepareFixtureImage } from './image.mjs';
import { diskPreflight, engineControl } from './resources.mjs';

async function run(options) {
  await admitOutput(options.output, options.consumer);
  await physicalDirectory(options.consumer);
  const identity = await installedIdentity(options.consumer);
  const socket = await lstat(options.endpoint.slice(7));
  assert(socket.isSocket() && !socket.isSymbolicLink(), 'Explicit physical Unix socket required.');
  await mkdir(options.output, { mode: 0o700 });
  const dockerConfig = join(options.output, 'docker-config');
  await mkdir(dockerConfig, { mode: 0o700 });
  const env = credentialFreeEnvironment(process.env, dockerConfig);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Large-workspace launcher interrupted.'));
  process.on('SIGTERM', interrupt);
  process.on('SIGINT', interrupt);
  const preparation = join(options.output, 'preparation');
  const report = { format: 'agenai.sandbox-large-workspace-launcher.v1', status: 'running', options,
    requiredPreparationSourceRepoDigest: options.prepare ? sourceImage : null, startedAt: new Date().toISOString(), profile: null, diskPreflight: null,
    installedIdentity: identity, imageDigest: null, imageBorrowed: !options.prepare, imageRemoved: false,
    primaryFailure: null, cleanupFailures: [], evidenceFailures: [], controller: null, memory: null };
  const checkpoint = () => writeFile(join(options.output, 'launcher-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  let preparationEntered = false;
  let commandQuiescent = true;
  try {
    await checkpoint();
    const version = (await engineControl(options.endpoint, 'GET', '/version')).value;
    const info = (await engineControl(options.endpoint, 'GET', '/info')).value;
    report.profile = verifyProfile(version, info);
    report.diskPreflight = await diskPreflight(options.output, info.DockerRootDir);
    const selected = (await engineControl(options.endpoint, 'GET', `/images/${encodeURIComponent(options.image)}/json`)).value;
    assert.equal(selected.Id, options.image);
    assert.equal(selected.Os, 'linux');
    assert.equal(selected.Architecture, 'amd64');
    assert.equal(Object.keys(selected.Config?.Volumes ?? {}).length, 0);
    if (options.prepare) {
      const pinnedDigest = sourceImage.slice(sourceImage.indexOf('@') + 1);
      assert(selected.RepoDigests?.some((value) => typeof value === 'string' && value.endsWith(`@${pinnedDigest}`)),
        'Preparation requires the exact pinned Node 24.18.0 source RepoDigest.');
      report.observedSourceRepoDigests = selected.RepoDigests;
      preparationEntered = true;
      await checkpoint();
      try {
        report.imageDigest = await prepareFixtureImage({ endpoint: options.endpoint, sourceImage: options.image,
          preparation, env, signal: cancellation.signal });
      } catch (error) { commandQuiescent = error.quiescent === true; throw error; }
    } else report.imageDigest = options.image;
    const controller = await copyController(options.consumer);
    report.controller = controller;
    const configurationPath = join(options.output, 'controller.json');
    await writeFile(configurationPath, `${JSON.stringify({ endpoint: options.endpoint, output: options.output, imageDigest: report.imageDigest,
      retainSource: options.retainSource, fixtureSeed: randomUUID() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await checkpoint();
    report.memory = await runObservedController({ controllerPath: join(controller.directory, 'controller.mjs'),
      configurationPath, consumer: options.consumer, output: options.output, budgets: options.budgets, env, signal: cancellation.signal });
    commandQuiescent = report.memory.commandQuiescent;
    assert.equal(report.memory.failure, null, 'Controller failed or exceeded the selected qualification memory budget.');
    const controlled = JSON.parse((await boundedFile(join(options.output, 'report.json'), 256 * 1024)).toString('utf8'));
    assert.equal(controlled.status, 'passed');
    assert.equal(controlled.controller.pid, report.memory.controllerPid);
    assert.equal(controlled.runs.length, 2);
    assert(controlled.runs.every((entry) => entry.status === 'passed' && entry.cleanupFailures.length === 0
      && entry.observations.every((observation) => observation.httpStatus === 404)));
    report.completedControllerEvidence = { report: join(options.output, 'report.json'), source: controlled.source,
      guest: controlled.guest, sink: controlled.sink, retainedFixture: controlled.retainedFixture ?? null };
    assert.deepEqual(await installedIdentity(options.consumer), identity, 'Installed SDK identity changed during qualification.');
  } catch (error) { report.primaryFailure = failure(error); }
  finally {
    if (preparationEntered) {
      try {
        report.imageRemoved = await cleanupFixtureImage({ endpoint: options.endpoint, sourceImage: options.image,
          preparation, daemonId: report.profile.info.ID, commandsQuiescent: commandQuiescent });
      } catch (error) { report.cleanupFailures.push(failure(error)); }
    }
    try {
      const selected = (await engineControl(options.endpoint, 'GET', `/images/${encodeURIComponent(options.image)}/json`)).value;
      assert.equal(selected.Id, options.image);
      report.selectedImagePreserved = true;
    } catch (error) { report.evidenceFailures.push(failure(error)); }
    report.status = report.primaryFailure || report.cleanupFailures.length || report.evidenceFailures.length ? 'failed' : 'passed';
    report.finishedAt = new Date().toISOString();
    await checkpoint();
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: join(options.output, 'launcher-report.json') })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
  else await run(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', failure: failure(error) })}\n`);
  process.exitCode = 1;
}
