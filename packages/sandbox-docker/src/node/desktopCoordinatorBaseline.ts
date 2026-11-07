import { DockerResponseByteBudget } from '../resources/api.js';
import type { DockerApi } from '../resources/api.js';
import type { DockerDesktopRouteAuthorityBinding } from '../network/routeAuthority.js';
import { observationFingerprint, readDesktopEngineIdentity, readDesktopEngineNetworks } from '../network/desktop/observation/engine.js';
import type { DesktopEngineIdentity, DesktopEngineNetworkCensus } from '../network/desktop/observation/engine.js';
import type { DesktopHostAuthorityObservation } from '../network/desktop/observation/host.js';
import { DESKTOP_COORDINATOR_POLICY } from '../network/desktop/coordinator/policy.js';
import { inspectDesktopCoordinatorEndpoint } from './desktopCoordinatorEndpoint.js';
import type { DesktopCoordinatorEndpointBinding } from './desktopCoordinatorEndpoint.js';

export interface DesktopCoordinatorBaseline<Engine extends DesktopEngineIdentity = DesktopEngineNetworkCensus> {
  readonly host: DesktopHostAuthorityObservation;
  readonly engine: Engine;
  readonly hostDigest: string;
  readonly engineDigest: string;
}

type EngineReader<Engine> = (api: DockerApi, signal: AbortSignal, budget: DockerResponseByteBudget) => Promise<Engine>;

async function captureBracketed<Engine extends DesktopEngineIdentity>(api: DockerApi, route: DockerDesktopRouteAuthorityBinding,
  endpoint: DesktopCoordinatorEndpointBinding, readEngine: EngineReader<Engine>): Promise<DesktopCoordinatorBaseline<Engine>> {
  const signal = AbortSignal.timeout(DESKTOP_COORDINATOR_POLICY.observationTimeoutMs);
  const budget = new DockerResponseByteBudget(DESKTOP_COORDINATOR_POLICY.rawBracketBytes);
  if ((await inspectDesktopCoordinatorEndpoint(route.identity.engine.endpoint, signal)).digest !== endpoint.digest) {
    throw new TypeError('Desktop coordinator endpoint changed before the observation.');
  }
  const capture = async () => {
    const host = await route.observeHost(signal, budget);
    const engine = await readEngine(api, signal, budget);
    if (engine.id !== route.identity.engine.id
      || Buffer.byteLength(JSON.stringify({ host, engine })) > DESKTOP_COORDINATOR_POLICY.observationBytes) {
      throw new TypeError('Desktop coordinator observation exceeds its identity or byte contract.');
    }
    return Object.freeze({ host, engine, hostDigest: `sha256:${host.fingerprint}`,
      engineDigest: `sha256:${observationFingerprint(engine)}` });
  };
  const before = await capture().then(({ hostDigest, engineDigest, host }) => ({
    hostDigest, engineDigest, executableIdentity: host.executableIdentity,
  }));
  const after = await capture();
  if (before.hostDigest !== after.hostDigest || before.engineDigest !== after.engineDigest
    || before.executableIdentity !== after.host.executableIdentity
    || (await inspectDesktopCoordinatorEndpoint(route.identity.engine.endpoint, signal)).digest !== endpoint.digest) {
    throw new TypeError('Desktop coordinator authority changed during the complete observation.');
  }
  return after;
}

export function captureDesktopCoordinatorBaseline(
  api: DockerApi, route: DockerDesktopRouteAuthorityBinding, endpoint: DesktopCoordinatorEndpointBinding,
): Promise<DesktopCoordinatorBaseline> {
  return captureBracketed(api, route, endpoint, readDesktopEngineNetworks);
}

/** Owning nothing in the VM, the coordinator verifies host and Engine authority without an Engine network census. */
export function captureDesktopCoordinatorIdentity(
  api: DockerApi, route: DockerDesktopRouteAuthorityBinding, endpoint: DesktopCoordinatorEndpointBinding,
): Promise<DesktopCoordinatorBaseline<DesktopEngineIdentity>> {
  return captureBracketed(api, route, endpoint, readDesktopEngineIdentity);
}
