// ------------------------------------------------------------------------------------------------
//                driver.ts - Inert Claude driver factory; materialization acquires every resource
// ------------------------------------------------------------------------------------------------

import { parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { defineAgentProviderDriver, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { openNodeProviderToolOwner, type NodeProviderNativeExecutable } from '@agen-ai/provider-tools/node';
import { CLAUDE_PROVIDER_KEY, type NodeClaudeProviderOptions } from '../index.js';
import { NodeClaudeProviderError } from './errors.js';
import { materializeClaudeInstance } from './instance.js';
import { parseClaudeConfiguration, parseClaudeOptions } from './options.js';
import { resolveClaudeSdk } from './sdk.js';

/** Claude Code 2.1.322 native executables, from the MS001 qualified evidence. */
const CLAUDE_CODE_SHA256 = Object.freeze({
  'linux-x64': 'bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478',
  'linux-arm64': 'f220ca50ea4f3222043ff83cc224a1262e0196e9897acc0871efa94235b0c1fd',
});
const CLAUDE_CODE_MAX_BYTES = 536_870_912;

/**
 * Captures and validates options without touching the filesystem or starting processes. The
 * returned driver materializes at most one live instance; materialization verifies the native
 * executable, containment launcher and SDK tuple and leases the prepared workspace.
 */
export function createNodeClaudeProviderDriver(options: NodeClaudeProviderOptions): AgentProviderDriver {
  const parsed = parseClaudeOptions(options);
  const providerKey = parseAgentProviderKey(CLAUDE_PROVIDER_KEY);
  const native: NodeProviderNativeExecutable = Object.freeze({ path: parsed.executablePath, sha256: CLAUDE_CODE_SHA256, maxBytes: CLAUDE_CODE_MAX_BYTES });
  let live = false;
  return defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: false,
    parseConfiguration: parseClaudeConfiguration,
    async createInstance(input) {
      if (live) throw new NodeClaudeProviderError('session_active', 'This Claude driver already has a materialized instance.');
      live = true;
      try {
        const sdkEntry = await resolveClaudeSdk();
        const owner = await openNodeProviderToolOwner(parsed.tools, native);
        return materializeClaudeInstance({
          providerKey, instanceId: input.instanceId, model: input.configuration.model, options: parsed, sdkEntry, owner,
          onDisposed: () => { live = false; },
        });
      } catch (error) {
        live = false;
        throw error;
      }
    },
  });
}
