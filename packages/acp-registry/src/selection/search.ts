import type { AcpRegistryDistributionKind, AcpRegistryEntry, AcpRegistrySnapshot, AcpRegistryTarget } from '../catalog/contracts.js';
import { validateAcpRegistrySnapshot } from '../catalog/assert.js';
import { invalidRegistry } from '../shared/errors.js';
import { deepFreeze } from '../shared/immutable.js';
import { distributionPreference, registryTarget } from './distribution.js';
import { exactKeys, inputRecord, inputString, plainInput } from './input.js';

export interface SearchAcpRegistryInput {
  readonly query?: string;
  readonly agentIds?: readonly string[];
  readonly distributionKinds?: readonly AcpRegistryDistributionKind[];
  readonly target?: AcpRegistryTarget;
}

export function searchAcpRegistry(snapshot: AcpRegistrySnapshot, input: SearchAcpRegistryInput = {}): readonly AcpRegistryEntry[] {
  snapshot = validateAcpRegistrySnapshot(snapshot);
  const options = inputRecord(plainInput(input), []);
  exactKeys(options, ['query', 'agentIds', 'distributionKinds', 'target'], []);
  const query = options.query === undefined ? '' : typeof options.query === 'string' && options.query.length <= 1_024
    && !/[\p{Cc}\p{Cf}]/u.test(options.query) ? options.query.trim().toLowerCase() : invalidRegistry('acp_registry_search_invalid', ['query'], 'Search query must be a bounded string.');
  const tokens = query.split(/\s+/u).filter(Boolean);
  let ids: Set<string> | undefined;
  if (options.agentIds !== undefined) {
    if (!Array.isArray(options.agentIds) || options.agentIds.length > 1_000) invalidRegistry('acp_registry_search_invalid', ['agentIds'], 'Agent IDs must be a bounded list.');
    ids = new Set(options.agentIds.map((id, index) => inputString(id, ['agentIds', index], 256)));
  }
  const kinds = options.distributionKinds === undefined ? undefined : distributionPreference(options.distributionKinds);
  const target = options.target === undefined ? undefined : registryTarget(options.target);
  const entries = snapshot.entries.filter((entry) => {
    if (ids && !ids.has(entry.id)) return false;
    const haystack = [entry.id, entry.name, entry.description, ...entry.authors].join('\n').toLowerCase();
    if (tokens.some((token) => !haystack.includes(token))) return false;
    return entry.distributions.some((distribution) => (!kinds || kinds.includes(distribution.kind))
      && (!target || distribution.kind !== 'binary' || distribution.target === target));
  }).sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  return deepFreeze(entries);
}
