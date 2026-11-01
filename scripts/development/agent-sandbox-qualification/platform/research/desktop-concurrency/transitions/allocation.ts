import { nativeAddressNumber, prefixMask } from '../../../../../../../packages/ai/sandbox-docker/src/network/address.js';
import { addressAdmission, deniedCoverage } from '../../../../../../../packages/ai/sandbox-docker/src/network/policy.js';

// Research candidate, not production allocation authority. Each slot includes its gateway.
export const PRIVATE_POOL = Object.freeze(Array.from({ length: 16 }, (_, index) => `10.240.0.${index * 16}/28`));

function range(cidr: string) {
  const [address, prefixText, extra] = cidr.split('/');
  const prefix = Number(prefixText);
  if (extra !== undefined || !/^(?:0|[1-9]|[12][0-9]|3[0-2])$/u.test(prefixText ?? '')) throw new TypeError('Invalid allocation prefix.');
  const start = nativeAddressNumber(address, 4);
  const mask = prefixMask(4, prefix);
  if ((start & mask) !== start) throw new TypeError('Allocation has host bits.');
  return { start, end: start | (0xffff_ffffn ^ mask) };
}

export function overlaps(left: string, right: string): boolean {
  const a = range(left); const b = range(right);
  return a.start <= b.end && b.start <= a.end;
}

export function selectAllocation(externalOccupancy: readonly string[], reservations: readonly string[],
  liveBrokerExclusions: readonly (readonly string[])[]): Readonly<{ subnet: string; gateway: string }> {
  const subnet = PRIVATE_POOL.find((candidate) => ![...externalOccupancy, ...reservations].some((occupied) => overlaps(candidate, occupied)));
  if (!subnet) throw new Error('Private allocation capacity exhausted before dispatch.');
  const { start, end } = range(subnet);
  for (const exclusions of liveBrokerExclusions) {
    const admitted = addressAdmission(exclusions);
    // Finite /28 candidate: prove all addresses, including reserved/broadcast, before dispatch.
    for (let address = start; address <= end; address += 1n) {
      const text = [24n, 16n, 8n, 0n].map((shift) => Number(address >> shift & 255n)).join('.');
      if (admitted(text)) throw new Error('Live broker did not already deny the complete allocation.');
    }
    if (JSON.stringify(deniedCoverage([...exclusions, subnet])) !== JSON.stringify(deniedCoverage(exclusions))) {
      throw new Error('Allocation would change immutable denied coverage.');
    }
  }
  const parts = subnet.split('/')[0].split('.');
  parts[3] = String(Number(parts[3]) + 1);
  return Object.freeze({ subnet, gateway: parts.join('.') });
}

export function requireAllocationReadback(expected: Readonly<{ subnet: string; gateway: string }>,
  actual: Readonly<{ subnet: string; gateway: string }>): void {
  if (actual.subnet !== expected.subnet || actual.gateway !== expected.gateway) throw new Error('IPAM readback differs from the pre-effect reservation.');
}
