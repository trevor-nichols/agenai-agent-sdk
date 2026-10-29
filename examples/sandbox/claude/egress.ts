// ------------------------------------------------------------------------------------------------
//                egress.ts - Restricted HTTPS relay variables for the contained Claude process
// ------------------------------------------------------------------------------------------------

import type { Sandbox } from '@agen-ai/sandbox';
import type { ClaudeSandboxCredential } from './types.js';

// This package compiles alone, so it keeps its own copy of the shared credential-recipe egress contract.
const RESTRICTED_HTTPS_PROXY = 'http://127.0.0.1:3128';
const LOOPBACK = '127.0.0.1,localhost';
const DESTINATION = 'api.anthropic.com:443';

/** Restricted HTTPS must admit the Anthropic API; native Claude Code is then pointed at the Docker relay. */
export function claudeEgress(sandbox: Sandbox, route: ClaudeSandboxCredential['kind']): Readonly<Record<string, string>> {
  const network = sandbox.effective.network;
  if (network.kind !== 'restricted_https') return Object.freeze({});
  if (!network.destinations.some(({ hostname, port }) => `${hostname}:${port}` === DESTINATION)) {
    throw new TypeError('The sandbox restricted HTTPS policy does not admit the Anthropic API.');
  }
  if (route === 'auth_json' && !network.destinations.some(({ hostname, port }) => hostname === 'platform.claude.com' && port === 443)) {
    throw new TypeError('The sandbox restricted HTTPS policy does not admit Claude account refresh.');
  }
  return Object.freeze({
    HTTPS_PROXY: RESTRICTED_HTTPS_PROXY, HTTP_PROXY: RESTRICTED_HTTPS_PROXY, NO_PROXY: LOOPBACK,
    https_proxy: RESTRICTED_HTTPS_PROXY, http_proxy: RESTRICTED_HTTPS_PROXY, no_proxy: LOOPBACK,
  });
}
