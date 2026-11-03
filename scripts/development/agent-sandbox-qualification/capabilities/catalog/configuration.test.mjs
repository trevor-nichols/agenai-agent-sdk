import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capabilityManifest, platformManifest } from '../../platform/capabilities/test-fixtures.mjs';
import { bootstrapIdentity, digest, nativeIdentity, parseArguments, readCatalogManifest, sanitizedConfiguration } from './configuration.mjs';

test('catalog admission binds both captured manifests and excludes host paths from the public configuration', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'catalog-admission-')));
  try {
    const platform = platformManifest('desktop-apple-virtualization-native-arm64');
    const platformBytes = JSON.stringify(platform), platformPath = join(directory, 'platform.json');
    const network = capabilityManifest('restricted-https', digest(platformBytes), platform);
    const networkBytes = JSON.stringify(network), networkPath = join(directory, 'network.json');
    const manifest = { format: 'agenai.native-catalog-manifest.v1',
      platform: { path: platformPath, sha256: digest(platformBytes) }, network: { path: networkPath, sha256: digest(networkBytes) },
      workload: { imageDigest: 'sha256:d37b995fa50e42c916e155122879403df1660ec72c94c4cc27c1f18e2c3b6d23', user: { uid: 65534, gid: 65534 },
        resources: { cpus: 2, memoryBytes: 1024 ** 3, pids: 128 }, temporaryBytes: 128 * 1024 ** 2 },
      native: nativeIdentity, bootstrap: bootstrapIdentity,
      helperBaseImage: 'docker.io/library/node@sha256:4ff2a3b4ac84d69e1f1a7f49d683e9675babea1828bdeeec1af0c6b7690ed0a4',
      installedIdentitySha256: '0'.repeat(64), credentialSource: 'selected_existing_account' };
    const manifestPath = join(directory, 'catalog.json');
    await writeFile(platformPath, platformBytes); await writeFile(networkPath, networkBytes); await writeFile(manifestPath, JSON.stringify(manifest));
    const options = { manifestPath, consumer: join(directory, 'consumer'), output: join(directory, 'output') };
    const selected = await readCatalogManifest(options);
    const configuration = sanitizedConfiguration(selected.manifest, selected.network.manifest, selected.platform.manifest);
    assert.equal(configuration.platform.expected.daemon.id, 'selected-daemon');
    assert.equal(configuration.routeAuthority.hostObserver.executable.path, undefined);
    assert.equal(configuration.routeAuthority.hostObserver.executable.sha256, '2'.repeat(64));
    assert.equal(configuration.routeAuthority.engine.endpoint, 'selected_local_engine');
    assert(!JSON.stringify(configuration).includes('/unopened/'));
    assert.equal(configuration.files, 'disabled'); assert.equal(configuration.modelTasks, 0);
    await writeFile(networkPath, `${networkBytes}\n`);
    await assert.rejects(readCatalogManifest(options));
    await writeFile(networkPath, networkBytes);
    manifest.native = { ...nativeIdentity, version: '1.0.62' };
    await writeFile(manifestPath, JSON.stringify(manifest)); await assert.rejects(readCatalogManifest(options));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('catalog CLI rejects automatic, relative, duplicate and unknown input selection', () => {
  const args = ['--manifest', '/private/catalog.json', '--consumer', '/private/consumer', '--output', '/private/new-run'];
  assert.deepEqual(parseArguments(args), { manifestPath: '/private/catalog.json', consumer: '/private/consumer', output: '/private/new-run' });
  for (const invalid of [args.slice(0, -1), [...args, '--mode', 'automatic'],
    ['--manifest', '/private/catalog.json', '--manifest', '/private/catalog.json', '--output', '/private/run'],
    args.map((value) => value === '/private/consumer' ? '../consumer' : value), args.map((value) => value === '--consumer' ? '--account' : value)]) {
    assert.throws(() => parseArguments(invalid));
  }
});
