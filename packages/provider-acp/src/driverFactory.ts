import { parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { defineAgentProviderDriver, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { parseAcpProviderConfiguration } from './configuration.js';
import type { CreateAcpProviderDriverOptions } from './contracts.js';
import { createAcpProviderInstance } from './instance.js';
import type { AcpSessionInteractionSelection } from './sessionInteractions/contracts.js';
import { resolveAcpProviderLimits } from './limits.js';
import { resolveAuthenticationMapping } from './auth/methods.js';
import { resolveHostFacilities } from './host/validation.js';
import { resolveAcpMcpServers, resolveAcpSessionMcpBinding } from './mcp.js';
import type { AcpConnectionSource } from './connection/contracts.js';
import { resolveAcpPermissionMapping } from './permissions/selection.js';
import { resolveAcpStructuredOutputMapping } from './structuredOutput/mapping.js';
import { controlledGrokError, type ResolvedNodeAcpProtocolDialect } from './node/protocolDialect.js';

export function createAcpProviderDriverInternal(
  options: Omit<CreateAcpProviderDriverOptions, 'createConnection'> & Readonly<{ connectionSource: AcpConnectionSource }>,
  sessionInteractions?: AcpSessionInteractionSelection,
  protocolDialect?: ResolvedNodeAcpProtocolDialect,
): AgentProviderDriver {
  const providerKey = parseAgentProviderKey(options.providerKey);
  const connectionSource = options.connectionSource;
  if (connectionSource.kind === 'factory' && typeof connectionSource.create !== 'function') throw new TypeError('An ACP connection factory is required.');
  const unknownExtensionPolicy = options.unknownExtensionPolicy === undefined ? 'standard' : options.unknownExtensionPolicy;
  if (unknownExtensionPolicy !== 'reject' && unknownExtensionPolicy !== 'standard') throw new TypeError('ACP unknown extension policy is invalid.');
  const limits = resolveAcpProviderLimits(options.limits);
  const configuration = options.configuration ?? 'managed';
  if (configuration !== 'managed' && configuration !== 'selectable') throw new TypeError('ACP configuration mode is invalid.');
  const authentication = resolveAuthenticationMapping(options.authentication);
  const host = resolveHostFacilities(options.host);
  const mcpServers = resolveAcpMcpServers(options.mcpServers);
  const sessionMcpBinding = resolveAcpSessionMcpBinding(options.sessionMcpBinding);
  const permissionMapping = resolveAcpPermissionMapping(options.permissionMapping);
  const structuredOutputMapping = resolveAcpStructuredOutputMapping(options.structuredOutputMapping);
  const usedStreams = new WeakSet<object>();
  let materialized = false;
  return defineAgentProviderDriver({
    providerKey,
    supportsMultipleInstances: protocolDialect === undefined,
    parseConfiguration: parseAcpProviderConfiguration,
    createInstance: ({ instanceId }) => {
      if (protocolDialect) {
        if (instanceId !== protocolDialect.instanceId || materialized) throw controlledGrokError(providerKey,
          'approval_policy_unavailable', 'The controlled Grok dialect admits only its original instance once.');
        materialized = true;
      }
      return createAcpProviderInstance({
        providerKey,
        instanceId,
        connectionSource,
        unknownExtensionPolicy,
        limits,
        usedStreams,
        configuration,
        authentication,
        host,
        mcpServers,
        permissionMapping,
        ...(structuredOutputMapping ? { structuredOutputMapping } : {}),
        ...(sessionMcpBinding ? { sessionMcpBinding } : {}),
        ...(sessionInteractions ? { sessionInteractions } : {}),
        ...(protocolDialect ? { protocolDialect } : {}),
      });
    },
  });
}
