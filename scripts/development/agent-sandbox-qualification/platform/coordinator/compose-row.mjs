import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Engine } from '../../engine.mjs';
import { atomicJson } from '../../capabilities/production/evidence.mjs';
import { installedIdentity } from '../../scalability/identity.mjs';
import { absolute } from './evidence.mjs';
import { coldScenario, parseScenario } from './configuration.mjs';

export const usage = `Usage:
  node scripts/development/agent-sandbox-qualification/platform/coordinator/compose-row.mjs --row single --assets /absolute/assets.json --consumer /absolute/consumer --engine unix:///absolute/docker.sock --workload-image sha256:<workload> --backend-socket /absolute/backend.sock --backend-log /absolute/com.docker.backend.log --root /new/absolute/row

Writes one coordinated row's controller input (and the cold wrapper input for cold rows) from Desktop's current
settings (GET /app/settings/gui on its backend socket), application version and cached Engine identity. No Engine effect.
`;
const PROFILE = 'desktop-apple-virtualization-native-arm64';
const PLIST = '/Applications/Docker.app/Contents/Info.plist';
const USER = Object.freeze({ uid: 65534, gid: 65534 });
const CONTROL = Object.freeze({ heartbeatMs: 1000, leaseTimeoutMs: 60_000 });
const helperBudget = (memoryBytes) => ({ resources: { cpus: 0.25, memoryBytes, pids: 32 }, temporaryBytes: 4 * 1024 ** 2 });
const PROXIES = ['proxy.host.http', 'proxy.host.https', 'proxy.host.pac', 'proxy.containers.http', 'proxy.containers.https', 'proxy.containers.pac'];

export const ROWS = Object.freeze({
  ms004: () => undefined,
  single: () => ({ kind: 'single' }),
  joint: () => ({ kind: 'joint' }),
  'foreign-network': () => ({ kind: 'foreign-network' }),
  'idle-reentry': (backendLogs) => ({ kind: 'idle-reentry', backendLogs }),
  'engine-restart': (backendLogs) => ({ kind: 'engine-restart', backendLogs }),
  'lifecycle-ab': () => ({ kind: 'lifecycle', removalOrder: ['a', 'b'], reentry: true }),
  'lifecycle-ba': () => ({ kind: 'lifecycle', removalOrder: ['b', 'a'], reentry: true }),
  'control-filesystem': () => ({ kind: 'control-loss', role: 'filesystem' }),
});

/** Maps Desktop's settings schema to the route authority's deployment assertion; unknown values pass through for the SDK to refuse. */
export function deploymentFromSettings(settings, desktop) {
  return { virtualMachineManager: settings['vm.hypervisor.mac'] === 'apple-virtualization-framework' ? 'apple_virtualization' : settings['vm.hypervisor.mac'],
    rosetta: settings['vm.rosetta.enabled'], enhancedContainerIsolation: settings['enhancedContainerIsolation.enabled'],
    hostNetworking: settings['vm.network.hostNetworkingEnabled'], kernelUdp: settings['vm.network.kernelForUDP'],
    networkingMode: settings['vm.network.defaultNetworkingMode'], dnsInhibition: settings['vm.network.dnsInhibition'],
    dockerSubnet: settings['vm.network.vpnkitCIDR'],
    proxyMode: settings['proxy.host.mode'] === 'system' ? 'automatic_system' : settings['proxy.host.mode'],
    manualProxyConfiguration: PROXIES.some((key) => settings[key] !== ''),
    desktopVersion: desktop.version, desktopBuild: desktop.build };
}

function backendSettings(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/app/settings/gui', agent: false, timeout: 15_000 }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Desktop settings GET deadline.'))); request.on('error', reject);
  });
}

const plist = async (key) => (await promisify(execFile)('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', PLIST])).stdout.trim();

export async function compose(options) {
  const root = absolute(options.root); await mkdir(root, { mode: 0o700 });
  const backendLogs = [absolute(options['backend-log'])];
  const scenario = ROWS[options.row](backendLogs); const cold = coldScenario(parseScenario(scenario));
  const assets = JSON.parse(await readFile(absolute(options.assets), 'utf8'));
  const settings = await backendSettings(absolute(options['backend-socket']));
  await atomicJson(join(root, 'desktop-settings.json'), settings);
  const desktop = { version: await plist('CFBundleShortVersionString'), build: await plist('CFBundleVersion') };
  const engine = new Engine(options.engine.slice(7), '1.52', { requestMs: 15_000, outputBytes: 4 * 1024 ** 2 });
  const version = (await engine.request('GET', '/version')).data; const info = (await engine.request('GET', '/info')).data;
  const deployment = deploymentFromSettings(settings.settings, desktop);
  const platform = { format: 'agenai.sandbox-platform-manifest.v1', engine: options.engine, profile: PROFILE,
    sourceImage: options['workload-image'], observerImage: assets.sourceImage,
    expected: { controller: { os: 'darwin', architecture: 'arm64', nodeVersion: process.versions.node },
      daemon: { id: info.ID, version: version.Version, apiVersion: version.ApiVersion, architecture: version.Arch,
        kernelVersion: info.KernelVersion, operatingSystem: info.OperatingSystem } },
    desktop: { version: desktop.version, applicationPlist: PLIST, vmm: 'apple-virtualization', rosetta: deployment.rosetta,
      enhancedContainerIsolation: deployment.enhancedContainerIsolation } };
  const routeAuthority = { kind: 'local_docker_desktop', profile: PROFILE, stability: 'caller_owned_quiescence',
    interception: 'caller_owned_no_transparent_or_per_app_interception', engine: { endpoint: options.engine, id: info.ID }, deployment,
    hostObserver: { protocol: 'agenai.desktop-host-network.v1', ...assets.hostObserver },
    vmObserver: { protocol: 'agenai.sandbox.desktop-route-observer.v1', observationProtocol: 'agenai.desktop-vm-network.v1',
      ...assets.vmObserver, executable: '/usr/local/bin/agenai-sandbox-desktop-route', user: USER, ...helperBudget(128 * 1024 ** 2), control: CONTROL },
    pollIntervalMs: 1000, commandTimeoutMs: 5000, maxOutputBytes: 4 * 1024 ** 2 };
  const capabilities = { format: 'agenai.sandbox-platform-capabilities.v1', profile: PROFILE,
    workload: { user: USER, resources: { cpus: 2, memoryBytes: 1024 ** 3, pids: 128 }, temporaryBytes: 128 * 1024 ** 2 },
    limits: { startupMs: 60_000, requestMs: 30_000, cleanupMs: 30_000, scenarioMs: 300_000 },
    filesystem: { sourceDigest: assets.filesystem.sourceDigest, configuration: { imageDigest: assets.filesystem.imageDigest,
      protocol: 'agenai.sandbox.filesystem.v1', executable: '/usr/local/bin/agenai-sandbox-files', layout: 'agenai.sandbox.workspace.v1',
      user: USER, ...helperBudget(128 * 1024 ** 2), control: CONTROL } },
    network: { egress: { sourceDigest: assets.egress.sourceDigest, configuration: { imageDigest: assets.egress.imageDigest,
      protocol: 'agenai.sandbox.egress-connect.v1', user: USER, broker: helperBudget(128 * 1024 ** 2), relay: helperBudget(64 * 1024 ** 2),
      control: CONTROL } }, routeAuthority } };
  const controllerInput = { consumer: options.consumer, output: join(root, 'controller'), platform, capabilities,
    deploymentObservation: { observedAt: new Date().toISOString(), source: 'GET /app/settings/gui', engine: { id: info.ID }, deployment },
    helper: assets.helper, ...(scenario === undefined ? {} : { scenario }),
    ...(cold ? {} : { vmPreparation: join(root, 'vm-preparation', 'report.json') }) };
  const paths = { controllerInput: join(root, 'controller-input.json') };
  await atomicJson(paths.controllerInput, controllerInput);
  if (cold) {
    paths.coldInput = join(root, 'cold-input.json');
    await atomicJson(paths.coldInput, { consumer: options.consumer, output: join(root, 'cold'), controllerInput: paths.controllerInput,
      backendSocket: options['backend-socket'], backendLogs, expectedCandidate: await installedIdentity(options.consumer) });
  } else paths.vmPreparationOutput = dirname(controllerInput.vmPreparation);
  return { row: options.row, cold, desktop, engine: platform.expected.daemon, ...paths };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(usage);
  else {
    const names = ['row', 'assets', 'consumer', 'engine', 'workload-image', 'backend-socket', 'backend-log', 'root'];
    const { values } = parseArgs({ strict: true, options: Object.fromEntries(names.map((name) => [name, { type: 'string' }])) });
    assert.deepEqual(Object.keys(values).sort(), [...names].sort()); assert(values.row in ROWS, `Unknown row ${values.row}.`);
    process.stdout.write(`${JSON.stringify(await compose(values))}\n`);
  }
}
