import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpInstallPlan, parseAcpRegistrySnapshot, searchAcpRegistry, type AcpRegistryTarget } from '@agen-ai/acp-registry';
import { openAcpInstallationStore } from '@agen-ai/acp-registry/node';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { approveSyntheticRequest, runExampleSession } from './run-session.js';

// This synthetic raw executable uses the host's explicit Node runtime through a POSIX shebang.
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('The raw-script example requires Linux/macOS on x64/arm64.');
}
const target = `${process.platform}-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}` as AcpRegistryTarget;
const nodeExecutable = await realpath(process.execPath);
if (/\s/u.test(nodeExecutable)) throw new Error('The synthetic shebang requires a Node executable path without whitespace.');
const root = await mkdtemp(join(tmpdir(), 'agent-sdk-registry-example-'));
try {
  // In a real host, these bytes and expected pins come from an independently trusted release source.
  const bytes = Buffer.concat([Buffer.from(`#!${nodeExecutable}\n`),
    await readFile(new URL('./fixtures/credentialless-peer.mjs', import.meta.url))]);
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  const artifactPath = join(root, 'approved-agent.bin');
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const artifactUrl = 'https://example.invalid/approved-agent.bin';
  const snapshot = parseAcpRegistrySnapshot({
    source: { namespace: 'example', kind: 'local', channel: 'stable', location: 'credentialless-example:1', profile: 'published-v1' },
    content: JSON.stringify({ version: '1.0.0', agents: [{
      id: 'credentialless-agent', name: 'Credentialless example', version: '1.0.0',
      description: 'A local synthetic ACP peer without authentication or inference.',
      license_url: 'https://example.invalid/LICENSE',
      distribution: { binary: { [target]: { archive: artifactUrl, cmd: 'agent.mjs', sha256: expectedSha256,
        args: ['$HOME', 'literal;$(never-execute)'], env: { EXAMPLE_MARKER: 'explicit-launch-environment' } } } },
    }] }),
  });
  const [entry] = searchAcpRegistry(snapshot, { query: 'credentialless', target, distributionKinds: ['binary'] });
  if (!entry) throw new Error('No exact approved distribution matches this host.');
  // Parsing, lookup and planning above/below are pure: they do not install or execute anything.
  const plan = createAcpInstallPlan(snapshot, {
    entryIdentity: entry.identity, expectedSnapshotDigest: snapshot.digest, expectedEntryDigest: entry.digest,
    target, distributionPreference: ['binary'], binaryFormat: 'raw',
    policy: { network: 'offline', allowedOrigins: [], allowInsecureHttp: false, packageScripts: 'deny',
      integrity: 'require-expected-sha256', reproducibility: 'require-complete', allowedEnvironmentKeys: ['EXAMPLE_MARKER'] },
  });
  const expectedPlanDigest = plan.digest;
  const storeRoot = join(root, 'installations');
  const store = await openAcpInstallationStore({ root: storeRoot });
  const receipt = await store.install({
    plan, expectedPlanDigest,
    localArtifacts: [{ path: artifactPath, url: artifactUrl, sha256: `sha256:${expectedSha256}` }],
    signal: AbortSignal.timeout(10_000),
  });
  // The receipt verifies installed bytes; the plan remains an unverified declaration of obligations.
  if (receipt.prepared.verification.expectedArtifactIntegrity !== 'verified') throw new Error('Artifact integrity was not verified.');
  await rm(artifactPath);
  const retainedStore = await openAcpInstallationStore({ root: storeRoot });
  const identity = { planDigest: expectedPlanDigest, installationId: receipt.installationId };
  const reference = await retainedStore.acquire({ ...identity, ownerId: 'example-session' });
  await writeFile(join(root, 'installation-reference.json'), JSON.stringify(reference), { mode: 0o600 });
  // No registry or artifact access occurs here. The live reference revalidates the retained payload.
  const launch = await retainedStore.resolveLaunch(reference);
  const driver = createNodeAcpProviderDriver({ providerKey: 'example-installed-acp', launch: {
    executable: launch.executable, args: launch.args, env: launch.env, cwd: root, shutdownTimeoutMs: 1_000,
  } });
  await runExampleSession(driver, root, approveSyntheticRequest);
  // Release only after the session and registry have successfully closed their owned process.
  // On failure, retain the reference and root until the host has established process quiescence.
  await retainedStore.release(reference);
  await retainedStore.remove(identity);
  await rm(root, { recursive: true, force: true });
} catch (error) {
  console.error(`Example failed; its store and reference are retained at ${root}. Establish process quiescence before releasing them.`);
  throw error;
}
