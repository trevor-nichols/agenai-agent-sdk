import { parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { defineAgentProviderDriver, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { parseAcpProviderConfiguration } from './configuration.js';
import type { CreateAcpProviderDriverOptions } from './contracts.js';
import { createAcpProviderInstance } from './instance.js';
import { resolveAcpProviderLimits } from './limits.js';
import { resolveAuthenticationMapping } from './auth/methods.js';
import { resolveHostFacilities } from './host/validation.js';
import { resolveAcpMcpServers, resolveAcpSessionMcpBinding } from './mcp.js';

export function createAcpProviderDriver(options: CreateAcpProviderDriverOptions): AgentProviderDriver {
  const providerKey = parseAgentProviderKey(options.providerKey);
  const createConnection = options.createConnection;
  if (typeof createConnection !== 'function') throw new TypeError('An ACP connection factory is required.');
  const unknownExtensionPolicy = options.unknownExtensionPolicy === undefined ? 'standard' : options.unknownExtensionPolicy;
  if (unknownExtensionPolicy !== 'reject' && unknownExtensionPolicy !== 'standard') throw new TypeError('ACP unknown extension policy is invalid.');
  const limits = resolveAcpProviderLimits(options.limits);
  const configuration = options.configuration ?? 'managed';
  if (configuration !== 'managed' && configuration !== 'selectable') throw new TypeError('ACP configuration mode is invalid.');
  const authentication = resolveAuthenticationMapping(options.authentication);
  const host = resolveHostFacilities(options.host);
  const mcpServers = resolveAcpMcpServers(options.mcpServers);
  const sessionMcpBinding = resolveAcpSessionMcpBinding(options.sessionMcpBinding);
  const usedStreams = new WeakSet<object>();
  return defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: true,
    parseConfiguration: parseAcpProviderConfiguration,
    createInstance: ({ instanceId }) => createAcpProviderInstance({
      providerKey,
      instanceId,
      createConnection,
      unknownExtensionPolicy,
      limits,
      usedStreams,
      configuration,
      authentication,
      host,
      mcpServers,
      ...(sessionMcpBinding ? { sessionMcpBinding } : {}),
    }),
  });
}
