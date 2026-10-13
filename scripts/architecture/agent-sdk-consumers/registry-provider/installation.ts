// ------------------------------------------------------------------------------------------------
//                installation.ts - Synthetic offline distribution preparation - Dependencies: registry
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { createAcpInstallPlan, parseAcpRegistrySnapshot, type AcpDependencyLock, type AcpRegistryTarget } from '@agen-ai/acp-registry';
import { inspectAcpToolchains, type AcpInspectedToolchain, type AcpInstallationStore, type AcpPackageArtifact } from '@agen-ai/acp-registry/node';

export type Distribution = 'binary' | 'npx' | 'uvx';
export type Mode = 'permission' | 'cancel' | 'malformed' | 'overflow';
export const literalArgs = ['$HOME', 'literal;$(never-execute)'];
export const launchEnvironment = { ACP_FIXTURE_MARKER: 'explicit-launch-only', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const digest = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

async function findExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('Packed offline installation proof requires ' + name + ' on the test host PATH.');
}

function target(): AcpRegistryTarget {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Packed binary/npm/uv integration proof requires a Linux x64 or arm64 test host.');
  }
  return process.arch === 'x64' ? 'linux-x86_64' : 'linux-aarch64';
}

export async function prepareArtifacts(root: string, fixtureRoot: string) {
  const scratch = join(root, 'scratch');
  await mkdir(scratch);
  const tools = await inspectAcpToolchains({ workRoot: scratch, toolchains: [
    { kind: 'node', path: await realpath(process.execPath) }, { kind: 'npm', path: await findExecutable('npm') },
    { kind: 'python', path: await findExecutable('python3') }, { kind: 'uv', path: await findExecutable('uv') },
  ], limits: { toolTimeoutMs: 30_000, maxToolOutputBytes: 128 * 1024 } });
  const python = tools.find((tool) => tool.kind === 'python')!;
  const home = join(root, 'generator-home');
  await mkdir(home);
  const artifactRoot = join(root, 'artifacts');
  await promisify(execFile)(python.path, ['-I', '-B', '-S', join(fixtureRoot, 'generate.py'), fixtureRoot, artifactRoot, process.execPath], {
    cwd: root, env: { HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, timeout: 10_000, maxBuffer: 128 * 1024,
  });
  return { artifactRoot, tools };
}

function packageLock(kind: 'npx' | 'uvx', artifact: AcpPackageArtifact): AcpDependencyLock {
  const content = kind === 'uvx' ? `${artifact.name}==${artifact.version} --hash=sha256:${artifact.sha256.slice(7)}\n`
    : JSON.stringify({ name: 'acp-installed-agent', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'acp-installed-agent', version: '1.0.0', dependencies: { [artifact.name]: artifact.version } },
      ['node_modules/' + artifact.name]: { version: artifact.version, resolved: artifact.url,
        integrity: 'sha256-' + Buffer.from(artifact.sha256.slice(7), 'hex').toString('base64') },
    } });
  return { format: kind === 'npx' ? 'npm-package-lock-v3' : 'python-requirements-hashes', content, digest: digest(content),
    packages: [{ name: artifact.name, version: artifact.version, sha256: artifact.sha256, dependencies: [] }] };
}

export async function installFixture(input: {
  store: AcpInstallationStore; root: string; artifactRoot: string; tools: readonly AcpInspectedToolchain[];
  kind: Distribution; mode: Mode;
}) {
  const { store, root, artifactRoot, tools, kind, mode } = input;
  const reportPath = join(root, `${kind}-${mode}.json`);
  const filename = kind === 'binary' ? 'peer.tar' : kind === 'npx' ? 'packed-acp-fixture-1.2.3.tgz' : 'packed_acp_fixture-1.2.3-py3-none-any.whl';
  const artifactPath = join(artifactRoot, filename);
  const sha256 = digest(await readFile(artifactPath));
  const artifact: AcpPackageArtifact = { name: 'packed-acp-fixture', version: '1.2.3', filename,
    url: 'https://packed-fixtures.invalid/' + filename, sha256 };
  const args = [reportPath, mode, ...literalArgs];
  const distribution = kind === 'binary' ? { binary: { [target()]: { archive: artifact.url, cmd: 'peer.mjs', sha256: sha256.slice(7), args, env: launchEnvironment } } }
    : { [kind]: { package: kind === 'npx' ? 'packed-acp-fixture@1.2.3' : 'packed-acp-fixture==1.2.3', args, env: launchEnvironment } };
  const snapshot = parseAcpRegistrySnapshot({ source: { namespace: 'packed-integration', kind: 'local', channel: 'stable',
    location: 'fixture:integrated-registry', profile: 'published-v1' }, content: JSON.stringify({ version: '1.0.0', agents: [{
      id: `${kind}-${mode}`, name: 'Retained offline ACP fixture', version: '1.2.3', description: 'Synthetic process without credentials or inference',
      license_url: 'https://packed-fixtures.invalid/LICENSE', distribution,
    }] }) });
  const entry = snapshot.entries[0]!;
  const selectedTools = tools.filter((tool) => kind === 'npx' ? ['node', 'npm'].includes(tool.kind) : kind === 'uvx' ? ['python', 'uv'].includes(tool.kind) : false);
  const plan = createAcpInstallPlan(snapshot, { entryIdentity: entry.identity, expectedSnapshotDigest: snapshot.digest, expectedEntryDigest: entry.digest,
    target: target(), distributionPreference: [kind], policy: { network: 'offline', allowedOrigins: [], allowInsecureHttp: false,
      packageScripts: 'deny', integrity: 'require-expected-sha256', reproducibility: 'require-complete', allowedEnvironmentKeys: Object.keys(launchEnvironment) },
    toolchains: selectedTools.map(({ kind, version, sha256 }) => ({ kind, version, sha256 })),
    ...(kind === 'binary' ? {} : { packageResolution: { kind, name: artifact.name, version: artifact.version, command: 'packed-acp-fixture',
      artifact: { url: artifact.url, sha256 }, dependencyLock: packageLock(kind, artifact) } }),
  });
  const receipt = await store.install({ plan, expectedPlanDigest: plan.digest,
    toolchains: selectedTools.map(({ kind, path }) => ({ kind, path })), localArtifacts: [{ path: artifactPath, url: artifact.url, sha256 }],
    ...(kind === 'binary' ? {} : { packageArtifacts: [artifact] }), signal: AbortSignal.timeout(60_000) });
  assert.equal(receipt.prepared.verification.expectedArtifactIntegrity, 'verified');
  assert.equal(receipt.prepared.verification.reproducibility, kind === 'binary' ? 'pinned-binary' : 'locked-package-inputs');
  assert.equal(receipt.payload.some((file) => file.path.endsWith('SCRIPT_RAN')), false, 'npm lifecycle scripts remain disabled');
  return { kind, mode, reportPath, identity: { planDigest: plan.digest, installationId: receipt.installationId }, receiptDigest: receipt.receiptDigest };
}

export type InstalledFixture = Awaited<ReturnType<typeof installFixture>>;
