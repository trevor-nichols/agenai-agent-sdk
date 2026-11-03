import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyQualificationSources, within } from '../../scalability/identity.mjs';
import { destinations, digest, guestConfiguration, guestProcess } from './configuration.mjs';
import { sourceClosure } from './identity.mjs';

/** Resolve only public exports from the selected physical installed consumer. */
export async function installedSdk(consumer) {
  const loader = await copyQualificationSources(consumer, { name: 'sandbox-catalog-sdk', source: new URL('./', import.meta.url), files: ['sdk.mjs'] });
  const { resolvePublicSdk } = await import(pathToFileURL(join(loader.directory, 'sdk.mjs')).href);
  const load = async (specifier) => {
    const path = await realpath(fileURLToPath(resolvePublicSdk(specifier)));
    assert(within(join(consumer, 'node_modules'), path), 'Public SDK resolution escaped the selected installed consumer.');
    return import(pathToFileURL(path).href);
  };
  const [sandbox, sandboxNode, docker, dockerNode] = await Promise.all([
    load('@agen-ai/sandbox'), load('@agen-ai/sandbox/node'), load('@agen-ai/sandbox-docker'), load('@agen-ai/sandbox-docker/node'),
  ]);
  return { sandbox, sandboxNode, docker, dockerNode, loader };
}

export async function createCatalogBackend(sdk, { manifest, network, profile, endpoint, namespace, output }) {
  const spillDirectory = join(output, 'spill'); await mkdir(spillDirectory, { mode: 0o700 });
  const authority = { ...network.routeAuthority, engine: { ...network.routeAuthority.engine, endpoint } };
  const routeAuthority = sdk.dockerNode.createDockerDesktopRouteAuthority(authority);
  const backend = sdk.docker.createDockerSandboxBackend({ endpoint, namespace, profile, spillDirectory,
    imageDigest: manifest.workload.imageDigest, user: manifest.workload.user,
    egress: { ...network.egress.configuration, routeAuthority } });
  const request = sdk.sandbox.parseSandboxRequest({ policy: {
    resources: manifest.workload.resources,
    temporaryStorage: { homeBytes: manifest.workload.temporaryBytes, tempBytes: manifest.workload.temporaryBytes },
    network: { kind: 'restricted_https', destinations }, files: { kind: 'disabled' }, execution: { kind: 'until_stopped' },
    deadlines: { startupMs: 60000, cleanupMs: 30000 }, transfers: sdk.sandbox.SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: { ...sdk.sandbox.SANDBOX_DEFAULT_STREAM_LIMITS, maxStdinBytes: 1024 ** 2, maxOutputBytes: 512 * 1024 },
  } });
  return { backend, request };
}

export async function importGuest(sdk, sandbox, manifest) {
  assert.equal(sandbox.workspace, '/workspace/work');
  const entries = [{ kind: 'directory', path: 'project' }, { kind: 'directory', path: 'native-state' }];
  const sources = await sourceClosure([new URL('./guest/run.mjs', import.meta.url)]);
  for (const source of sources) {
    assert(source.name.startsWith('capabilities/catalog/'));
    const bytes = await readFile(new URL(`../../${source.name}`, import.meta.url));
    assert.equal(digest(bytes), source.sha256);
    entries.push(sdk.sandbox.fileFromBytes(source.name.slice('capabilities/'.length), bytes));
  }
  const config = guestConfiguration(manifest, sandbox.workspace);
  entries.push(sdk.sandbox.fileFromBytes('catalog/config.json', Buffer.from(JSON.stringify(config))));
  await sandbox.importTree(entries);
  return { sources, config, process: guestProcess(sandbox.workspace) };
}
