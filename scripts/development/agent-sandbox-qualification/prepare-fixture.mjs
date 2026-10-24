// ------------------------------------------------------------------------------------------------
//                prepare-fixture.mjs - Explicit local fixture image preparation - Docker CLI
// ------------------------------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const defaultSourceImage = 'sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c';
const datasetSubpath = 'agenai-qualification-dataset';
const datasetBytes = Buffer.from('AgenAI immutable dataset fixture v1\nExact bytes shared across private workspaces.\n');
const { values } = parseArgs({ options: { engine: { type: 'string' }, output: { type: 'string' }, 'source-image': { type: 'string' }, architecture: { type: 'string', default: 'amd64' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node scripts/development/agent-sandbox-qualification/prepare-fixture.mjs --engine unix:///absolute/docker.sock --output /new/owned/directory [--source-image sha256:<64 lowercase hex>] [--architecture amd64|arm64]');
  console.log('Defaults to the exact local MS001 PostgreSQL image; other exact local Linux images must match the selected architecture and declare no volumes. Adds one fixed dataset fixture. Never pulls or starts a container. Retains one labelled fixture image and its identity report.');
} else {
  await prepare(values);
}

async function prepare(options) {
  if (typeof options.engine !== 'string' || !/^unix:\/\/\/[^\0\r\n?#]+$/u.test(options.engine)
    || typeof options.output !== 'string' || !path.isAbsolute(options.output)) {
    throw new Error('Explicit local Unix engine and new absolute output directory are required.');
  }
  const sourceImage = options['source-image'] ?? defaultSourceImage;
  const architecture = options.architecture;
  if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Preparation architecture must explicitly be amd64 or arm64.');
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceImage)) throw new Error('Source image must be an exact local sha256 image ID.');
  const endpoint = options.engine;
  const output = path.resolve(options.output);
  await mkdir(output, { mode: 0o700 });
  const operationId = randomUUID();
  const archive = path.join(output, 'filesystem.tar');
  const datasetStaging = path.join(output, 'dataset-staging');
  const name = `agenai-sandbox-prepare-${operationId}`;
  const tag = `agenai-sandbox-fixture:${operationId}`;
  const reportPath = path.join(output, 'preparation.json');
  const report = {
    operationId, sourceImage, architecture, endpoint, plannedContainerName: name, imageTag: tag,
    container: null, image: null, containerAcquisition: 'planned', imageAcquisition: 'planned',
    primaryFailure: null, cleanupFailure: null, evidenceFailures: [],
  };
  const docker = (args, timeout = 30_000) => execFileSync('docker', ['--host', endpoint, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const record = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const message = (error) => error instanceof Error ? error.message : String(error);
  const inspect = (kind, target) => {
    let result;
    try { result = docker([kind, 'inspect', target]); }
    catch (error) {
      const missing = `No such ${kind}: ${target}`;
      if (error.status === 1 && String(error.stderr).trim().split('\n').some((line) => line.endsWith(missing))) return null;
      throw error;
    }
    const objects = JSON.parse(result);
    if (!Array.isArray(objects) || objects.length !== 1 || !objects[0] || typeof objects[0] !== 'object') throw new Error(`Unexpected ${kind} inspection result.`);
    return objects[0];
  };
  const ownedContainer = (object) => {
    if (!object || !/^[a-f0-9]{64}$/u.test(object.Id) || object.Name !== `/${name}` || object.Image !== sourceImage
      || object.Config?.Labels?.['org.agenai.sandbox.preparation'] !== operationId
      || report.container !== null && object.Id !== report.container) throw new Error('Preparation container identity conflicts with the recorded operation; it was left untouched.');
    return object;
  };
  const ownedImage = (object) => {
    if (!object || !/^sha256:[a-f0-9]{64}$/u.test(object.Id) || object.Os !== 'linux' || object.Architecture !== architecture
      || Object.keys(object.Config?.Volumes ?? {}).length !== 0
      || object.Config?.Labels?.['org.agenai.sandbox.preparation'] !== operationId
      || object.Config?.Labels?.['org.agenai.sandbox.source'] !== sourceImage
      || report.image !== null && object.Id !== report.image) throw new Error('Prepared fixture image conflicts with its recorded identity or metadata; it was left untouched.');
    return object;
  };
  let failure;
  const preserveEvidence = async () => {
    try { await record(); }
    catch (error) { report.evidenceFailures.push(message(error)); failure ??= error; }
  };
  let createEntered = false;
  let importEntered = false;
  try {
    await record();
    const [source] = JSON.parse(docker(['image', 'inspect', sourceImage]));
    const expectedVolumes = sourceImage === defaultSourceImage ? ['/var/lib/postgresql/data'] : [];
    if (source.Id !== sourceImage || source.Architecture !== architecture || source.Os !== 'linux'
      || JSON.stringify(Object.keys(source.Config.Volumes ?? {})) !== JSON.stringify(expectedVolumes)) {
      throw new Error('Local fixture source does not match the qualified image identity and declared volume.');
    }
    report.containerAcquisition = 'uncertain';
    await record();
    createEntered = true;
    const created = docker(['container', 'create', '--platform', `linux/${architecture}`, '--name', name, '--label', `org.agenai.sandbox.preparation=${operationId}`,
      '--network', 'none', '--read-only', ...(sourceImage === defaultSourceImage ? ['--tmpfs', '/var/lib/postgresql/data:rw,size=1048576'] : []),
      '--entrypoint', '/bin/sh', sourceImage, '-c', 'exit 0']);
    if (!/^[a-f0-9]{64}$/u.test(created)) throw new Error('Docker create returned an invalid container identity.');
    report.container = created;
    ownedContainer(inspect('container', created));
    report.containerAcquisition = 'identified';
    await record();
    docker(['container', 'export', '--output', archive, report.container], 60_000);
    const sourceArchiveBytes = (await stat(archive)).size;
    if (sourceArchiveBytes <= 0 || sourceArchiveBytes > 1024 * 1024 * 1024) throw new Error('Fixture filesystem archive exceeds its preparation bound.');
    const members = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (members.split('\n').some((member) => member.replace(/^\.\//u, '').split('/')[0] === datasetSubpath)) {
      throw new Error('Fixture source already contains the reserved qualification dataset path.');
    }
    await mkdir(datasetStaging, { mode: 0o700 });
    const datasetDirectory = path.join(datasetStaging, datasetSubpath);
    await mkdir(datasetDirectory, { mode: 0o700 });
    await writeFile(path.join(datasetDirectory, 'manifest.txt'), datasetBytes, { flag: 'wx', mode: 0o600 });
    await symlink('/etc', path.join(datasetDirectory, 'escape'));
    // Writable source modes make the later EROFS proof depend on the actual read-only mount.
    await chmod(datasetDirectory, 0o777);
    await chmod(path.join(datasetDirectory, 'manifest.txt'), 0o666);
    execFileSync('tar', ['-rf', archive, '-C', datasetStaging, datasetSubpath], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const bytes = (await stat(archive)).size;
    if (bytes > 1024 * 1024 * 1024) throw new Error('Fixture archive with dataset exceeds its preparation bound.');
    report.datasetFixture = { subpath: datasetSubpath, path: 'manifest.txt', byteLength: datasetBytes.length,
      sha256: createHash('sha256').update(datasetBytes).digest('hex') };
    report.imageAcquisition = 'uncertain';
    await record();
    importEntered = true;
    const imported = docker(['image', 'import', '--platform', `linux/${architecture}`,
      '--change', `LABEL org.agenai.sandbox.preparation=${operationId}`,
      '--change', `LABEL org.agenai.sandbox.source=${sourceImage}`,
      '--change', 'ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--change', 'USER 65534:65534', '--change', 'WORKDIR /workspace/work', archive, tag], 60_000);
    if (!/^sha256:[a-f0-9]{64}$/u.test(imported)) throw new Error('Docker import returned an invalid image identity.');
    report.image = imported;
    await record();
    ownedImage(inspect('image', tag));
    report.imageAcquisition = 'identified';
    report.archiveBytes = bytes;
    report.imageRetainedFor = 'MS003-MS006 credential-free integration qualification';
  } catch (error) {
    failure = error;
    report.primaryFailure = message(error);
  } finally {
    if (createEntered) {
      try {
        const object = inspect('container', report.container ?? name);
        if (object === null && report.container === null) throw new Error('Container create remains uncertain: current name absence cannot exclude a late create.');
        if (object !== null) {
          report.container = ownedContainer(object).Id;
          report.containerAcquisition = 'identified';
          await preserveEvidence();
          docker(['container', 'rm', '--force', report.container]);
          if (inspect('container', report.container) !== null) throw new Error('Preparation container remains present after exact-ID removal.');
        }
        report.containerRemoved = true;
      } catch (error) { report.cleanupFailure = message(error); failure ??= error; }
    }
    if (importEntered) {
      try {
        const object = inspect('image', tag);
        if (object === null) throw new Error('Image import remains uncertain: no matching planned tag is currently visible.');
        report.image = ownedImage(object).Id;
        report.imageAcquisition = 'identified';
        if (failure) report.imageRetainedFor = 'Failed preparation recovery; exact observed image retained without automatic removal.';
      } catch (error) { report.imageRecoveryFailure = message(error); failure ??= error; }
    }
    try { await rm(archive, { force: true }); }
    catch (error) { report.archiveCleanupFailure = message(error); failure ??= error; }
    try { await rm(datasetStaging, { recursive: true, force: true }); }
    catch (error) { report.datasetCleanupFailure = message(error); failure ??= error; }
    await preserveEvidence();
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ image: report.image, imageTag: report.imageTag, report: reportPath, containerRemoved: report.containerRemoved }));
}
