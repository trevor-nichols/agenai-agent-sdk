import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../engine.mjs';
import { acquireJsonInput, physicalPath } from '../input.mjs';
import { appendObservation, failure, json, jsonWriter } from '../live/evidence.mjs';
import { settleOwnerCleanup } from '../live/owner-cleanup.mjs';
import { networkCaseNames, networkScenarioBudget } from './budget.mjs';
import { connectivityCases } from './connectivity.mjs';
import { faultCases } from './faults.mjs';
import { createFixtures, sha } from './fixtures.mjs';
import { census } from './resources.mjs';

const [path] = process.argv.slice(2); assert.equal(process.argv.length, 3);
const { value: config } = await acquireJsonInput(path, 256 * 1024);
assert.deepEqual(Object.keys(config).sort(), ['format', 'endpoint', 'profile', 'imageDigest', 'consumer', 'output', 'capabilities',
  'fixtureOwner', 'namespacePrefix', 'sourceIdentity', 'scenarioBudget', 'guestNodeVersion', 'endpointProjection'].sort());
assert.equal(config.format, 'agenai.sandbox-platform-network-controller.v1');
assert.equal(config.capabilities.row, 'restricted-https'); assert.equal(config.profile, config.capabilities.profile);
assert(config.profile.startsWith('desktop-apple-virtualization-'));
assert.deepEqual(networkScenarioBudget(config.capabilities), config.scenarioBudget);
physicalPath(config.consumer); physicalPath(config.output);
assert.equal(await realpath(config.consumer), config.consumer); assert.equal(process.cwd(), config.consumer);
assert(fileURLToPath(import.meta.url).startsWith(`${config.consumer}/qualification/`));
for (const name of ['@agen-ai/sandbox', '@agen-ai/sandbox-docker', '@agen-ai/sandbox-docker/node']) {
  assert(fileURLToPath(import.meta.resolve(name)).startsWith(`${config.consumer}/node_modules/`));
}
assert.match(config.fixtureOwner, /^[a-f0-9-]{36}$/u); assert.match(config.namespacePrefix, /^platform-net-[a-f0-9]{8}-$/u);
assert.equal(config.endpointProjection.effectiveEndpoint, config.endpoint);
assert.equal(config.endpointProjection.capturedEndpoint, config.capabilities.network.routeAuthority.engine.endpoint);
const cancellation = new AbortController(); const interrupt = () => cancellation.abort(new Error('Installed network qualification interrupted.'));
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
await mkdir(config.output, { mode: 0o700 });
const report = { format: 'agenai.sandbox-platform-network.v1', status: 'running', profile: config.profile,
  imageDigest: config.imageDigest, guestNodeVersion: config.guestNodeVersion, sourceIdentity: config.sourceIdentity,
  startedAt: new Date().toISOString(), scenarioBudget: config.scenarioBudget, namespacePrefix: config.namespacePrefix,
  fixtureOwner: config.fixtureOwner, endpointProjection: config.endpointProjection, capturedAuthority: config.capabilities.network.routeAuthority,
  cases: [], selectedCases: [], requirements: {},
  scope: { transport: 'IPv4 with client TLS verification; IPv6 connectivity unsupported.',
    stability: 'Caller-owned host/VM/Engine/proxy/executable quiescence; sequential observations do not prove continuous safety.',
    deterministic: ['controlled DNS aliases/rebinding/mixed answers', 'numeric peer pinning', 'redirect-target second CONNECT', 'healthy bidirectional tunnel backpressure'],
    nativeHttp302: false, nativeBulkBackpressure: false,
    positiveTlsDns: 'Each new connection resolves and pins a currently admitted numeric peer; no frozen address equality across actors or time.',
    fixtureDns: { hostname: config.capabilities.network.fixtures.publicHostname, address: config.capabilities.network.fixtures.publicAddress,
      scope: 'Explicit fixture-only DNS dependency; no additional HTTP origin, custom DNS server or global DNS/hosts mutation.' },
    specialGateway: { hostname: 'gateway.docker.internal', coverage: 'Observed DNS and unlisted CONNECT only.',
      directTransport: 'unexercised', reachableServiceIsolation: 'unexercised' } }, cleanupFailures: [] };
const writeReport = jsonWriter(join(config.output, 'network-report.json'));
const saveReport = () => { assert(Buffer.byteLength(json(report)) <= 1024 ** 2); return writeReport(report); };
const rawEngine = new Engine(config.endpoint.slice(7), '1.52', { requestMs: config.capabilities.limits.requestMs, outputBytes: 4 * 1024 ** 2 });
const fence = async () => {
  await verifyProxy({ endpoint: config.endpoint, ...config.endpointProjection.proxySocket });
  assert.equal((await rawEngine.request('GET', '/info')).data.ID, config.capabilities.network.routeAuthority.engine.id);
};
const engine = { async request(...args) { await fence(); return rawEngine.request(...args); },
  async hijack(...args) { await fence(); return rawEngine.hijack(...args); } };
const runs = []; let probeSource;
const context = { config, engine, signal: cancellation.signal,
  async probeSource() {
    probeSource ??= (await readFile(new URL('../../../capabilities/desktop/guest.mjs', import.meta.url), 'utf8'))
      + `\nconst command=JSON.parse(process.argv[1]);command.timeoutMs=${config.capabilities.limits.requestMs - 250};try{process.stdout.write(JSON.stringify({ok:true,result:await runGuest(command)})+'\\n');}catch(error){process.stdout.write(JSON.stringify({ok:false,error:{name:error.name,code:error.code??null,message:error.message}})+'\\n');}\n`;
    assert(Buffer.byteLength(probeSource) <= 48 * 1024); return probeSource;
  },
  async assertNoActiveOwners() {
    for (const run of runs) {
      for (const entry of run.owners) assert.equal(entry.owner.state.kind, 'destroyed');
      if (run.evidence.childOwner) assert(run.evidence.childOwner.quiescent && run.evidence.childOwner.cleanupKind);
    }
  },
};
async function verifyProxy(identity) {
  const socket = await lstat(identity.endpoint.slice(7), { bigint: true }); assert(socket.isSocket());
  assert.deepEqual({ device: String(socket.dev), inode: String(socket.ino), mode: String(socket.mode), uid: String(socket.uid), gid: String(socket.gid) },
    { device: identity.device, inode: identity.inode, mode: identity.mode, uid: identity.uid, gid: identity.gid });
}
async function cleanup(run) {
  for (const action of [...run.beforeCleanup].reverse()) try { await action(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  for (const entry of [...run.owners].reverse()) {
    try {
      await run.settleCleanup(entry, 'destroy'); assert.equal(entry.owner.state.kind, 'destroyed');
      run.evidence.owners.find(({ namespace }) => namespace === entry.namespace).finalRecord = entry.owner.recoveryRecord;
      run.evidence.census.push(...await census(engine, entry.owner.recoveryRecord, 'case-final-exact-absence', true));
      await verifyProxy(entry.proxyIdentity);
    } catch (error) { run.evidence.cleanupErrors.push({ namespace: entry.namespace, ...failure(error) }); }
  }
  for (const session of run.sessions) try { await run.observe({ kind: 'sole-network-guest-reader-joined', result: await session.join() }); }
  catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  for (const proxy of [...run.proxies].reverse()) try { await proxy.close(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  for (const action of run.afterCleanup) try { await action(); } catch (error) { run.evidence.cleanupErrors.push(failure(error)); }
  run.evidence.cleanupComplete = run.evidence.cleanupErrors.length === 0;
  if (!run.evidence.cleanupComplete) run.evidence.status = 'failed'; await run.save();
}
try {
  await saveReport(); context.fixtures = await createFixtures(context); await context.fixtures.startBase();
  const all = [...connectivityCases(context), ...faultCases(context)];
  assert.deepEqual(all.map(([name]) => name).sort(), [...networkCaseNames].sort());
  const publicNames = networkCaseNames.slice(4, 11);
  const cases = [...all.filter(([name]) => !publicNames.includes(name)), ...all.filter(([name]) => publicNames.includes(name))];
  report.selectedCases = cases.map(([name]) => name);
  report.requirements = {
    D11: ['verified-tls-exact-body', 'connect-unlisted-and-canonical-forms', 'direct-no-proxy-tcp-udp'],
    D12: ['host-and-special-host-reachable-denials', 'vm-gateway-reachable-denials', 'public-numbered-sibling-reachable-denials', 'allowed-dns-public-local-denied'],
    D13: ['connect-unlisted-and-canonical-forms', 'allowed-dns-public-local-denied', 'ipv6-unsupported-no-bypass'],
    D14: faultCases(context).map(([name]) => name),
  };
  await saveReport(); let publicReady = false;
  for (const [index, [name, action]] of cases.entries()) {
    cancellation.signal.throwIfAborted();
    if (publicNames.includes(name) && !publicReady) { await context.fixtures.activatePublic(); publicReady = true; }
    const directory = join(config.output, `c${String(index + 1).padStart(2, '0')}`); await mkdir(directory, { mode: 0o700 });
    const reportPath = join(directory, 'case-report.json'); const writeCase = jsonWriter(reportPath);
    const evidence = { name, directory, status: 'running', cohort: publicReady ? 'public-local' : 'ordinary',
      startedAt: new Date().toISOString(), owners: [], observations: [], census: [], cleanupErrors: [] };
    const run = { directory, evidence, owners: [], sessions: [], proxies: [], beforeCleanup: [], afterCleanup: [],
      limits: config.capabilities.limits, control: config.capabilities.network.egress.configuration.control,
      save() { assert(Buffer.byteLength(json(evidence)) <= 4 * 1024 ** 2); return writeCase(evidence); },
      async observe(value) { assert(evidence.observations.length < 512); await appendObservation(evidence, value, run.save); },
      settleCleanup: (entry, operation) => settleOwnerCleanup(entry.owner, operation, { cleanupMs: config.capabilities.limits.cleanupMs,
        observe: (value) => run.observe({ namespace: entry.namespace, ...value }) }),
    };
    runs.push(run); const summary = { name, directory, reportPath, status: 'running', cleanupComplete: false };
    report.cases.push(summary); await run.save(); await saveReport();
    const deadline = new AbortController(); context.signal = AbortSignal.any([cancellation.signal, deadline.signal]);
    let timedOut = false; const timer = setTimeout(() => {
      timedOut = true; deadline.abort(new Error('Captured network scenario deadline.'));
      for (const entry of run.owners) void entry.owner.stop().catch(() => {});
    }, config.capabilities.limits.scenarioMs);
    try { await action(run); assert.equal(timedOut, false); evidence.status = 'passed'; }
    catch (error) { evidence.status = 'failed'; evidence.failure = failure(error); }
    finally {
      clearTimeout(timer); await cleanup(run); evidence.finishedAt = new Date().toISOString(); await run.save();
      const bytes = await readFile(reportPath); Object.assign(summary, { status: evidence.status, cleanupComplete: evidence.cleanupComplete,
        bytes: bytes.length, sha256: sha(bytes), originalReservations: evidence.childOwner
          ? Number(evidence.childOwner.originalReservationConfirmed) : run.owners.length }); await saveReport();
    }
    process.stdout.write(JSON.stringify({ event: 'case_completed', name, status: evidence.status, cleanupComplete: evidence.cleanupComplete }) + '\n');
    if (evidence.status !== 'passed' || !evidence.cleanupComplete) break;
  }
} catch (error) { report.failure = failure(error); }
finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  let releaseNetworks = true;
  try { await context.assertNoActiveOwners(); } catch (error) { releaseNetworks = false; report.cleanupFailures.push(failure(error)); }
  try { if (context.fixtures) await context.fixtures.close({ releaseNetworks }); }
  catch (error) { report.cleanupFailures.push(failure(error)); }
  report.fixtures = context.fixtures?.record ?? null;
  report.matrix = Object.fromEntries(Object.entries(report.requirements).map(([requirement, names]) => [requirement, {
    coverage: 'native_component',
    status: names.every((name) => report.cases.some((entry) => entry.name === name && entry.status === 'passed' && entry.cleanupComplete)) ? 'passed' : 'failed', cases: names,
  }]));
  report.status = report.cases.length === networkCaseNames.length && report.cases.every((entry) => entry.status === 'passed' && entry.cleanupComplete && entry.originalReservations === 1)
    && report.fixtures?.closed && report.fixtures.controlFailures.length === 0 && !report.failure && report.cleanupFailures.length === 0 ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); await saveReport();
}
if (report.status !== 'passed') process.exitCode = 1;
process.stdout.write(JSON.stringify({ status: report.status, report: join(config.output, 'network-report.json') }) + '\n');
