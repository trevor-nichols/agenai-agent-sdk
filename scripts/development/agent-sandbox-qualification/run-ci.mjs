// ------------------------------------------------------------------------------------------------
//                run-ci.mjs - Explicit source and packed sandbox integration with owned image cleanup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { credentialFreeEnvironment, qualifiedDatasetEngine, sourceImage, verifyProfile } from './ci-profile.mjs';
import { runOwnedCommand } from './command.mjs';

const { values } = parseArgs({ options: { mode: { type: 'string' }, engine: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node scripts/development/agent-sandbox-qualification/run-ci.mjs --mode monorepo|standalone --engine unix:///absolute/socket --output /new/absolute/directory');
  console.log('Requires built packages and the qualified local daemon. Explicitly pulls the pinned fixture source, prepares a clean image, runs source/packed integration, and removes only the verified prepared image. Never provisions a daemon.');
} else {
  await run(values);
}

async function run(options) {
  assert(['monorepo', 'standalone'].includes(options.mode), 'Explicit monorepo or standalone mode required.');
  assert(typeof options.engine === 'string' && /^unix:\/\/\/[^\0\r\n?#]+$/u.test(options.engine), 'Explicit local Unix engine required.');
  assert(typeof options.output === 'string' && path.isAbsolute(options.output), 'New absolute output directory required.');
  const output = path.resolve(options.output);
  await mkdir(output, { mode: 0o700 });
  const preparation = path.join(output, 'preparation');
  const dockerConfig = path.join(output, 'docker-config');
  await mkdir(dockerConfig, { mode: 0o700 });
  const env = credentialFreeEnvironment(process.env, dockerConfig);
  const report = { format: 'agenai.sandbox-ci.v1', mode: options.mode, endpoint: options.engine, sourceImage,
    profile: null, preparedImage: null, imageRemoved: false, sourceImageRetained: false,
    commands: [], primaryFailure: null, cleanupFailure: null, evidenceFailures: [] };
  const record = () => writeFile(path.join(output, 'ci-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  let commandCleanupUncertain = false;
  let cleaningUp = false;
  const execute = async (command, args, childEnv = env, timeout = 60_000, label) => {
    let result;
    let commandFailure;
    try {
      result = await runOwnedCommand({ command, args, env: childEnv, timeoutMs: timeout,
        ...(cleaningUp ? {} : { signal: cancellation.signal }) });
    } catch (error) {
      commandFailure = error;
      result = error;
      commandCleanupUncertain ||= error.quiescent !== true;
    }
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (label) {
      const log = `${label}.log`;
      report.commands.push({ command, args, log, status: result.status, quiescent: result.quiescent });
      try { writeFileSync(path.join(output, log), `stdout:\n${stdout}\nstderr:\n${stderr}`, { mode: 0o600 }); }
      catch (error) { report.evidenceFailures.push(error.message); commandFailure ??= error; }
    }
    if (commandFailure) throw commandFailure;
    return stdout.trim();
  };
  const docker = (args, timeout) => execute('docker', ['--host', options.engine, ...args], env, timeout);
  const inspectImage = async (target) => {
    try { return JSON.parse(await docker(['image', 'inspect', target]))[0]; }
    catch (error) {
      if (error.status === 1 && String(error.stderr).trim().split('\n').some((line) => line.endsWith(`No such image: ${target}`))) return null;
      throw error;
    }
  };
  const message = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 8192);
  let failure;
  let preparationEntered = false;
  try {
    await record();
    report.profile = verifyProfile(JSON.parse(await docker(['version', '--format', '{{json .Server}}'])), JSON.parse(await docker(['info', '--format', '{{json .}}'])), undefined, qualifiedDatasetEngine);
    await record();
    assert.equal(report.profile.info.Driver, 'overlayfs', 'The full dataset integration lane requires the qualified overlayfs snapshotter.');
    assert.deepEqual(report.profile.info.DriverStatus?.filter(([name]) => name === 'driver-type'),
      [['driver-type', 'io.containerd.snapshotter.v1']], 'The full dataset integration lane requires the admitted containerd image store.');
    report.sourcePreviouslyPresent = await inspectImage(sourceImage) !== null;
    if (!report.sourcePreviouslyPresent) await docker(['image', 'pull', '--platform', 'linux/amd64', sourceImage], 180_000);
    const source = await inspectImage(sourceImage);
    assert(source && /^sha256:[a-f0-9]{64}$/u.test(source.Id) && source.Os === 'linux' && source.Architecture === 'amd64');
    assert.equal(Object.keys(source.Config?.Volumes ?? {}).length, 0);
    report.sourceImageId = source.Id;
    report.sourceImageRetained = true;
    await record();
    preparationEntered = true;
    await execute(process.execPath, [fileURLToPath(new URL('./prepare-fixture.mjs', import.meta.url)), '--engine', options.engine,
      '--source-image', source.Id, '--output', preparation], env, 180_000, 'preparation');
    const prepared = JSON.parse(await readFile(path.join(preparation, 'preparation.json'), 'utf8'));
    assert.equal(prepared.imageAcquisition, 'identified');
    assert.equal(prepared.containerRemoved, true);
    report.preparedImage = prepared.image;
    const manifest = path.join(output, 'fixture.json');
    await writeFile(manifest, `${JSON.stringify({ format: 'agenai.sandbox-docker-fixture.v1', imageDigest: prepared.image,
      user: { uid: 65534, gid: 65534 }, nodeVersion: '24.18.0', sourceImage,
      datasets: [{ name: 'reference', imageDigest: prepared.image, subpath: prepared.datasetFixture.subpath }],
      datasetFixture: { name: 'reference', ...prepared.datasetFixture } })}\n`, { mode: 0o600 });
    const integrationEnv = { ...env, AGENAI_SANDBOX_TEST_ENGINE: options.engine, AGENAI_SANDBOX_TEST_MANIFEST: manifest,
      AGENAI_SANDBOX_TEST_OUTPUT: path.join(output, 'source-integration'), AGENAI_SANDBOX_TEST_DATASETS: '1' };
    await record();
    await execute('pnpm', ['--filter', '@agen-ai/sandbox-docker', 'test:integration'], integrationEnv, 900_000, 'source-integration');
    const packed = path.join(output, 'packed');
    await execute('pnpm', [options.mode === 'monorepo' ? 'test:agent-sdk-external-consumer' : 'test:external-consumer', '--output', packed], env, 900_000, 'packed-consumer');
    await execute(process.execPath, ['scripts/architecture/check-agent-sdk-sandbox-consumer.mjs', '--consumer', path.join(packed, 'consumer')],
      { ...integrationEnv, AGENAI_SANDBOX_TEST_OUTPUT: path.join(output, 'packed-integration') }, 300_000, 'packed-integration');
    report.testsPassed = true;
  } catch (error) {
    failure = error;
    report.primaryFailure = message(error);
  } finally {
    cleaningUp = true;
    if (preparationEntered) {
      try {
        assert.equal(commandCleanupUncertain, false, 'Command process-group quiescence remains uncertain; the prepared image is retained.');
        const prepared = JSON.parse(await readFile(path.join(preparation, 'preparation.json'), 'utf8'));
        if (prepared.imageAcquisition !== 'planned') {
          const currentProfile = verifyProfile(JSON.parse(await docker(['version', '--format', '{{json .Server}}'])), JSON.parse(await docker(['info', '--format', '{{json .}}'])), undefined, qualifiedDatasetEngine);
          assert.equal(currentProfile.info.ID, report.profile.info.ID, 'Cleanup requires the original daemon identity.');
          assert.equal(prepared.endpoint, options.engine);
          assert.equal(prepared.sourceImage, report.sourceImageId);
          assert.match(prepared.operationId, /^[a-f0-9-]{36}$/u);
          assert.equal(prepared.imageTag, `agenai-sandbox-fixture:${prepared.operationId}`);
          const image = await inspectImage(prepared.imageTag);
          assert(image, 'Prepared image is absent; uncertain preparation cannot be declared cleaned.');
          assert.match(image.Id, /^sha256:[a-f0-9]{64}$/u);
          assert.equal(image.Id, prepared.image);
          assert.equal(image.Os, 'linux');
          assert.equal(image.Architecture, 'amd64');
          assert.equal(image.Config?.Labels?.['org.agenai.sandbox.preparation'], prepared.operationId);
          assert.equal(image.Config?.Labels?.['org.agenai.sandbox.source'], report.sourceImageId);
          assert.equal(Object.keys(image.Config?.Volumes ?? {}).length, 0);
          report.preparedImage = image.Id;
          try { await record(); }
          catch (error) { report.evidenceFailures.push(message(error)); failure ??= error; }
          await docker(['image', 'rm', image.Id]);
          assert.equal(await inspectImage(image.Id), null, 'Prepared image remains after exact-ID removal.');
          report.imageRemoved = true;
        }
        assert(prepared.containerAcquisition === 'planned' || prepared.containerRemoved === true, 'Preparation container cleanup must be proven.');
      } catch (error) {
        report.cleanupFailure = message(error);
        failure ??= error;
      }
    }
    try { await record(); }
    catch (error) { report.evidenceFailures.push(message(error)); failure ??= error; }
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ report: path.join(output, 'ci-report.json'), imageRemoved: report.imageRemoved, testsPassed: report.testsPassed }));
}
