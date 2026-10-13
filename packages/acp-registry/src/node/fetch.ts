import { resolveAcpRegistryLimits } from '../catalog/limits.js';
import { parseAcpRegistrySnapshot } from '../catalog/parse.js';
import { parseAcpRegistrySource } from '../catalog/source.js';
import { AcpRegistryFetchError, type FetchAcpRegistrySnapshotInput, type FetchedAcpRegistrySnapshot } from './contracts.js';
import { assertFetchUrl, redirectUrl, resolveFetchPolicy } from './fetch-policy.js';
import { decodeRegistryContent, readRegistryContent } from './response.js';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/** Fetches inert metadata under explicit origin policy; never installs or launches an agent. */
export async function fetchAcpRegistrySnapshot(input: FetchAcpRegistrySnapshotInput): Promise<FetchedAcpRegistrySnapshot> {
  const signal = input.signal;
  const source = parseAcpRegistrySource(input.source);
  if (source.kind !== 'remote') {
    throw new AcpRegistryFetchError('invalid_fetch_policy', 'Fetching requires an explicitly selected remote registry source.');
  }
  const limits = resolveAcpRegistryLimits(input.limits);
  const policy = resolveFetchPolicy(input);
  let url = new URL(source.location);
  assertFetchUrl(url, policy);
  if (signal?.aborted) throw new AcpRegistryFetchError('aborted', 'Registry fetching was canceled.');

  const controller = new AbortController();
  let timedOut = false;
  const deadline = Date.now() + policy.timeoutMs;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, policy.timeoutMs);
  let bytes: Uint8Array;
  try {
    try {
      for (let redirects = 0; ; redirects += 1) {
        const response = await fetch(url, {
          method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
          headers: { accept: 'application/json' }, signal: controller.signal,
        });
        if (redirectStatuses.has(response.status)) {
          await response.body?.cancel();
          if (redirects >= policy.maxRedirects) {
            throw new AcpRegistryFetchError('redirect_limit', 'The registry exceeded the allowed redirect count.');
          }
          url = redirectUrl(response.headers.get('location'), url);
          assertFetchUrl(url, policy);
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new AcpRegistryFetchError('http_status', 'The registry did not return HTTP 200.', { status: response.status });
        }
        bytes = await readRegistryContent(response, limits.maxSnapshotBytes);
        break;
      }
    } catch (cause) {
      if (timedOut || Date.now() >= deadline) throw new AcpRegistryFetchError('timeout', 'Registry fetching exceeded its deadline.');
      if (controller.signal.aborted) throw new AcpRegistryFetchError('aborted', 'Registry fetching was canceled.');
      if (cause instanceof AcpRegistryFetchError) throw cause;
      throw new AcpRegistryFetchError('network_failure', 'The registry request failed.', { cause });
    }
    const content = decodeRegistryContent(bytes);
    const snapshot = parseAcpRegistrySnapshot({ source, content: bytes, limits });
    if (timedOut || Date.now() >= deadline) throw new AcpRegistryFetchError('timeout', 'Registry fetching exceeded its deadline.');
    if (controller.signal.aborted) throw new AcpRegistryFetchError('aborted', 'Registry fetching was canceled.');
    return Object.freeze({ snapshot, content, finalUrl: url.href, fetchedAt: new Date().toISOString() });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
