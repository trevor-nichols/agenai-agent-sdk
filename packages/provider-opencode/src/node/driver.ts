// ------------------------------------------------------------------------------------------------
//                driver.ts - Inert OpenCode driver factory; materialization acquires every resource
// ------------------------------------------------------------------------------------------------

import { parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { defineAgentProviderDriver, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { openNodeProviderToolOwner, type NodeProviderNativeExecutable } from '@agen-ai/provider-tools/node';
import { OPENCODE_PROVIDER_KEY, type NodeOpenCodeProviderOptions } from '../index.js';
import { NodeOpenCodeProviderError } from './errors.js';
import { materializeOpenCodeInstance } from './instance.js';
import { parseOpenCodeConfiguration, parseOpenCodeOptions } from './options.js';

/** OpenCode 2.2.7 native executables, from the MS001 recorded identities. */
const OPENCODE_SHA256 = Object.freeze({
  'linux-x64': '589253d36810f21217edd51545cd435b328cdc3cf4f451fbe0cce6f88afcf5e1',
  'linux-arm64': 'c577783eacf7d1e66661fc7fd904b7646761497b687ff8f8f82ebe4f2f3ea425',
});
const OPENCODE_MAX_BYTES = 536_870_912;

/**
 * Captures and validates options without touching the filesystem or starting processes. The
 * returned driver materializes at most one live instance; materialization verifies the native
 * executable and containment launcher and leases the prepared workspace.
 */
export function createNodeOpenCodeProviderDriver(options: NodeOpenCodeProviderOptions): AgentProviderDriver {
  const parsed = parseOpenCodeOptions(options);
  const providerKey = parseAgentProviderKey(OPENCODE_PROVIDER_KEY);
  const native: NodeProviderNativeExecutable = Object.freeze({ path: parsed.executablePath, sha256: OPENCODE_SHA256, maxBytes: OPENCODE_MAX_BYTES });
  let live = false;
  return defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: false,
    parseConfiguration: parseOpenCodeConfiguration,
    async createInstance(input) {
      if (live) throw new NodeOpenCodeProviderError('session_active', 'This OpenCode driver already has a materialized instance.');
      live = true;
      try {
        const owner = await openNodeProviderToolOwner(parsed.tools, native);
        return materializeOpenCodeInstance({
          providerKey, instanceId: input.instanceId, model: input.configuration.model, options: parsed, owner,
          onDisposed: () => { live = false; },
        });
      } catch (error) {
        live = false;
        throw error;
      }
    },
  });
}
