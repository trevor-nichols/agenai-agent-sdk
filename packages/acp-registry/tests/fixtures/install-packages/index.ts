import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpInstallPlan, type AcpDependencyLock, type AcpLockedPackage, type AcpPackageResolution, type AcpRegistryTarget } from '../../../src/index.js';
import type { AcpInstallationLimits, AcpPackageArtifact } from '../../../src/node/install/contracts.js';
import type { AcpInstallPreparationContext } from '../../../src/node/install/internal.js';
import { runAcpInstallTool } from '../../../src/node/install/tools/run.js';
import { fixtureToolchains } from '../toolchains.js';
import { planningInput, planningPolicy, planningSnapshot } from '../../planning.fixture.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const digest = (input: Uint8Array | string) => `sha256:${createHash('sha256').update(input).digest('hex')}`;
export const packageLimits: AcpInstallationLimits = {
  maxArtifactBytes: 1024 * 1024, maxTotalArtifactBytes: 4 * 1024 * 1024, maxPayloadBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024, maxEntries: 1024, maxPathDepth: 24, maxPathBytes: 1024,
  maxDownloadRedirects: 2, artifactTimeoutMs: 5000, toolTimeoutMs: 30_000, maxToolOutputBytes: 512 * 1024,
  maxReceiptBytes: 512 * 1024, maxReferences: 16,
};

function currentTarget(): AcpRegistryTarget {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : undefined;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
  if (!platform || !arch) throw new Error('The offline package fixture requires a supported target.');
  return `${platform}-${arch}`;
}

export interface PackageFixtureOptions {
  readonly rootName?: string;
  readonly locked?: boolean;
  readonly extra?: boolean;
  readonly command?: string;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AcpInstallationLimits>;
}

export async function packageContext(kind: 'npx' | 'uvx', options: PackageFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acp-packages-test-'));
  const payloadRoot = join(root, 'payload');
  const workRoot = join(root, 'work');
  await mkdir(payloadRoot); await mkdir(workRoot);
  try {
    const toolchains = await fixtureToolchains(kind, workRoot);
    const rootName = options.rootName ?? 'fixture-agent';
    const names = [rootName, 'fixture-dependency', ...(options.extra ? ['fixture-extra'] : [])];
    const artifacts = await Promise.all(names.map(async (name): Promise<AcpPackageArtifact & { path: string }> => {
      const version = name === 'fixture-dependency' ? '4.5.6' : name === 'fixture-extra' ? '1.0.0' : '1.2.3';
      const filename = kind === 'npx' ? `${name}-${version}.tgz` : `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`;
      const path = join(directory, filename);
      return { name, version, filename, path, url: `https://fixtures.example.test/${filename}`, sha256: digest(await readFile(path)) };
    }));
    const packages: AcpLockedPackage[] = artifacts.map((artifact) => ({ name: artifact.name, version: artifact.version, sha256: artifact.sha256,
      dependencies: artifact.name === rootName ? ['fixture-dependency@4.5.6'] : [] }));
    const primary = artifacts[0]!;
    const resolution: AcpPackageResolution = { kind, name: rootName, version: '1.2.3', command: options.command ?? 'native-fixture', artifact: { url: primary.url, sha256: primary.sha256 },
      ...(options.locked === false ? {} : { dependencyLock: packageLock(kind, packages, artifacts, rootName) }) };
    const snapshot = planningSnapshot({ [kind]: { package: kind === 'npx' ? `${rootName}@1.2.3` : `${rootName}==1.2.3`,
      args: ['literal;$(never-execute)', '--acp'], env: { ACP_FIXTURE_LAUNCH: 'launch-only' } } });
    const plan = createAcpInstallPlan(snapshot, planningInput(snapshot, { target: currentTarget(), distributionPreference: [kind], toolchains: toolchains.map(({ kind, version, sha256 }) => ({ kind, version, sha256 })),
      packageResolution: resolution, policy: planningPolicy({ network: 'offline', reproducibility: options.locked === false ? 'best-effort' : 'require-complete', allowedEnvironmentKeys: ['ACP_FIXTURE_LAUNCH'] }) }));
    const context: AcpInstallPreparationContext = { plan, payloadRoot, workRoot, toolchains, packageArtifacts: artifacts.map(({ path: _path, ...artifact }) => artifact),
      localArtifacts: artifacts.map(({ path, url, sha256 }) => ({ path, url, sha256 })), artifactBudget: { bytes: 0, count: 0 }, limits: { ...packageLimits, ...options.limits },
      signal: options.signal, runTool: runAcpInstallTool };
    return { root, context, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

function packageLock(kind: 'npx' | 'uvx', packages: readonly AcpLockedPackage[], artifacts: readonly AcpPackageArtifact[], rootName: string): AcpDependencyLock {
  const content = kind === 'uvx' ? artifacts.map((artifact) => `${artifact.name}==${artifact.version} --hash=sha256:${artifact.sha256.slice(7)}`).join('\n') + '\n'
    : JSON.stringify({ name: 'acp-installed-agent', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'acp-installed-agent', version: '1.0.0', dependencies: { [rootName]: '1.2.3' } },
      ...Object.fromEntries(artifacts.map((artifact) => [`node_modules/${artifact.name}`, { version: artifact.version, resolved: artifact.url,
        integrity: `sha256-${Buffer.from(artifact.sha256.slice(7), 'hex').toString('base64')}`,
        ...(artifact.name === rootName ? { dependencies: { 'fixture-dependency': '^4.0.0' } } : {}) }])) } });
  return { format: kind === 'npx' ? 'npm-package-lock-v3' : 'python-requirements-hashes', content, digest: digest(content), packages };
}
