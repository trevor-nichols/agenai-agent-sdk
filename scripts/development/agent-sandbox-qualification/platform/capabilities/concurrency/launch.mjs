import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyQualificationSources } from '../../../scalability/identity.mjs';
import { boundedFile } from '../../../native/configuration.mjs';
import { compiledConcurrencyClosure } from './installed.mjs';
import { concurrencySourceClosure } from './closure.mjs';
import { captureFormat, phaseCaptureFormat } from './evidence.mjs';
import { runResidentCommand } from './ownership.mjs';

export async function launchConcurrencyRow({ options, selected, identity, env }) {
  assert(Buffer.byteLength(join(options.output, 'concurrency/e.sock')) <= 100,
    'Use a shorter concurrency output path for the original AF_UNIX Engine proxy.');
  const source = new URL('../../../', import.meta.url);
  const files = await concurrencySourceClosure(fileURLToPath(source));
  const controller = await copyQualificationSources(options.consumer, { name: 'sandbox-platform-concurrency', source, files });
  const entrypoint = { path: join(options.consumer, 'platform-dist/examples/sandbox/concurrency/index.js'),
    modules: await compiledConcurrencyClosure(options.consumer) };
  const fixtureOwner = randomUUID();
  const config = { format: 'agenai.sandbox-platform-concurrency-controller.v1', consumer: options.consumer,
    output: join(options.output, 'concurrency'), endpoint: selected.manifest.engine, platform: selected.manifest,
    platformInput: selected.input, capabilities: selected.capabilities.manifest, capabilityInput: selected.capabilities.input,
    preparation: selected.capabilities.preparation, sourceIdentity: controller.sources, scenarioBudget: selected.capabilities.scenarioBudget,
    qualificationDirectory: controller.directory,
    installedIdentity: identity, entrypoint, fixtureOwner, namespacePrefix: `platform-concurrency-${fixtureOwner.slice(0, 8)}-`,
    profile: selected.manifest.profile, imageDigest: selected.manifest.sourceImage, guestNodeVersion: selected.manifest.expected.controller.nodeVersion };
  const path = join(options.output, 'concurrency-controller.json');
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const result = await runResidentCommand({ command: process.execPath, args: [join(controller.directory, 'platform/capabilities/concurrency/controller.mjs'), path],
    cwd: options.consumer, env, directory: join(options.output, 'controller-command'),
    timeoutMs: selected.capabilities.scenarioBudget.captureLifetimeMs });
  const reportPath = join(config.output, 'report.json');
  let report = null;
  try {
    const bytes = await boundedFile(reportPath, selected.capabilities.scenarioBudget.maximumReportBytes); report = JSON.parse(bytes.toString('utf8'));
    if (report.status === 'passed') {
      assert.equal(report.phaseCapture?.format, phaseCaptureFormat);
      assert.equal(report.capture?.format, captureFormat);
    }
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const status = result.disposition === 'retained_cleanup' ? 'retained_cleanup'
    : result.status === 0 && report?.status === 'passed' && report.cleanup.complete === true ? 'passed' : 'failed';
  return { status, controller, entrypoint, command: result, reportPath, report };
}
