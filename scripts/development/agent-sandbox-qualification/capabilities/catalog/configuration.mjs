import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readManifestInput } from '../../platform/configuration.mjs';
import { acquireJsonInput, physicalPath } from '../../platform/capabilities/input.mjs';
import { parseCapabilityManifest } from '../../platform/capabilities/manifest.mjs';
import { keys, imageDigest, integer, resources, sha256, user } from '../../platform/capabilities/validation.mjs';
import { limits, nativeLaunch } from './protocol.mjs';

export const usage = 'Usage: node scripts/development/agent-sandbox-qualification/capabilities/catalog/run.mjs --manifest /absolute/catalog.json --consumer /absolute/installed-consumer --output /fresh/absolute/output\n';
export const digest = (value) => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
export const destinations = Object.freeze(['cli-chat-proxy.grok.com', 'api.x.ai', 'assets.grok.com', 'auth.x.ai', 'grok.com']
  .map((hostname) => Object.freeze({ hostname, port: 443 })));
export const nativeIdentity = Object.freeze({ executable: '/usr/local/bin/grok', version: '1.0.70', bytes: 166639048,
  sha256: '3aa36883574b263088e5addffe241f55430e8daaee1a0c4934b02180007a9761' });
export const bootstrapIdentity = Object.freeze({ executable: '/usr/local/bin/agenai-credential-bootstrap', bytes: 880544,
  sha256: 'a6bfacfc40a62c0eb18155f5669c24195e9bb285781bb7f90603ae596753aed1' });

export function parseArguments(argv) {
  assert.equal(argv.length, 6);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    assert(['--manifest', '--consumer', '--output'].includes(key) && !Object.hasOwn(result, key.slice(2)), 'Unknown or duplicate argument.');
    result[key.slice(2)] = physicalPath(argv[index + 1]);
  }
  assert(Buffer.byteLength(join(result.output, 'engine.sock')) <= 100, 'Use a shorter output parent.');
  return { manifestPath: result.manifest, consumer: result.consumer, output: result.output };
}

export function parseCatalogManifest(value) {
  keys(value, ['format', 'platform', 'network', 'workload', 'native', 'bootstrap', 'helperBaseImage', 'installedIdentitySha256', 'credentialSource']);
  assert.equal(value.format, 'agenai.native-catalog-manifest.v1');
  for (const reference of [value.platform, value.network]) { keys(reference, ['path', 'sha256']); physicalPath(reference.path); sha256(reference.sha256); }
  keys(value.workload, ['imageDigest', 'user', 'resources', 'temporaryBytes']); imageDigest(value.workload.imageDigest);
  assert.equal(value.workload.imageDigest, 'sha256:d37b995fa50e42c916e155122879403df1660ec72c94c4cc27c1f18e2c3b6d23');
  user(value.workload.user, [65534]); resources(value.workload.resources);
  integer(value.workload.temporaryBytes, 1024 ** 2, 128 * 1024 ** 2, 'temporaryBytes');
  assert.deepEqual(value.native, nativeIdentity); assert.deepEqual(value.bootstrap, bootstrapIdentity);
  assert.equal(value.helperBaseImage, 'docker.io/library/node@sha256:4ff2a3b4ac84d69e1f1a7f49d683e9675babea1828bdeeec1af0c6b7690ed0a4');
  sha256(value.installedIdentitySha256); assert.equal(value.credentialSource, 'selected_existing_account');
  return value;
}

export async function readCatalogManifest(options) {
  const selected = await acquireJsonInput(options.manifestPath, 32 * 1024);
  const manifest = parseCatalogManifest(selected.value);
  const platform = await readManifestInput(manifest.platform.path, 'restricted-https');
  assert.equal(platform.input.sha256, manifest.platform.sha256);
  assert.equal(platform.manifest.profile, 'desktop-apple-virtualization-native-arm64');
  const network = await acquireJsonInput(manifest.network.path, 32 * 1024);
  assert.equal(network.input.sha256, manifest.network.sha256);
  const capabilities = parseCapabilityManifest(network.value, { row: 'restricted-https', platform: platform.manifest,
    platformInput: platform.input, consumer: options.consumer, output: options.output });
  return { manifest, input: selected.input, utf8: selected.utf8, platform, network: { ...network, manifest: capabilities } };
}

export function guestConfiguration(manifest, workspace = '/workspace/work') {
  return { format: 'agenai.native-catalog-guest-config.v1', observation: 'native',
    native: { executable: manifest.native.executable, sha256: manifest.native.sha256, bytes: manifest.native.bytes },
    profile: `${workspace}/native-state/grok`, project: `${workspace}/project`,
    authFile: '/home/sandbox/.agenai-credentials/grok-auth.json' };
}

export function guestProcess(workspace = '/workspace/work') {
  return { executable: '/usr/local/bin/node', args: [`${workspace}/catalog/guest/run.mjs`, `${workspace}/catalog/config.json`],
    cwd: workspace, env: { HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } };
}

export function sanitizedConfiguration(manifest, network, platform) {
  const authority = network.network.routeAuthority;
  return { format: 'agenai.native-catalog-configuration.v1', platform: {
    profile: platform.profile, expected: platform.expected,
    desktop: { version: platform.desktop.version, vmm: platform.desktop.vmm, rosetta: platform.desktop.rosetta,
      enhancedContainerIsolation: platform.desktop.enhancedContainerIsolation },
    observerImage: platform.observerImage,
  }, workload: manifest.workload,
    native: manifest.native, bootstrap: manifest.bootstrap, credential: 'first_party_oidc_access_only', destinations,
    files: 'disabled', modelTasks: 0, observationMs: 45000, cleanupMs: 30000, requestMs: 30000,
    guest: { process: guestProcess(), configuration: guestConfiguration(manifest), nativeLaunch: nativeLaunch(guestConfiguration(manifest)), limits },
    helperBaseImage: manifest.helperBaseImage, egress: network.network.egress, routeAuthority: { ...authority,
      engine: { endpoint: 'selected_local_engine', id: authority.engine.id },
      hostObserver: { protocol: authority.hostObserver.protocol, sourceDigest: authority.hostObserver.sourceDigest,
        executable: { sha256: authority.hostObserver.executable.sha256 } } } };
}
