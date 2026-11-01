import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsonWriter } from '../live/evidence.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function compiledConcurrencyClosure(consumer) {
  const { default: ts } = await import('typescript');
  const root = join(consumer, 'platform-dist/examples/sandbox/concurrency');
  const pending = [join(root, 'index.js')], result = [], seen = new Set();
  while (pending.length) {
    const path = pending.shift(); if (seen.has(path)) continue; seen.add(path);
    assert(seen.size <= 32 && path.startsWith(`${root}/`) && path.endsWith('.js'), 'Bounded public example module closure required.');
    assert.equal(await realpath(path), path, 'Compiled public example modules must be physical files.');
    const bytes = await readFile(path); assert(bytes.length <= 256 * 1024);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // The independent installed compiler emits static ESM. Dynamic imports/require are not
    // admitted because a finite byte/source closure could otherwise miss executed modules.
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(parsed.parseDiagnostics.length, 0, 'Compiled public module must be valid JavaScript.');
    const staticOnly = (node) => {
      if (ts.isCallExpression(node)) assert(node.expression.kind !== ts.SyntaxKind.ImportKeyword
        && !(ts.isIdentifier(node.expression) && node.expression.text === 'require'), 'Public concurrency example must have a static installed module closure.');
      ts.forEachChild(node, staticOnly);
    };
    staticOnly(parsed);
    for (const statement of parsed.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      assert(ts.isStringLiteral(statement.moduleSpecifier));
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.')) pending.push(resolve(dirname(path), specifier));
      else assert(specifier.startsWith('node:') || ['@agen-ai/sandbox', '@agen-ai/sandbox/node', '@agen-ai/sandbox-docker'].includes(specifier),
        'The public example may load only public package entrypoints and Node built-ins.');
    }
    result.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  return Object.freeze(result.sort((left, right) => left.path.localeCompare(right.path)).map(Object.freeze));
}

export async function loadConcurrencyExample(config) {
  assert.equal(config.entrypoint.path, join(config.consumer, 'platform-dist/examples/sandbox/concurrency/index.js'));
  assert.deepEqual(await compiledConcurrencyClosure(config.consumer), config.entrypoint.modules,
    'Installed public example closure changed after launcher capture.');
  const example = await import(pathToFileURL(config.entrypoint.path).href);
  assert.equal(typeof example.runConcurrentSandboxWorkflow, 'function');
  assert.equal(typeof example.ConcurrentSandboxWorkflowError, 'function');
  return example;
}

export async function concurrentMember(context, label, selected, onPersist) {
  const { config, sdk, docker, node, authority, evidence } = context;
  const directory = join(config.output, label); await mkdir(directory, { mode: 0o700 });
  const spillDirectory = join(directory, 'spill'); await mkdir(spillDirectory, { mode: 0o700 });
  const namespace = `${config.namespacePrefix}${label}-${randomUUID().slice(0, 8)}`;
  const routeConfiguration = { ...config.capabilities.network.routeAuthority, profile: selected.profile };
  const routeAuthority = node.createDockerDesktopRouteAuthority(routeConfiguration);
  const configuration = { endpoint: config.endpoint, profile: selected.profile, namespace, spillDirectory,
    imageDigest: selected.imageDigest, user: config.capabilities.workload.user,
    filesystem: config.capabilities.filesystem.configuration,
    egress: { ...config.capabilities.network.egress.configuration, routeAuthority } };
  const backend = docker.createCoordinatedDockerSandboxBackend({ ...configuration, coordinator: authority });
  const entry = { label, namespace, configuration, selected, owner: null, checkpoints: [], directory, sandbox: null,
    cancellation: new AbortController() };
  context.members.push(entry);
  const report = { label, namespace, profile: selected.profile, imageDigest: selected.imageDigest, directory,
    configuration: { ...configuration, egress: { ...configuration.egress, routeAuthority: routeConfiguration } }, checkpoints: [],
    originalRecord: null, finalRecord: null, finalState: null };
  entry.report = report; context.report.members.push(report);
  const writeCurrent = jsonWriter(join(directory, 'latest-record.json'));
  const recovery = { kind: 'persisted', async persist(record) {
    assert(entry.checkpoints.length < 256, 'Member checkpoint bound exhausted.');
    const checkpoint = await evidence.file(`${label}/checkpoint-${String(entry.checkpoints.length + 1).padStart(4, '0')}.json`, record, 65_536);
    const value = { ...checkpoint, phase: record.phase };
    entry.checkpoints.push(value); report.checkpoints.push(value);
    await writeCurrent(record);
    for (const resource of record.resources) if (resource.role === 'route_observer' && resource.identity.kind === 'identified') {
      context.observerIds.set(resource.identity.id, { label, profile: selected.profile, namespace });
    }
    await onPersist?.(record, entry);
    await context.checkpoint?.(record, entry, value);
  } };
  const retainFailure = (operation, error, owner) => {
    entry.operationFailures ??= []; entry.operationFailures.push({ operation, error, record: owner.recoveryRecord });
  };
  const instrumented = { support: backend.support, reconcile: (...args) => backend.reconcile(...args), reserve(...args) {
    assert.equal(entry.owner, null, 'The public workflow must reserve each original owner once.');
    const owner = backend.reserve(...args); entry.owner = owner;
    report.originalRecord = owner.recoveryRecord;
    // Observation facade preserves each original owner and its ports; it supplies no outcome.
    return { get id() { return owner.id; }, get state() { return owner.state; }, get recoveryRecord() { return owner.recoveryRecord; },
      async start(options = {}) {
        try {
          entry.sandbox = await owner.start({ ...options, signal: options.signal
            ? AbortSignal.any([options.signal, entry.cancellation.signal]) : entry.cancellation.signal });
          return entry.sandbox;
        } catch (error) { retainFailure('start', error, owner); throw error; }
      },
      async stop(...input) {
        try { return await owner.stop(...input); } catch (error) { retainFailure('stop', error, owner); throw error; }
      }, async destroy(...input) {
        try { return await owner.destroy(...input); } catch (error) { retainFailure('destroy', error, owner); throw error; }
      } };
  } };
  const manifest = config.capabilities;
  const request = sdk.parseSandboxRequest({ policy: {
    resources: manifest.workload.resources,
    temporaryStorage: { homeBytes: manifest.workload.temporaryBytes, tempBytes: manifest.workload.temporaryBytes },
    network: { kind: 'restricted_https', destinations: [{ hostname: selected.positive.hostname, port: selected.positive.port }] },
    files: { kind: 'read_write' }, execution: { kind: 'until_stopped' },
    deadlines: { startupMs: manifest.limits.startupMs, cleanupMs: manifest.limits.cleanupMs },
    transfers: sdk.SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: { ...sdk.SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 ** 2, maxOutputBytes: manifest.limits.maxOutputBytes },
  } });
  return { entry, input: { backend: instrumented, request, recovery, positive: selected.positive, destination: join(directory, 'published') } };
}
