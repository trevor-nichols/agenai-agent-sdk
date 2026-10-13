import type { AcpRegistryDistribution, AcpRegistryDistributionKind, AcpRegistryEntry, AcpRegistryTarget } from '../catalog/contracts.js';
import { validateAcpRegistryEntry } from '../catalog/assert.js';
import { ACP_REGISTRY_TARGETS } from '../catalog/schemas.js';
import { invalidRegistry } from '../shared/errors.js';
import { exactKeys, inputRecord, plainInput } from './input.js';

const kinds: readonly AcpRegistryDistributionKind[] = ['binary', 'npx', 'uvx'];

export interface SelectAcpRegistryDistributionInput {
  readonly target: AcpRegistryTarget;
  /** Ranked, explicitly permitted choices. A selected but unsafe launch is never skipped. */
  readonly preference: readonly AcpRegistryDistributionKind[];
}

export function registryTarget(value: unknown): AcpRegistryTarget {
  if (!ACP_REGISTRY_TARGETS.includes(value as AcpRegistryTarget)) invalidRegistry('acp_registry_target_unsupported', ['target'], 'Select an exact supported registry target.');
  return value as AcpRegistryTarget;
}

export function distributionPreference(value: unknown): readonly AcpRegistryDistributionKind[] {
  if (!Array.isArray(value) || !value.length || value.length > kinds.length
    || value.some((kind) => !kinds.includes(kind)) || new Set(value).size !== value.length) {
    invalidRegistry('acp_registry_distribution_preference_invalid', ['preference'], 'Distribution preference must be a nonempty unique list of supported kinds.');
  }
  return value as AcpRegistryDistributionKind[];
}

export function selectAcpRegistryDistribution(entry: AcpRegistryEntry, input: SelectAcpRegistryDistributionInput): AcpRegistryDistribution {
  entry = validateAcpRegistryEntry(entry);
  const options = inputRecord(plainInput(input), []);
  exactKeys(options, ['target', 'preference'], []);
  const target = registryTarget(options.target);
  const preference = distributionPreference(options.preference);
  for (const kind of preference) {
    const distribution = entry.distributions.find((candidate) => candidate.kind === kind && (candidate.kind !== 'binary' || candidate.target === target));
    if (!distribution) continue;
    validateDistributionTarget(distribution, target);
    return distribution;
  }
  return invalidRegistry('acp_registry_distribution_not_found', ['target'], 'No explicitly permitted distribution supports the selected target.');
}

export function validateDistributionTarget(distribution: AcpRegistryDistribution, target: AcpRegistryTarget): void {
    if (distribution.kind === 'binary' && target.startsWith('windows-') && /\.(?:cmd|bat)$/i.test(distribution.executable)) {
      invalidRegistry('acp_registry_launch_unsupported', ['distributions'], 'Windows batch launch requires a separately qualified interpreter recipe.');
    }
    if (distribution.kind === 'binary' && target.startsWith('windows-') && distribution.executable.split('/').some((segment) =>
      /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))) {
      invalidRegistry('acp_registry_launch_unsupported', ['distributions'], 'Windows payload paths cannot contain device names or invalid filesystem characters.');
    }
}
