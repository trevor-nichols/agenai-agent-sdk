import type { AgentProviderDriver } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver } from '../driver.js';
import type { CreateNodeAcpProviderDriverOptions } from './contracts.js';
import { resolveNodeAcpLaunch } from './launch.js';
import { spawnAcpProcess } from './process.js';

export type { NodeAcpLaunchOptions, CreateNodeAcpProviderDriverOptions } from './contracts.js';

/** Launches an owned POSIX process group. Windows hosts must supply an owned connection factory. */
export function createNodeAcpProviderDriver(options: CreateNodeAcpProviderDriverOptions): AgentProviderDriver {
  const launch = resolveNodeAcpLaunch(options.launch);
  return createAcpProviderDriver({
    providerKey: options.providerKey,
    createConnection: (context) => spawnAcpProcess(launch, context),
    ...(options.unknownExtensionPolicy !== undefined ? { unknownExtensionPolicy: options.unknownExtensionPolicy } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.authentication ? { authentication: options.authentication } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.sessionMcpBinding ? { sessionMcpBinding: options.sessionMcpBinding } : {}),
  });
}
