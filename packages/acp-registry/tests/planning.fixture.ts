import { createHash } from 'node:crypto';
import { parseAcpRegistrySnapshot, type AcpDependencyLock, type AcpInstallPolicy, type AcpPackageResolution,
  type AcpRegistrySnapshot, type AcpRegistrySource, type CreateAcpInstallPlanInput } from '../src/index.js';
import { catalogAgent, catalogContent, catalogSource } from './fixtures/catalog/index.js';

export const artifactDigest = `sha256:${'a'.repeat(64)}`;
export const dependencyDigest = `sha256:${'b'.repeat(64)}`;
export const digestText = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export function binaryDistribution(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { archive: 'https://fixtures.example.test/agent.tar.gz', cmd: './bin/agent', sha256: artifactDigest.slice(7),
    args: ['--acp', 'literal;$(never-execute)'], ...overrides };
}

export function planningSnapshot(distribution: Readonly<Record<string, unknown>> = { binary: { 'linux-x86_64': binaryDistribution() } }, source: AcpRegistrySource = catalogSource): AcpRegistrySnapshot {
  return parseAcpRegistrySnapshot({ source, content: catalogContent([catalogAgent({ version: '2026.10.01', distribution })]) });
}

export function planningPolicy(overrides: Partial<AcpInstallPolicy> = {}): AcpInstallPolicy {
  return { network: 'allow', allowedOrigins: ['https://fixtures.example.test'], allowInsecureHttp: false,
    packageScripts: 'deny', integrity: 'require-expected-sha256', reproducibility: 'require-complete', allowedEnvironmentKeys: [], ...overrides };
}

export function planningInput(snapshot: AcpRegistrySnapshot, overrides: Partial<CreateAcpInstallPlanInput> = {}): CreateAcpInstallPlanInput {
  return { entryIdentity: snapshot.entries[0]!.identity, expectedSnapshotDigest: snapshot.digest, expectedEntryDigest: snapshot.entries[0]!.digest,
    target: 'linux-x86_64', distributionPreference: ['binary'], policy: planningPolicy(), ...overrides };
}

export function packagePlanningInput(snapshot: AcpRegistrySnapshot, kind: 'npx' | 'uvx', overrides: Partial<CreateAcpInstallPlanInput> = {}): CreateAcpInstallPlanInput {
  return planningInput(snapshot, { distributionPreference: [kind],
    toolchains: (kind === 'npx' ? ['node', 'npm'] as const : ['python', 'uv'] as const).map((tool) => ({ kind: tool,
      version: tool === 'node' ? '22.23.2' : tool === 'python' ? '3.12.7' : tool === 'npm' ? '11.7.0' : '0.12.0', sha256: dependencyDigest })),
    packageResolution: { kind, name: 'fixture-agent', version: '1.2.3', command: 'fixture-agent',
      artifact: { url: 'https://fixtures.example.test/fixture-agent-1.2.3.tgz', sha256: artifactDigest } },
    policy: planningPolicy({ reproducibility: 'best-effort' }), ...overrides });
}

export function lockedResolution(kind: 'npx' | 'uvx'): AcpPackageResolution {
  const packages = [
    { name: 'fixture-agent', version: '1.2.3', sha256: artifactDigest, dependencies: ['dependency@4.5.6'] },
    { name: 'dependency', version: '4.5.6', sha256: dependencyDigest, dependencies: [] },
  ];
  const integrity = (digest: string) => `sha256-${Buffer.from(digest.slice(7), 'hex').toString('base64')}`;
  const content = kind === 'npx' ? JSON.stringify({ name: 'fixture-install', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'fixture-install', version: '1.0.0', dependencies: { 'fixture-agent': '1.2.3' } },
    'node_modules/fixture-agent': { version: '1.2.3', resolved: 'https://fixtures.example.test/fixture-agent-1.2.3.tgz',
      integrity: integrity(artifactDigest), dependencies: { dependency: '^4.0.0' } },
    'node_modules/dependency': { version: '4.5.6', resolved: 'https://fixtures.example.test/dependency-4.5.6.tgz', integrity: integrity(dependencyDigest) },
  } }) : `# Exact target wheels resolved by the fixture caller\nfixture-agent==1.2.3 --hash=sha256:${artifactDigest.slice(7)}\ndependency==4.5.6 \\\n  --hash=sha256:${dependencyDigest.slice(7)}\n`;
  const dependencyLock: AcpDependencyLock = { format: kind === 'npx' ? 'npm-package-lock-v3' : 'python-requirements-hashes', content, digest: digestText(content), packages };
  return { kind, name: 'fixture-agent', version: '1.2.3', command: 'fixture-agent', dependencyLock };
}
