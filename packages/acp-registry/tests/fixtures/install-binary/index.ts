import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pack, type Header } from 'tar-stream';
import { createAcpInstallPlan } from '../../../src/index.js';
import type { AcpInstallationLimits } from '../../../src/node/install/contracts.js';
import type { AcpInstallPreparationContext } from '../../../src/node/install/internal.js';
import { binaryDistribution, planningInput, planningPolicy, planningSnapshot } from '../../planning.fixture.js';

export const fixtureDirectory = fileURLToPath(new URL('.', import.meta.url));
export const fixturePath = (name: string) => join(fixtureDirectory, name);
export const digestBytes = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const binaryLimits: AcpInstallationLimits = {
  maxArtifactBytes: 1024 * 1024, maxTotalArtifactBytes: 2 * 1024 * 1024, maxPayloadBytes: 2 * 1024 * 1024,
  maxDecompressedBytes: 4 * 1024 * 1024, maxEntries: 128, maxPathDepth: 16, maxPathBytes: 256,
  maxDownloadRedirects: 2, artifactTimeoutMs: 1000, toolTimeoutMs: 1000, maxToolOutputBytes: 1024,
  maxReceiptBytes: 16 * 1024, maxReferences: 16,
};

export async function binaryContext(name = 'valid.tar.gz', options: { expected?: string | null; command?: string; url?: string; limits?: Partial<AcpInstallationLimits>; signal?: AbortSignal } = {}): Promise<{ context: AcpInstallPreparationContext; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'acp-binary-test-'));
  const workRoot = join(root, 'work');
  const payloadRoot = join(root, 'payload');
  await mkdir(workRoot);
  await mkdir(payloadRoot);
  const path = fixturePath(name);
  const bytes = await readFile(path);
  const expected = options.expected === undefined ? digestBytes(bytes) : options.expected;
  const url = options.url ?? `https://fixtures.example.test/${name}`;
  const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ archive: url,
    cmd: options.command ?? 'bin/agent', ...(expected === null ? { sha256: undefined } : { sha256: expected.slice(7) }) }) } });
  const plan = createAcpInstallPlan(snapshot, planningInput(snapshot, { policy: planningPolicy({ network: 'offline',
    integrity: expected === null ? 'allow-missing-expected-sha256' : 'require-expected-sha256',
    reproducibility: expected === null ? 'best-effort' : 'require-complete' }) }));
  return { context: { plan, workRoot, payloadRoot, limits: { ...binaryLimits, ...options.limits }, signal: options.signal,
    localArtifacts: [{ url, path }], packageArtifacts: [], toolchains: [], artifactBudget: { bytes: 0, count: 0 },
    runTool: async () => { throw new Error('Binary installation must not invoke a tool.'); } },
  cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function tarFixture(entries: readonly (Partial<Header> & { name: string; content?: Uint8Array | string })[], compressed = true): Promise<Uint8Array> {
  const archive = pack();
  const chunks: Uint8Array[] = [];
  const consume = (async () => { for await (const chunk of archive) { if (!(chunk instanceof Uint8Array)) throw new Error('Fixture writer emitted non-bytes.'); chunks.push(chunk); } })();
  for (const { content, ...entry } of entries) {
    await new Promise<void>((resolve, reject) => archive.entry({ mode: 0o644, ...entry }, content ?? '', (error) => error ? reject(error) : resolve()));
  }
  archive.finalize();
  await consume;
  const bytes = Buffer.concat(chunks);
  return compressed ? gzipSync(bytes) : bytes;
}

export async function withArchive(bytes: Uint8Array, action: (path: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'acp-archive-test-'));
  const path = join(root, 'archive');
  try { await writeFile(path, bytes); await mkdir(join(root, 'payload')); await action(path, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
