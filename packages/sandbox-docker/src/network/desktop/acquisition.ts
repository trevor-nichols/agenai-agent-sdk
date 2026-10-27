// ------------------------------------------------------------------------------------------------
//                acquisition.ts - Physical Desktop authority and finite owned-topology lease acquisition
// ------------------------------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxOperationError, SandboxStateError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { DockerApi } from '../../resources/api.js';
import type { DockerDesktopEngineSocketIdentity, DockerDesktopRouteAuthorityBinding } from '../routeAuthority.js';
import { deniedCoverage } from '../policy.js';
import type { DesktopVmObserverClient } from './client.js';
import type { DesktopHostAuthorityObservation } from './observation/host.js';
import type { DesktopVmObservation } from './observation/vm.js';
import { readDesktopEngineNetworks } from './observation/engine.js';
import type { DesktopEngineNetworkCensus } from './observation/engine.js';
import { desktopOwnedLinkLocalSettled, externalEngineAuthority, externalVmAuthority, identifyDesktopOwnedBridge,
  NO_DESKTOP_NONE_MEMBERS, requireSameAuthority, validateDesktopBridgeEvolution, validateDesktopBrokerReceipt,
  validateDesktopOwnedVm } from './topology.js';
import type { DesktopOwnedBridge, DesktopOwnedBridgeReceipt, DesktopOwnedNoneMembers, DesktopStartedTopologyReceipt } from './topology.js';

export interface DesktopRoutePreflight { readonly host: DesktopHostAuthorityObservation; readonly socket: DockerDesktopEngineSocketIdentity }
export interface DesktopRouteCensus {
  readonly hostname: string; readonly kernel: string; readonly excludedCidrs: readonly string[];
  readonly host: DesktopHostAuthorityObservation; readonly vm: DesktopVmObservation; readonly engine: DesktopEngineNetworkCensus;
}
export interface DesktopRouteLease {
  readonly census: DesktopRouteCensus;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface DesktopBridgeAuthority {
  readonly census: DesktopRouteCensus;
  assertCurrent(signal?: AbortSignal): Promise<void>;
  seal(receipt: DesktopStartedTopologyReceipt, signal?: AbortSignal): Promise<DesktopRouteLease>;
  close(): Promise<void>;
}
export interface DesktopPreBridgeAuthority {
  admitBridge(receipt: DesktopOwnedBridgeReceipt, members: DesktopOwnedNoneMembers, signal?: AbortSignal): Promise<DesktopBridgeAuthority>;
  close(): Promise<void>;
}

export async function preflightDesktopRouteAuthority(binding: DockerDesktopRouteAuthorityBinding, signal?: AbortSignal): Promise<DesktopRoutePreflight> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new SandboxUnsupportedError('Desktop route authority requires a native Darwin arm64 controller.');
  const socket = await binding.observeEngineSocket(signal);
  const host = await binding.observeHost(signal);
  requireSameAuthority(await binding.observeEngineSocket(signal), socket, 'Desktop Engine socket changed during host preflight.');
  return Object.freeze({ host, socket });
}

interface Snapshot {
  readonly host: DesktopHostAuthorityObservation; readonly vm: DesktopVmObservation; readonly engine: DesktopEngineNetworkCensus;
  readonly census: DesktopRouteCensus;
}

export async function captureDesktopRouteAcquisition(options: {
  readonly api: DockerApi;
  readonly binding: DockerDesktopRouteAuthorityBinding;
  readonly observer: DesktopVmObserverClient;
  readonly hostPreflight: DesktopRoutePreflight;
  readonly ownedObserverId: string;
}, signal?: AbortSignal): Promise<DesktopPreBridgeAuthority> {
  const { api, binding, observer, hostPreflight, ownedObserverId } = options;
  const cancellation = new AbortController();
  let phase: 'baseline' | 'bridge' | 'sealed' | 'closed' = 'baseline';
  let active: Promise<unknown> | undefined;
  const close = async () => {
    phase = 'closed'; cancellation.abort();
    await active?.catch(() => {});
  };
  const run = async <Value>(expected: 'baseline' | 'bridge' | 'sealed', operationSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<Value>): Promise<Value> => {
    if (phase !== expected) throw new SandboxStateError('Desktop route acquisition stage is no longer active.');
    if (active) throw new SandboxStateError('A Desktop authority observation is already entered.');
    const combined = operationSignal ? AbortSignal.any([operationSignal, cancellation.signal]) : cancellation.signal;
    combined.throwIfAborted();
    const entered = operation(combined);
    active = entered;
    try {
      const value = await entered;
      combined.throwIfAborted();
      return value;
    }
    catch (cause) { phase = 'closed'; cancellation.abort(); throw cause; }
    finally { if (active === entered) active = undefined; }
  };
  const capture = async (operationSignal: AbortSignal,
    ownedTransition?: (before: DesktopVmObservation, after: DesktopVmObservation) => void): Promise<Snapshot> => {
    operationSignal.throwIfAborted();
    requireSameAuthority(await binding.observeEngineSocket(operationSignal), hostPreflight.socket, 'Desktop Engine socket authority changed.');
    const host = await binding.observeHost(operationSignal);
    requireSameAuthority(host.executableIdentity, hostPreflight.host.executableIdentity, 'Desktop host observer executable identity changed.');
    requireSameAuthority(host.fingerprint, hostPreflight.host.fingerprint, 'Desktop host route/interface/proxy authority changed.');
    const vm = await observer.observe(operationSignal);
    const engine = await readDesktopEngineNetworks(api, operationSignal);
    const afterVm = await observer.observe(operationSignal);
    const afterHost = await binding.observeHost(operationSignal);
    requireSameAuthority(afterHost.executableIdentity, host.executableIdentity, 'Desktop host observer executable changed during acquisition.');
    requireSameAuthority(afterHost.fingerprint, host.fingerprint, 'Desktop host authority changed during complete acquisition.');
    requireSameAuthority(await binding.observeEngineSocket(operationSignal), hostPreflight.socket, 'Desktop Engine socket changed during acquisition.');
    if (engine.id !== binding.identity.engine.id || engine.kernel !== vm.snapshot.kernel) {
      throw new SandboxUnsupportedError('Desktop Engine identity or VM kernel differs from the selected authority.');
    }
    if (ownedTransition) ownedTransition(vm, afterVm);
    else requireSameAuthority(afterVm.snapshot, vm.snapshot, 'Desktop VM authority did not settle within complete acquisition.');
    const excludedCidrs = deniedCoverage([...host.excludedCidrs, ...afterVm.excludedCidrs, ...engine.excludedCidrs,
      binding.identity.deployment.dockerSubnet, '::/0']);
    return Object.freeze({ host, vm: afterVm, engine, census: Object.freeze({ hostname: engine.hostname, kernel: engine.kernel,
      excludedCidrs, host, vm: afterVm, engine }) });
  };
  const baseline = await run('baseline', signal, capture);
  const baselineEngine = externalEngineAuthority(baseline.engine, ownedObserverId, NO_DESKTOP_NONE_MEMBERS);
  const baselineVm = externalVmAuthority(baseline.vm, []);
  const assertExternal = (snapshot: Snapshot, members: DesktopOwnedNoneMembers, owned: DesktopOwnedBridge,
    indexes: readonly number[]) => {
    requireSameAuthority(externalEngineAuthority(snapshot.engine, ownedObserverId, members, owned.receipt.networkId), baselineEngine,
      'External Desktop Engine network configuration or membership changed.');
    requireSameAuthority(externalVmAuthority(snapshot.vm, indexes), baselineVm, 'External VM interfaces, routes, defaults or namespace changed.');
  };
  return Object.freeze({ close, admitBridge(receipt: DesktopOwnedBridgeReceipt, members: DesktopOwnedNoneMembers, operationSignal?: AbortSignal) {
    return run('baseline', operationSignal, async (enteredSignal) => {
      if (baseline.engine.networks.some((network) => network.Id === receipt.networkId || network.Name === receipt.name)
        || baseline.vm.snapshot.interfaces.some((device) => device.name === receipt.bridgeName)) {
        throw new SandboxOperationError('driver_failure', 'Owned bridge receipt collides with baseline authority.');
      }
      const snapshot = await capture(enteredSignal);
      const owned = identifyDesktopOwnedBridge(receipt, snapshot.engine, snapshot.vm);
      if (Object.keys(owned.network.Containers).length !== 0) throw new SandboxOperationError('driver_failure', 'Owned bridge gained an endpoint before broker admission.');
      if (baseline.vm.snapshot.interfaces.some((device) => device.index === owned.device.index)) throw new SandboxOperationError('driver_failure', 'Owned bridge reused an external interface identity.');
      validateDesktopOwnedVm(snapshot.vm, owned, false);
      assertExternal(snapshot, members, owned, [owned.device.index]);
      enteredSignal.throwIfAborted(); phase = 'bridge';
      const locked = snapshot.census.excludedCidrs;
      const assertBridgeCurrent = (next: Snapshot) => {
        requireSameAuthority(next.census.excludedCidrs, locked, 'Desktop bridge authority coverage changed before broker startup.');
        requireSameAuthority(next.vm.snapshot, snapshot.vm.snapshot, 'Desktop VM authority changed before broker startup.');
        requireSameAuthority(next.engine, snapshot.engine, 'Desktop Engine authority changed before broker startup.');
      };
      return Object.freeze({ census: snapshot.census, close,
        assertCurrent(currentSignal?: AbortSignal) { return run('bridge', currentSignal, async (current) => { assertBridgeCurrent(await capture(current)); }); },
        seal(receipt: DesktopStartedTopologyReceipt, sealSignal?: AbortSignal) {
          return run('bridge', sealSignal, async (current) => {
            const deadline = performance.now() + binding.identity.commandTimeoutMs;
            let previous: Snapshot | undefined;
            let sealed: Snapshot;
            while (true) {
              const candidate = await capture(current, (before, after) => {
                for (const observation of [before, after]) {
                  const devices = validateDesktopOwnedVm(observation, owned, true);
                  validateDesktopBridgeEvolution(owned.device, devices[0], devices[1]);
                  requireSameAuthority(externalVmAuthority(observation, devices.map((device) => device.index)), baselineVm,
                    'External VM authority changed during the finite owned link-local transition.');
                }
              });
              const devices = validateDesktopOwnedVm(candidate.vm, owned, true);
              validateDesktopBridgeEvolution(owned.device, devices[0], devices[1]);
              validateDesktopBrokerReceipt(owned, candidate.engine, receipt);
              assertExternal(candidate, receipt.members, owned, devices.map((device) => device.index));
              requireSameAuthority(candidate.census.excludedCidrs, locked, 'Owned endpoint changed the locked broker exclusion coverage.');
              if (desktopOwnedLinkLocalSettled(devices) && previous
                && previous.vm.fingerprint === candidate.vm.fingerprint) { sealed = candidate; break; }
              if (performance.now() >= deadline) throw new SandboxOperationError('deadline_exceeded', 'Owned Desktop endpoint/link-local transition did not settle.');
              previous = candidate;
              await delay(Math.min(binding.identity.pollIntervalMs, Math.max(1, deadline - performance.now())), undefined, { signal: current });
            }
            current.throwIfAborted(); phase = 'sealed';
            return Object.freeze({ census: sealed.census, close, assertCurrent(currentSignal?: AbortSignal) {
              return run('sealed', currentSignal, async (operation) => {
                const next = await capture(operation);
                requireSameAuthority(next.vm.snapshot, sealed.vm.snapshot, 'Sealed Desktop VM route or interface authority changed.');
                requireSameAuthority(next.engine, sealed.engine, 'Sealed Desktop Engine network authority changed.');
                requireSameAuthority(next.census.excludedCidrs, locked, 'Sealed Desktop exclusion coverage changed.');
              });
            } });
          });
        },
      });
    });
  } });
}
