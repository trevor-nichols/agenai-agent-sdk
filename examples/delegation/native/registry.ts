// ------------------------------------------------------------------------------------------------
//                registry.ts - Pinned gzip acquisition, offline raw install and retained launch
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpInstallPlan, parseAcpRegistrySnapshot, searchAcpRegistry } from '@agen-ai/acp-registry';
import { openAcpInstallationStore } from '@agen-ai/acp-registry/node';
import type { NativeExecutableLease, NativePreparationInput, RegistryInstallationDescriptor } from './launch-contracts.js';
import { createNativeDirectory, inspectNativeFile, inspectNativeRoot, NativeCleanupError, nativeRelease } from './launch.js';

const MiB = 1_024 * 1_024;
const installLimits = Object.freeze({ maxArtifactBytes: 256 * MiB, maxTotalArtifactBytes: 256 * MiB,
  maxPayloadBytes: 256 * MiB, maxDecompressedBytes: 256 * MiB, maxEntries: 16 });

async function downloadPinnedGzip(input: NativePreparationInput, path: string): Promise<void> {
  const artifact = input.candidate.upstreamArtifact;
  const url = new URL(artifact.url);
  if (url.origin !== 'https://storage.googleapis.com' || url.username || url.password || url.hash
    || url.pathname !== '/grok-build-public-artifacts/cli/grok-1.0.50-linux-x86_64.gz' || url.search) {
    throw new Error('Native download is outside the exact approved artifact route.');
  }
  const timeout = AbortSignal.timeout(120_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal,
    headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' } });
  const contentLength = response.headers.get('content-length');
  if (response.status !== 200 || !response.body
    || response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity'
    || contentLength !== null && contentLength !== String(artifact.bytes)) {
    await response.body?.cancel();
    throw new Error('Pinned native artifact response is unavailable or has changed.');
  }
  const reader = response.body.getReader();
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    destination = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > artifact.bytes || bytes > input.candidate.transformation.maxInputBytes) {
        throw new Error('Pinned gzip exceeds its byte bound.');
      }
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const result = await destination.write(chunk.value, offset, chunk.value.byteLength - offset);
        if (!result.bytesWritten) throw new Error('Pinned gzip write made no progress.');
        offset += result.bytesWritten;
      }
    }
    if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new Error('Pinned gzip identity does not match.');
    await destination.sync();
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); await destination?.close(); }
  }
}

async function transformGzip(input: NativePreparationInput, compressed: string, decoded: string): Promise<void> {
  const transform = input.candidate.transformation;
  if (transform.recipe !== 'gzip-single-member-stream-v1' || transform.plannedTimeoutMs !== 30_000) {
    throw new Error('Native gzip transformation requires the frozen recipe and deadline.');
  }
  const decoderIdentity = await inspectNativeFile({ path: transform.decoderExecutable,
    maxBytes: 64 * MiB, ...(input.signal ? { signal: input.signal } : {}) });
  if (decoderIdentity.sha256 !== transform.decoderExecutableSha256) throw new Error('Native decoder executable changed.');
  const specification = JSON.stringify({
    ...transform,
    compressed: { bytes: input.candidate.upstreamArtifact.bytes, sha256: input.candidate.upstreamArtifact.sha256 },
    decoded: { bytes: input.candidate.upstreamArtifact.decoded.bytes, sha256: input.candidate.upstreamArtifact.decoded.sha256 },
    magicHex: input.candidate.upstreamArtifact.decoded.magicHex,
  });
  const child = spawn(transform.decoderExecutable, ['-I', '-S', '-B', fileURLToPath(new URL('./gzip.py', import.meta.url)), compressed, decoded],
    { shell: false, cwd: input.root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopped = false;
  let closeCode: number | null = null;
  let spawnError: Error | undefined;
  let outputBytes = 0;
  let output = '';
  let outputExceeded = false;
  let killError: unknown;
  const close = new Promise<void>((resolve) => {
    child.on('error', (error) => { spawnError = error; });
    child.once('close', (code) => { stopped = true; closeCode = code; resolve(); });
  });
  const kill = () => {
    try { if (!stopped) child.kill('SIGKILL'); } catch (error) { killError = error; }
  };
  const waitForClose = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([close.then(() => true), new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 8_192) { outputExceeded = true; kill(); }
    else output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 8_192) { outputExceeded = true; kill(); }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(specification);
  let expired = false;
  let stop!: () => void;
  const interruption = new Promise<false>((resolve) => { stop = () => resolve(false); });
  const timer = setTimeout(() => { expired = true; kill(); stop(); }, transform.plannedTimeoutMs);
  const onAbort = () => { kill(); stop(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    const closed = await Promise.race([close.then(() => true), interruption]);
    if (!closed && !await waitForClose()) {
      const retryCleanup = nativeRelease(async () => {
        kill();
        if (!await waitForClose()) throw new Error('Native decoder cleanup is still pending.');
      });
      throw new NativeCleanupError(input.signal?.reason ?? new Error('Native decoder exceeded its deadline.'),
        killError ?? new Error('Native decoder did not close after termination.'), input.root, retryCleanup);
    }
    input.signal?.throwIfAborted();
    if (expired || outputExceeded || spawnError || closeCode !== 0) throw new Error('Bounded native gzip transformation failed.');
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== 'object' || 'error' in result) throw new Error('Native gzip transformation returned invalid evidence.');
    await inspectNativeFile({ path: transform.decoderExecutable, expected: decoderIdentity, maxBytes: 64 * MiB });
    await inspectNativeFile({ path: decoded, expected: input.candidate.upstreamArtifact.decoded, ...(input.signal ? { signal: input.signal } : {}) });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

/** Called only by the installer worker. The caller must wait for this worker to exit. */
export async function installRegistryExecutable(input: NativePreparationInput): Promise<RegistryInstallationDescriptor> {
  input.signal?.throwIfAborted();
  if (process.platform !== 'linux' || process.arch !== 'x64' || input.candidate.native.target !== 'linux-x86_64'
    || input.candidate.native.sha256 !== input.candidate.upstreamArtifact.decoded.sha256
    || input.candidate.native.bytes !== input.candidate.upstreamArtifact.decoded.bytes) {
    throw new Error('The local transformed distribution does not match this native candidate.');
  }
  const directory = await createNativeDirectory(input.root, 'installation-');
  try {
    const compressed = join(directory.path, 'source.gz');
    const decoded = join(directory.path, 'decoded.bin');
    await downloadPinnedGzip(input, compressed);
    await transformGzip(input, compressed, decoded);
    const artifactUrl = 'https://qualification.invalid/grok-1.0.50-linux-x86_64.bin';
    const snapshot = parseAcpRegistrySnapshot({
      source: { namespace: 'native-qualification', kind: 'local', channel: 'stable',
        location: 'grok-1.0.50-transformed-binary:1', profile: 'published-v1' },
      content: JSON.stringify({ version: '1.0.0', agents: [{ id: 'grok-local-transformed',
        name: 'Grok local transformed binary', version: input.candidate.native.version,
        description: 'An explicitly local pinned gzip-to-raw native qualification distribution.',
        license_url: 'https://x.ai/legal/terms-of-service',
        distribution: { binary: { 'linux-x86_64': { archive: artifactUrl, cmd: 'grok',
          sha256: input.candidate.native.sha256, args: ['agent', '--no-leader', 'stdio'], env: {} } } },
      }] }),
    });
    const [entry] = searchAcpRegistry(snapshot, { query: 'grok-local-transformed', target: 'linux-x86_64', distributionKinds: ['binary'] });
    if (!entry || snapshot.entries.length !== 1) throw new Error('Exact local native registry entry is missing.');
    const plan = createAcpInstallPlan(snapshot, { entryIdentity: entry.identity,
      expectedSnapshotDigest: snapshot.digest, expectedEntryDigest: entry.digest,
      target: 'linux-x86_64', distributionPreference: ['binary'], binaryFormat: 'raw',
      policy: { network: 'offline', allowedOrigins: [], allowInsecureHttp: false, packageScripts: 'deny',
        integrity: 'require-expected-sha256', reproducibility: 'require-complete', allowedEnvironmentKeys: [] } });
    const storeRoot = join(directory.path, 'store');
    const store = await openAcpInstallationStore({ root: storeRoot, limits: installLimits });
    const receipt = await store.install({ plan, expectedPlanDigest: plan.digest,
      localArtifacts: [{ path: decoded, url: artifactUrl, sha256: `sha256:${input.candidate.native.sha256}` }],
      ...(input.signal ? { signal: input.signal } : {}) });
    if (receipt.prepared.verification.expectedArtifactIntegrity !== 'verified'
      || receipt.prepared.verification.reproducibility !== 'pinned-binary'
      || receipt.prepared.verification.gaps.length) throw new Error('Native installation did not verify the exact pinned raw artifact.');
    await rm(decoded);
    await rm(compressed);
    return Object.freeze({ format: 'native-local-raw-installation-v1', storeRoot,
      installerProcessId: process.pid, allocationId: directory.allocationId, snapshotDigest: snapshot.digest,
      planDigest: plan.digest, installationId: receipt.installationId, receiptDigest: receipt.receiptDigest,
      native: Object.freeze({ bytes: input.candidate.native.bytes, sha256: input.candidate.native.sha256 }),
      transformation: Object.freeze({ bytes: input.candidate.upstreamArtifact.bytes, sha256: input.candidate.upstreamArtifact.sha256,
        decoded: Object.freeze({ bytes: input.candidate.native.bytes, sha256: input.candidate.native.sha256 }),
        decoderExecutableSha256: input.candidate.transformation.decoderExecutableSha256,
        pythonVersion: input.candidate.transformation.pythonVersion,
        zlibCompileVersion: input.candidate.transformation.zlibCompileVersion,
        zlibRuntimeVersion: input.candidate.transformation.zlibRuntimeVersion }),
    });
  } catch (cause) {
    if (cause instanceof NativeCleanupError) {
      const retryCleanup = nativeRelease(async () => { await cause.retryCleanup(); await directory.release(); });
      throw new NativeCleanupError(cause, new Error('Native installation is retained until decoder cleanup succeeds.'),
        directory.path, retryCleanup);
    }
    try { await directory.release(); } catch (cleanupError) {
      throw new NativeCleanupError(cause, cleanupError, directory.path, directory.release);
    }
    throw cause;
  }
}

/** Called only in a new worker after the installer exited; PID inequality is an additional guard. */
export async function openRegistryExecutable(input: NativePreparationInput & {
  readonly installation: RegistryInstallationDescriptor;
  readonly ownerId: string;
}): Promise<NativeExecutableLease> {
  const installed = input.installation;
  input.signal?.throwIfAborted();
  if (installed.installerProcessId === process.pid) throw new Error('Retained qualification requires a fresh process after installation.');
  if (installed.native.bytes !== input.candidate.native.bytes || installed.native.sha256 !== input.candidate.native.sha256) {
    throw new Error('Retained installation descriptor differs from the approved native identity.');
  }
  await inspectNativeRoot(input.root);
  const storeRelative = relative(input.root, installed.storeRoot);
  if (!storeRelative || storeRelative === '..' || storeRelative.startsWith('../') || isAbsolute(storeRelative)
    || await realpath(installed.storeRoot) !== installed.storeRoot) {
    throw new Error('Retained native store must stay inside its owned physical invocation root.');
  }
  const directory = join(installed.storeRoot, '..');
  for (const name of ['source.gz', 'decoded.bin']) {
    try { await lstat(join(directory, name)); throw new Error('Temporary native artifact remains available before retained launch.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const store = await openAcpInstallationStore({ root: installed.storeRoot, limits: installLimits });
  const identity = { planDigest: installed.planDigest, installationId: installed.installationId };
  const receipt = await store.read(identity);
  if (receipt.receiptDigest !== installed.receiptDigest || receipt.plan.snapshotDigest !== installed.snapshotDigest) {
    throw new Error('Retained native installation receipt does not match the committed descriptor.');
  }
  const reference = await store.acquire({ ...identity, ownerId: input.ownerId });
  const releaseReference = nativeRelease(() => store.release(reference));
  try {
    const launch = await store.resolveLaunch(reference);
    if (launch.target !== 'linux-x86_64' || Object.keys(launch.env).length
      || JSON.stringify(launch.args) !== JSON.stringify(['agent', '--no-leader', 'stdio'])) {
      throw new Error('Retained native launch differs from the approved literal recipe.');
    }
    const measured = await inspectNativeFile({ path: launch.executable, expected: installed.native, ...(input.signal ? { signal: input.signal } : {}) });
    const release = nativeRelease(async () => { await releaseReference(); await store.remove(identity); });
    return Object.freeze({ mode: 'registry', executable: launch.executable, identity: measured,
      evidence: Object.freeze({ mode: 'registry', identity: measured, allocationId: installed.allocationId,
        registry: Object.freeze({ snapshotDigest: installed.snapshotDigest, ...identity, receiptDigest: installed.receiptDigest,
          referenceId: reference.referenceId, ownerId: reference.ownerId, reopenedFromFreshProcess: true }) }),
      assertUnchanged: async () => {
        const current = await store.resolveLaunch(reference);
        if (current.executable !== launch.executable) throw new Error('Retained native executable path changed.');
        await inspectNativeFile({ path: current.executable, expected: measured });
      }, release,
    });
  } catch (cause) {
    try { await releaseReference(); } catch (cleanupError) {
      throw new NativeCleanupError(cause, cleanupError, installed.storeRoot, releaseReference);
    }
    throw cause;
  }
}
