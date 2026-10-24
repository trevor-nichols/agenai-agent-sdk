// ------------------------------------------------------------------------------------------------
//                grok.mjs - Installed credential-free native version and ACP initialization proof
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAgentProviderRegistry, AgentProviderRegistryError } from '@agen-ai/agent-runtime';
import { parseAgentInstanceId, parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { createNodeAcpProviderDriver, NodeAcpExecutionCleanupError } from '@agen-ai/provider-acp/node';
import { parseSandboxGuestPath, parseSandboxRequest, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { createSandboxAcpIntegration } from '@agen-ai/sandbox/acp';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { GrokBinaryCleanupError, GROK_SHA256, GROK_VERSION, openGrokBinary } from './grok-binary.mjs';

const environment = Object.freeze({ HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GROK_HOME: '/home/sandbox/grok',
  XDG_CONFIG_HOME: '/home/sandbox/config', XDG_DATA_HOME: '/home/sandbox/data', XDG_CACHE_HOME: '/home/sandbox/cache',
  XDG_STATE_HOME: '/home/sandbox/state', XDG_RUNTIME_DIR: '/home/sandbox/runtime',
  GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: 'false', GROK_TRACE_UPLOAD: 'false', GROK_INSTRUMENTATION: 'disabled',
  GROK_FOLDER_TRUST: '0', RUST_LOG: 'error',
  ...Object.fromEntries(['CLAUDE', 'CURSOR'].flatMap((source) => ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']
    .map((kind) => [`GROK_${source}_${kind}_ENABLED`, '0']))),
});

function exactKeys(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected configuration fields.');
}

async function readConfiguration(filename) {
  assert.equal(typeof filename, 'string');
  assert(path.isAbsolute(filename) && path.normalize(filename) === filename, 'Configuration path must be absolute and canonical.');
  const handle = await open(filename, 'r');
  let bytes;
  try {
    const buffer = Buffer.alloc(16 * 1024 + 1);
    const count = await handle.read(buffer, 0, buffer.length, 0);
    assert(count.bytesRead <= 16 * 1024, 'Configuration exceeds its byte bound.');
    bytes = buffer.subarray(0, count.bytesRead);
  } finally { await handle.close(); }
  const config = JSON.parse(bytes.toString('utf8'));
  exactKeys(config, ['endpoint', 'profile', 'imageDigest', 'output', 'harness']);
  exactKeys(config.harness, ['path', 'sha256']);
  assert.equal(config.harness.sha256, GROK_SHA256);
  assert.equal(typeof config.output, 'string');
  assert(path.isAbsolute(config.output) && path.normalize(config.output) === config.output, 'Output must be an explicit canonical new directory.');
  assert.equal(await realpath(path.dirname(config.output)), path.dirname(config.output), 'Output parent must be canonical and caller owned.');
  return config;
}

async function collect(stream, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    assert(total <= maximum, 'Native version output exceeded its explicit bound.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

const versionProgram = `
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const [binary, expected] = process.argv.slice(1);
const hash = createHash('sha256');
for await (const chunk of createReadStream(binary, {highWaterMark:65536})) hash.update(chunk);
const sha256 = hash.digest('hex');
if (sha256 !== expected) throw new Error('Imported guest binary digest mismatch.');
const observed = await promisify(execFile)(binary, ['--version'], {env:process.env,timeout:10000,maxBuffer:8192});
process.stdout.write(JSON.stringify({sha256,version:observed.stdout.trim(),stderrBytes:Buffer.byteLength(observed.stderr)}));
`;

async function main() {
  assert.equal(process.argv.length, 3, 'Usage: node platform/grok.mjs /absolute/controller.json');
  const config = await readConfiguration(process.argv[2]);
  assert(['linux-x64', 'desktop-apple-virtualization-rosetta-amd64'].includes(config.profile),
    'The pinned x86_64 Grok binary requires Linux x64 or the explicit Desktop AVF/Rosetta amd64 profile.');
  const namespace = `platform-grok-${randomUUID()}`;
  const backend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile, imageDigest: config.imageDigest,
    namespace, spillDirectory: config.output, user: { uid: 65534, gid: 65534 } });
  const binary = await openGrokBinary(config.harness.path, config.harness.sha256);
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Grok initialization qualification interrupted.'));
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  let outputOwned = false;
  let report;
  let evidence;
  const checkpoint = async () => {
    const pending = path.join(config.output, 'grok-report.json.next');
    await writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await rename(pending, path.join(config.output, 'grok-report.json'));
  };
  try {
    await mkdir(config.output, { mode: 0o700 });
    outputOwned = true;
    evidence = await import('../../../platform-dist/examples/sandbox/evidence.js');
    report = { format: 'agenai.sandbox-platform-grok.v1', status: 'running', namespace, profile: config.profile,
      controller: { platform: process.platform, architecture: process.arch, node: process.version }, imageDigest: config.imageDigest,
      harness: { sha256: GROK_SHA256, byteLength: binary.byteLength, architecture: binary.architecture, expectedVersion: GROK_VERSION },
      authentication: 'none', credentialReads: 0, modelTurnsEntered: 0, sessionOpened: false, runs: [], cleanupFailures: [],
      startedAt: new Date().toISOString() };
    await checkpoint();
    const request = parseSandboxRequest({ policy: {
      resources: { cpus: 2, memoryBytes: 1024 ** 3, pids: 256 }, temporaryStorage: { homeBytes: 64 * 1024 ** 2, tempBytes: 64 * 1024 ** 2 },
      network: { kind: 'isolated' }, execution: { kind: 'deadline', timeoutMs: 120_000 }, deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
      transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 ** 2, maxOutputBytes: 8 * 1024 ** 2 },
    } });
    for (const kind of ['version', 'initialize']) {
      const run = { kind, status: 'running', cleanupFailures: [], observations: [], startedAt: new Date().toISOString() };
      report.runs.push(run);
      const persist = async (record) => {
        run.recoveryRecord = record;
        const pending = path.join(config.output, `${kind}-recovery.json.next`);
        await writeFile(pending, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await rename(pending, path.join(config.output, `${kind}-recovery.json`));
      };
      const owner = backend.reserve(request, { kind: 'persisted', persist });
      let registry;
      let openingCleanup;
      let reads;
      let versionStreams;
      try {
        const sandbox = await owner.start({ signal: cancellation.signal });
        await sandbox.importTree(binary.source(), { signal: cancellation.signal, deadlineAt: new Date(Date.now() + 120_000).toISOString(),
          quotas: { maxFiles: 1, maxFileBytes: binary.byteLength, maxTotalBytes: binary.byteLength } });
        if (kind === 'version') {
          const processOwner = sandbox.reserveProcess({ executable: parseSandboxGuestPath('/usr/local/bin/node'),
            cwd: sandbox.workspace, args: ['--input-type=module', '-e', versionProgram, '/workspace/work/harness/grok', GROK_SHA256], env: environment });
          versionStreams = await processOwner.start({ signal: cancellation.signal });
          reads = Promise.all([collect(versionStreams.stdout, 16 * 1024), collect(versionStreams.stderr, 16 * 1024)]);
          void reads.catch(() => {});
          versionStreams.stdin.end();
          const [[out, err], exit] = await Promise.all([reads, versionStreams.exit]);
          assert.deepEqual(exit, { kind: 'exited', code: 0 });
          const observed = JSON.parse(out.toString('utf8'));
          assert.equal(observed.sha256, GROK_SHA256);
          assert.equal(observed.version, GROK_VERSION);
          run.observed = { ...observed, supervisorStderrBytes: err.length };
          await processOwner.stop();
        } else {
          const providerKey = parseAgentProviderKey('platform-grok-initialize');
          const instanceId = parseAgentInstanceId('platform-grok:initialize');
          const driver = createNodeAcpProviderDriver({ providerKey, ...createSandboxAcpIntegration(sandbox),
            launch: { executable: '/workspace/work/harness/grok', cwd: sandbox.workspace,
              args: ['agent', '--no-leader', '--model', 'grok-4.3', '--reasoning-effort', 'Low', 'stdio'], env: environment, shutdownTimeoutMs: 15_000 },
            limits: { initializationTimeoutMs: 60_000 } });
          registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: {} }] });
          const instance = registry.requireInstance(instanceId);
          run.observed = { materialized: true, sessionOpened: false, credentialReads: 0, modelTurns: 0,
            protocolVersion: instance.capabilities.protocolVersion, authentication: instance.capabilities.authentication.kind,
            createSession: instance.capabilities.sessions.create, outputStreaming: instance.capabilities.output.streaming };
          await registry.dispose();
          registry = undefined;
        }
        run.observations.push(...await evidence.inspectResources(config.endpoint, owner.recoveryRecord, 'public-close', ['compute']));
      } catch (error) {
        run.primaryFailure = evidence.failureSummary(error);
        if (error instanceof AgentProviderRegistryError && error.code === 'instance_materialization_failed'
          && error.cause instanceof NodeAcpExecutionCleanupError) openingCleanup = error.cause;
      } finally {
        if (registry) {
          try { await registry.dispose(); } catch (error) { run.cleanupFailures.push({ operation: 'registry-dispose', failure: evidence.failureSummary(error) }); }
        }
        try { await owner.destroy(); } catch (error) {
          run.cleanupFailures.push({ operation: 'sandbox-destroy', failure: evidence.failureSummary(error) });
          versionStreams?.stdin.destroy(); versionStreams?.stdout.destroy(); versionStreams?.stderr.destroy();
          try { await owner.destroy(); run.cleanupRetry = 'settled'; } catch (retry) { run.cleanupRetry = evidence.failureSummary(retry); }
        }
        if (openingCleanup) {
          try { await openingCleanup.retryCleanup(); run.openingCleanupRetry = 'settled'; }
          catch (error) { run.cleanupFailures.push({ operation: 'opening-cleanup-retry', failure: evidence.failureSummary(error) }); }
        }
        if (reads) { try { await reads; } catch (error) { run.cleanupFailures.push({ operation: 'version-readers', failure: evidence.failureSummary(error) }); } }
        run.recoveryRecord = owner.recoveryRecord;
        try { run.observations.push(...await evidence.inspectResources(config.endpoint, owner.recoveryRecord, 'destroyed')); }
        catch (error) { run.evidenceFailure = evidence.failureSummary(error); }
        run.status = run.primaryFailure || run.cleanupFailures.length || run.evidenceFailure ? 'failed' : 'passed';
        run.finishedAt = new Date().toISOString();
        await checkpoint();
      }
      if (run.status !== 'passed') break;
    }
  } finally {
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    try { await binary.close(); } catch (error) {
      if (report) report.cleanupFailures.push({ operation: 'harness-descriptor', failure: evidence.failureSummary(error) });
      try { await binary.close(); } catch (retry) {
        if (report) report.cleanupFailures.push({ operation: 'harness-descriptor-retry', failure: evidence.failureSummary(retry) });
        else throw retry;
      }
    }
    if (report) {
      report.status = report.runs.length === 2 && report.runs.every((run) => run.status === 'passed') && !report.cleanupFailures.length ? 'passed' : 'failed';
      report.finishedAt = new Date().toISOString();
      await checkpoint();
    }
    if (outputOwned && !report) process.stderr.write('Owned Grok output directory retained after report initialization failure.\n');
  }
  assert.equal(report.status, 'passed', 'Grok version or ACP initialization qualification failed; inspect grok-report.json and latest recovery records.');
  process.stdout.write(`${JSON.stringify({ status: report.status, report: path.join(config.output, 'grok-report.json'), modelTurnsEntered: 0 })}\n`);
}

try { await main(); }
catch (error) {
  if (error instanceof GrokBinaryCleanupError) {
    try { await error.retryCleanup(); } catch { /* Original failure and cleanup failure remain in the error. */ }
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
