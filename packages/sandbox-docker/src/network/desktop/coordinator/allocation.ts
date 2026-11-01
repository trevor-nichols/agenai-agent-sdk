import { SandboxOperationError } from '@agen-ai/sandbox';
import { nativeAddressNumber, formatNumericAddress, prefixMask } from '../../address.js';
import { addressAdmission, deniedCoverage } from '../../policy.js';
import type { DesktopHostObservation } from '../observation/host.js';
import type { DesktopEngineNetworkCensus } from '../observation/engine.js';
import type { DesktopVmObservation } from '../observation/vm.js';

export interface DesktopAllocation {
  readonly slot: number;
  readonly subnet: string;
  readonly gateway: string;
}

export interface DesktopAllocationObservation {
  readonly host: DesktopHostObservation;
  readonly engine: DesktopEngineNetworkCensus;
  readonly vm?: DesktopVmObservation;
}

interface Range { readonly start: bigint; readonly end: bigint }

function range(address: string, prefix: number): Range {
  const mask = prefixMask(4, prefix);
  const start = nativeAddressNumber(address, 4) & mask;
  return { start, end: start | (0xffff_ffffn ^ mask) };
}

function maskPrefix(netmask: string): number {
  const mask = nativeAddressNumber(netmask, 4);
  for (let prefix = 0; prefix <= 32; prefix += 1) if (prefixMask(4, prefix) === mask) return prefix;
  throw new TypeError('Allocation occupancy requires a contiguous IPv4 netmask.');
}

function slotAllocation(slot: number): DesktopAllocation {
  if (!Number.isInteger(slot) || slot < 0 || slot >= 16) throw new TypeError('Invalid Desktop subnet slot.');
  return Object.freeze({ slot, subnet: `10.240.0.${slot * 16}/28`, gateway: `10.240.0.${slot * 16 + 1}` });
}

function occupancy(observation: DesktopAllocationObservation): readonly Range[] {
  const result: Range[] = [];
  const add = (address: string, prefix: number) => { result.push(range(address, prefix)); };
  const hostAddress = (address: string | null | undefined) => { if (address && !address.includes(':')) add(address, 32); };
  for (const device of observation.host.snapshot.interfaces) for (const address of device.addresses) {
    if (address.family !== 4) continue;
    add(address.address, maskPrefix(address.netmask));
    hostAddress(address.peer?.address); hostAddress(address.broadcast?.address);
  }
  for (const route of observation.host.snapshot.routes) {
    if (route.family === 4) {
      const prefix = maskPrefix(route.netmask);
      if (prefix > 0) add(route.destination, prefix);
    }
    if (route.gateway?.kind === 'ip' && route.gateway.family === 4) add(route.gateway.address, 32);
  }
  for (const network of observation.engine.networks) {
    for (const allocation of network.IPAM.Config ?? []) {
      for (const cidr of [allocation.Subnet, allocation.IPRange]) {
        if (!cidr || cidr.includes(':')) continue;
        const [address, prefix] = cidr.split('/');
        add(address, Number(prefix));
      }
      hostAddress(allocation.Gateway);
      for (const address of Object.values(allocation.AuxiliaryAddresses ?? {})) hostAddress(address);
    }
    for (const endpoint of Object.values(network.Containers)) {
      if (endpoint.IPv4Address) hostAddress(endpoint.IPv4Address.split('/')[0]);
    }
  }
  for (const device of observation.vm?.snapshot.interfaces ?? []) for (const address of device.addresses) {
    if (address.family === 4) add(address.address, address.prefix);
    hostAddress(address.peer); hostAddress(address.broadcast); hostAddress(address.anycast);
  }
  for (const route of observation.vm?.snapshot.routes ?? []) {
    if (route.family === 4) {
      if (route.prefix > 0) add(route.destination, route.prefix);
      if (route.source !== null) add(route.source, route.sourcePrefix || 32);
    }
    hostAddress(route.preferredSource);
    for (const gateway of route.gateways) hostAddress(gateway);
    for (const next of route.nextHops) for (const gateway of next.gateways) hostAddress(gateway);
  }
  return result;
}

export function requireDesktopAllocationDenied(allocation: DesktopAllocation, liveBrokerExclusions: readonly (readonly string[])[]): void {
  const candidate = range(allocation.subnet.split('/')[0], 28);
  for (const exclusions of liveBrokerExclusions) {
    const admit = addressAdmission(exclusions);
    for (let address = candidate.start; address <= candidate.end; address += 1n) {
      if (admit(formatNumericAddress(address, 4))) throw new SandboxOperationError('driver_failure', 'Desktop allocation is outside a live broker denial policy.');
    }
    if (JSON.stringify(deniedCoverage([...exclusions, allocation.subnet])) !== JSON.stringify(deniedCoverage(exclusions))) {
      throw new SandboxOperationError('driver_failure', 'Desktop allocation would change immutable broker coverage.');
    }
  }
}

export function selectDesktopAllocation(input: DesktopAllocationObservation & Readonly<{
  occupiedSlots: readonly number[];
  liveBrokerExclusions: readonly (readonly string[])[];
}>): DesktopAllocation {
  const occupied = new Set(input.occupiedSlots);
  if (occupied.size !== input.occupiedSlots.length) throw new TypeError('Desktop allocation slots must be unique.');
  for (const slot of occupied) slotAllocation(slot);
  const ranges = occupancy(input);
  for (let slot = 0; slot < 16; slot += 1) {
    if (occupied.has(slot)) continue;
    const allocation = slotAllocation(slot);
    const candidate = range(allocation.subnet.split('/')[0], 28);
    if (ranges.some((entry) => entry.start <= candidate.end && candidate.start <= entry.end)) continue;
    requireDesktopAllocationDenied(allocation, input.liveBrokerExclusions);
    return allocation;
  }
  throw new SandboxOperationError('driver_failure', 'Desktop private subnet capacity is exhausted.');
}

export function requireDesktopAllocationReadback(expected: DesktopAllocation, actual: Readonly<{ subnet: string; gateway: string }>): void {
  const canonical = slotAllocation(expected.slot);
  if (expected.subnet !== canonical.subnet || expected.gateway !== canonical.gateway
    || actual.subnet !== expected.subnet || actual.gateway !== expected.gateway) {
    throw new SandboxOperationError('driver_failure', 'Desktop IPAM differs from its original reserved subnet and gateway.');
  }
}

export function requireDesktopAllocationAvailable(allocation: DesktopAllocation, observation: DesktopAllocationObservation,
  occupiedSlots: readonly number[]): void {
  requireDesktopAllocationReadback(allocation, allocation);
  const candidate = range(allocation.subnet.split('/')[0], 28);
  if (occupiedSlots.includes(allocation.slot) || occupancy(observation).some((entry) => entry.start <= candidate.end && candidate.start <= entry.end)) {
    throw new SandboxOperationError('driver_failure', 'Original Desktop subnet reservation collides with decoded current topology.');
  }
}
