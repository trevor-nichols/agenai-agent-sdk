import type { Sandbox } from '@agen-ai/sandbox';

/** The Docker backend's restricted-HTTPS relay; the SDK never redirects native sockets on its own. */
const RESTRICTED_HTTPS_PROXY = 'http://127.0.0.1:3128';
// Local loopback stays direct: some natives (OpenCode) talk HTTP to their own private local server.
const LOOPBACK = '127.0.0.1,localhost';

/**
 * Native egress variables for the borrowed sandbox's effective network. Restricted HTTPS must admit every
 * destination the recipe declares, then native clients are pointed at the relay explicitly; other modes add nothing.
 */
export function sandboxNativeEgress(sandbox: Sandbox, declared: readonly string[]): Readonly<Record<string, string>> {
  const network = sandbox.effective.network;
  if (network.kind !== 'restricted_https') return Object.freeze({});
  const admitted = new Set(network.destinations.map(({ hostname, port }) => `${hostname}:${port}`));
  for (const destination of declared) {
    const url = new URL(destination);
    if (url.protocol !== 'https:' || !admitted.has(`${url.hostname}:${url.port || '443'}`)) {
      throw new TypeError('The sandbox restricted HTTPS policy does not admit every destination this recipe declares.');
    }
  }
  return Object.freeze({
    HTTPS_PROXY: RESTRICTED_HTTPS_PROXY, HTTP_PROXY: RESTRICTED_HTTPS_PROXY, NO_PROXY: LOOPBACK,
    https_proxy: RESTRICTED_HTTPS_PROXY, http_proxy: RESTRICTED_HTTPS_PROXY, no_proxy: LOOPBACK,
  });
}
