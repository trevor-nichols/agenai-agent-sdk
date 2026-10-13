import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAcpInstallPlan } from '../../../src/index.js';
import type { AcpInstallPlan } from '../../../src/planning/contracts.js';
import { binaryDistribution, planningInput, planningPolicy, planningSnapshot } from '../../planning.fixture.js';
import { digestBytes, tarFixture } from '../install-binary/index.js';

export async function storeFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'acp-store-test-'));
  const artifactPath = path.join(directory, 'agent.tar.gz');
  const archive = await tarFixture([
    { name: 'bin/agent', content: '#!/bin/sh\nprintf "store-fixture:%s\\n" "$1"\n', mode: 0o755 },
    { name: 'lib/dependencies/config.json', content: '{"nested":"retained"}' },
  ]);
  await writeFile(artifactPath, archive);
  const plan = fixturePlan(archive);
  return { directory, root: path.join(directory, 'store'), artifactPath, archive, plan,
    installInput: { plan, expectedPlanDigest: plan.digest, localArtifacts: [{ path: artifactPath, sha256: digestBytes(archive) }] },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function fixturePlan(archive: Uint8Array, options: { url?: string; args?: readonly string[]; command?: string; network?: boolean } = {}): AcpInstallPlan {
  const url = options.url ?? 'https://fixtures.example.test/agent.tar.gz';
  const target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` as AcpInstallPlan['target'];
  const snapshot = planningSnapshot({ binary: { [target]: binaryDistribution({ archive: url, cmd: options.command ?? 'bin/agent',
    args: options.args ?? ['literal;$(never-execute)'], sha256: digestBytes(archive).slice(7) }) } });
  return createAcpInstallPlan(snapshot, planningInput(snapshot, { target, policy: planningPolicy({
    network: options.network ? 'allow' : 'offline', allowedOrigins: [new URL(url).origin], allowInsecureHttp: url.startsWith('http:'),
  }) }));
}

export const installedIdentity = (plan: AcpInstallPlan, installationId: string) => ({ planDigest: plan.digest, installationId });
export const readRetainedReceipt = (root: string, plan: AcpInstallPlan) => readFile(path.join(root, 'installations', plan.digest.slice(7), 'receipt.json'), 'utf8');
