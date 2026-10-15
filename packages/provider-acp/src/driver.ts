import type { AgentProviderDriver } from '@agen-ai/agent-runtime';
import type { CreateAcpProviderDriverOptions } from './contracts.js';
import { createAcpProviderDriverInternal } from './driverFactory.js';

export function createAcpProviderDriver(options: CreateAcpProviderDriverOptions): AgentProviderDriver {
  if (Object.hasOwn(options, 'sessionInteractions')) {
    throw new TypeError('ACP session interaction mappings require the Node provider constructor and its exclusive process ownership.');
  }
  if (Object.hasOwn(options, 'executionBoundary')) throw new TypeError('Execution boundaries require the Node provider constructor.');
  return createAcpProviderDriverInternal({ ...options, connectionSource: { kind: 'factory', create: options.createConnection } });
}
