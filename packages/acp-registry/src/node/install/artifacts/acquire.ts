import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertFetchUrl, redirectUrl, type RegistryFetchPolicy } from '../../fetch-policy.js';
import type { AcpInstalledArtifact } from '../contracts.js';
import { AcpInstallationError } from '../errors.js';
import type { AcpInstallPreparationContext } from '../internal.js';

export interface AcquiredArtifact extends AcpInstalledArtifact {
  readonly path: string;
}

export interface AcquireArtifactInput {
  readonly url: string;
  readonly expectedSha256?: string;
  readonly context: AcpInstallPreparationContext;
}

export async function acquireArtifact(input: AcquireArtifactInput): Promise<AcquiredArtifact> {
  const { url, expectedSha256, context } = input;
  context.signal?.throwIfAborted();
  assertSourceUrl(url);
  if (expectedSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new AcpInstallationError('invalid_input', 'Expected artifact checksums must be canonical SHA-256 digests.');
  }
  const matches = context.localArtifacts.filter((artifact) => artifact.url === url
    || artifact.url === undefined && expectedSha256 !== undefined && artifact.sha256 === expectedSha256);
  if (matches.length > 1) throw new AcpInstallationError('invalid_input', 'More than one local artifact matches this exact source.');
  const local = matches[0];
  if (local?.sha256 !== undefined && expectedSha256 !== undefined && local.sha256 !== expectedSha256) {
    throw new AcpInstallationError('integrity_mismatch', 'The local artifact mapping conflicts with the planned checksum.');
  }
  if (!local && context.plan.policy.network === 'offline') {
    throw new AcpInstallationError('artifact_unavailable', 'Offline installation requires an exact caller-supplied local artifact.');
  }
  if (context.artifactBudget.count >= context.limits.maxEntries) throw new AcpInstallationError('limit_exceeded', 'The installation artifact count exceeds its limit.');
  context.artifactBudget.count += 1;
  await assertWorkRoot(context.workRoot);
  const directory = await mkdtemp(join(context.workRoot, 'artifact-'));
  const path = join(directory, 'content');
  const lifetime = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
  const timeout = setTimeout(() => lifetime.abort(new AcpInstallationError('timeout', 'Artifact acquisition exceeded its deadline.')), context.limits.artifactTimeoutMs);
  let destination: FileHandle | undefined;
  try {
    destination = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const source = local ? await localSource(local.path, context, signal) : await networkSource(url, context, signal);
    try {
      const hash = createHash('sha256');
      let sizeBytes = 0;
      for await (const chunk of source.chunks) {
        signal.throwIfAborted();
        sizeBytes += chunk.byteLength;
        context.artifactBudget.bytes += chunk.byteLength;
        if (sizeBytes > context.limits.maxArtifactBytes || context.artifactBudget.bytes > context.limits.maxTotalArtifactBytes) {
          throw new AcpInstallationError('limit_exceeded', 'Artifact bytes exceed the configured installation budget.');
        }
        hash.update(chunk);
        await writeAll(destination, chunk);
      }
      signal.throwIfAborted();
      await source.verify(sizeBytes);
      const measuredSha256 = `sha256:${hash.digest('hex')}`;
      if (expectedSha256 !== undefined && measuredSha256 !== expectedSha256
        || local?.sha256 !== undefined && measuredSha256 !== local.sha256) {
        throw new AcpInstallationError('integrity_mismatch', 'The acquired artifact does not match its expected SHA-256 digest.');
      }
      await destination.sync();
      return Object.freeze({ path, sourceUrl: url, origin: local ? 'local' : 'network', measuredSha256, sizeBytes,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
        ...(source.finalUrl === undefined ? {} : { finalUrl: source.finalUrl }) });
    } finally {
      await source.close();
    }
  } catch (error) {
    if (destination) { await destination.close(); destination = undefined; }
    await rm(directory, { recursive: true, force: true });
    if (signal.aborted) throw signal.reason instanceof AcpInstallationError ? signal.reason : new AcpInstallationError('aborted', 'Artifact acquisition was canceled.', { cause: signal.reason });
    if (error instanceof AcpInstallationError) throw error;
    throw new AcpInstallationError('io_failure', 'Artifact acquisition failed.', { cause: error });
  } finally {
    clearTimeout(timeout);
    if (destination) await destination.close();
  }
}

interface ArtifactSource {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly finalUrl?: string;
  verify(sizeBytes: number): Promise<void>;
  close(): Promise<void>;
}

async function localSource(path: string, context: AcpInstallPreparationContext, signal: AbortSignal): Promise<ArtifactSource> {
  if (!isAbsolute(path) || path.includes('\0')) throw new AcpInstallationError('invalid_input', 'Local artifact paths must be explicit absolute paths.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new AcpInstallationError('invalid_input', 'A local artifact must be a regular file.');
    if (before.size > context.limits.maxArtifactBytes) throw new AcpInstallationError('limit_exceeded', 'The local artifact exceeds the compressed byte limit.');
    const stream = handle.createReadStream({ autoClose: false, signal });
    return {
      chunks: stream,
      async verify(sizeBytes) {
        const after = await handle.stat();
        if (sizeBytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
          throw new AcpInstallationError('artifact_unavailable', 'The caller-supplied artifact changed while it was copied.');
        }
      },
      async close() { stream.destroy(); await handle.close(); },
    };
  } catch (error) { await handle.close(); throw error; }
}

async function networkSource(url: string, context: AcpInstallPreparationContext, signal: AbortSignal): Promise<ArtifactSource> {
  const policy: RegistryFetchPolicy = {
    trustedOrigins: new Set(context.plan.policy.allowedOrigins), allowInsecureHttp: context.plan.policy.allowInsecureHttp,
    maxRedirects: context.limits.maxDownloadRedirects, timeoutMs: context.limits.artifactTimeoutMs,
  };
  let current = new URL(url);
  for (let redirects = 0; ; redirects += 1) {
    try { assertFetchUrl(current, policy); }
    catch (error) { throw new AcpInstallationError('policy_denied', 'The artifact origin or transport is not allowed by the installation plan.', { cause: error }); }
    const response = await fetch(current, { method: 'GET', redirect: 'manual', signal, credentials: 'omit', headers: { accept: 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects >= policy.maxRedirects) throw new AcpInstallationError('limit_exceeded', 'The artifact redirect limit was exceeded.');
      try { current = redirectUrl(response.headers.get('location'), current); }
      catch (error) { throw new AcpInstallationError('artifact_unavailable', 'The artifact server returned an invalid redirect.', { cause: error }); }
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new AcpInstallationError('artifact_unavailable', `The artifact server returned HTTP ${response.status}.`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > context.limits.maxArtifactBytes)) {
      await response.body.cancel();
      throw new AcpInstallationError('limit_exceeded', 'The artifact response declares an invalid or excessive byte length.');
    }
    const reader = response.body.getReader();
    return {
      finalUrl: current.href,
      chunks: { async *[Symbol.asyncIterator]() {
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) return; yield chunk.value; } }
        finally { await reader.cancel(); }
      } },
      async verify() {},
      async close() { await reader.cancel(); reader.releaseLock(); },
    };
  }
}

function assertSourceUrl(input: string): void {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new AcpInstallationError('invalid_input', 'Artifact sources must be absolute HTTP or HTTPS URLs.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || input.length > 8_192 || /[\p{Cc}\p{Cf}\\]/u.test(input)) {
    throw new AcpInstallationError('invalid_input', 'Artifact sources require bounded HTTP or HTTPS URLs without credentials or fragments.');
  }
}

async function assertWorkRoot(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new AcpInstallationError('invalid_input', 'Artifact staging requires an absolute owned work directory.');
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AcpInstallationError('store_invalid', 'Artifact staging must be an owned directory.');
}

export async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (written.bytesWritten === 0) throw new AcpInstallationError('io_failure', 'The artifact write made no progress.');
    offset += written.bytesWritten;
  }
}
