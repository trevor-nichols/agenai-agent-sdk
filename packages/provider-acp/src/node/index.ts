import type { AgentProviderDriver } from '@agen-ai/agent-runtime';
import { createAcpProviderDriverInternal } from '../driverFactory.js';
import type { CreateNodeAcpProviderDriverOptions } from './contracts.js';
import { resolveNodeAcpLaunch, resolveNodeAcpSessionInteractions } from './launch.js';
import { spawnAcpProcess } from './process.js';
import { executionReservationSource } from './execution/owner.js';

export type { NodeAcpLaunchOptions, CreateNodeAcpProviderDriverOptions } from './contracts.js';
export type { NodeAcpExecutionInput, NodeAcpExecutionBoundary, NodeAcpExecutionReservation } from './execution/types.js';
export { NodeAcpExecutionCleanupError, isNodeAcpExecutionCleanupError } from './execution/errors.js';

/** Uses the supplied inert execution owner, or the default owned POSIX process-group launcher. */
export function createNodeAcpProviderDriver(options: CreateNodeAcpProviderDriverOptions): AgentProviderDriver {
  const launch = resolveNodeAcpLaunch(options.launch);
  const boundary = options.executionBoundary;
  if (boundary === undefined && Object.hasOwn(options, 'executionBoundary')) throw new TypeError('An explicitly supplied execution boundary must be valid.');
  const reserve = boundary === undefined ? undefined : executionReservationSource(boundary, launch);
  const sessionInteractions = resolveNodeAcpSessionInteractions(options, launch);
  if (sessionInteractions && !reserve) throw new TypeError('Selected Grok session mappings require an exclusive descendant-owning execution boundary.');
  return createAcpProviderDriverInternal({
    providerKey: options.providerKey,
    connectionSource: reserve ? { kind: 'reserved', reserve }
      : { kind: 'factory', create: (context) => spawnAcpProcess(launch, context) },
    ...(options.unknownExtensionPolicy !== undefined ? { unknownExtensionPolicy: options.unknownExtensionPolicy } : {}),
    ...(options.permissionMapping !== undefined ? { permissionMapping: options.permissionMapping } : {}),
    ...(options.structuredOutputMapping !== undefined ? { structuredOutputMapping: options.structuredOutputMapping } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.authentication ? { authentication: options.authentication } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.sessionMcpBinding ? { sessionMcpBinding: options.sessionMcpBinding } : {}),
  }, sessionInteractions);
}
