import type { AgentHistory, AgentHistoryDriver, AgentHistoryMutationOperation, AgentHistorySource } from '../contracts/index.js';
import { parseAgentHistorySource } from '../validation/parse.js';
import { HistoryManagementSelectionSchema } from '../validation/operations.js';
import { AgentHistoryError } from './errors.js';
import { parseAgentHistoryLimits, type AgentHistoryLimits } from './limits.js';
import { mutationPorts } from './mutations.js';
import { HistoryOwner } from './owner.js';
import { readPorts } from './reads.js';

export interface CreateAgentHistoryOptions {
  readonly source: AgentHistorySource;
  readonly driver: AgentHistoryDriver;
  readonly limits?: Partial<AgentHistoryLimits>;
  readonly management?: readonly AgentHistoryMutationOperation[];
}

export function createAgentHistory(options: CreateAgentHistoryOptions): AgentHistory {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !['source', 'driver', 'limits', 'management'].includes(key))) {
    throw new AgentHistoryError('invalid_input', 'Invalid history construction options.');
  }
  const source = parseAgentHistorySource(options.source);
  const limits = parseAgentHistoryLimits(options.limits);
  const selection = HistoryManagementSelectionSchema.safeParse(options.management ?? []);
  if (!selection.success) {
    throw new AgentHistoryError('invalid_input', 'History management must select individual operations.');
  }
  const enabled = selection.data;
  const driver = options.driver;
  if (!driver || typeof driver !== 'object') throw new AgentHistoryError('invalid_input', 'A history driver is required.');
  for (const name of ['catalog', 'lookup', 'transcript', 'views', 'metadataSearch', 'contentSearch', 'rename', 'archive', 'restore', 'delete'] as const) {
    if (!driver[name] || !['supported', 'unsupported'].includes(driver[name].status)) {
      throw new AgentHistoryError('invalid_input', 'Each history operation must explicitly declare support.');
    }
  }
  if ((source.resourceOwnership === 'owned' && typeof driver.dispose !== 'function')
    || (source.resourceOwnership === 'borrowed' && driver.dispose !== undefined)) {
    throw new AgentHistoryError('invalid_input', 'History disposal must match the declared native resource ownership.');
  }
  const dispose = driver.dispose?.bind(driver) ?? (() => Promise.resolve());
  const owner = new HistoryOwner({ ...limits, dispose });
  return Object.freeze({ source, ...readPorts(source, driver, owner, limits), ...mutationPorts(source, driver, owner, enabled), close: () => owner.close() });
}
