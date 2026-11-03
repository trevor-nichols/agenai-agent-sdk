import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { captureDockerRouteAuthority } from '../network/routeAuthority.js';
import type { DockerDesktopRouteAuthorityBinding } from '../network/routeAuthority.js';
import type { DockerDesktopCoordinatorOptions } from '../network/desktop/coordinator/contracts.js';
import { DESKTOP_COORDINATOR_POLICY, DESKTOP_COORDINATOR_PROTOCOL } from '../network/desktop/coordinator/policy.js';
import { desktopSharedAuthorityDigest } from '../policy/coordination.js';
import { captureDataFields, preparedHelperSchema } from './preparedHelperOptions.js';

const helperSchema = preparedHelperSchema(DESKTOP_COORDINATOR_PROTOCOL);

export interface DesktopCoordinatorConfiguration {
  readonly route: DockerDesktopRouteAuthorityBinding;
  readonly helper: DockerDesktopCoordinatorOptions['helper'];
  readonly sharedDigest: string;
}

export function parseDesktopCoordinatorConfiguration(options: unknown): DesktopCoordinatorConfiguration {
  const context = 'Desktop coordinator configuration';
  const input = captureDataFields(options, ['routeAuthority', 'helper'], context);
  const route = captureDockerRouteAuthority(input.routeAuthority);
  if (route.kind !== 'local_docker_desktop') throw new TypeError('Desktop coordination requires an original Desktop route authority.');
  const helper = captureDataFields(input.helper, ['protocol', 'executable', 'sourceDigest'], context);
  helper.executable = captureDataFields(helper.executable, ['path', 'sha256'], context);
  const parsed = helperSchema.safeParse(helper);
  if (!parsed.success) throw new SandboxValidationError(normalizeZodValidationError(helperSchema, parsed.error, helper));
  const { identity } = route;
  if (identity.pollIntervalMs !== DESKTOP_COORDINATOR_POLICY.pollIntervalMs
    || identity.commandTimeoutMs !== DESKTOP_COORDINATOR_POLICY.commandTimeoutMs
    || identity.vmObserver.control.heartbeatMs !== DESKTOP_COORDINATOR_POLICY.heartbeatMs
    || identity.vmObserver.control.leaseTimeoutMs !== DESKTOP_COORDINATOR_POLICY.leaseTimeoutMs) {
    throw new TypeError('Desktop coordination requires its fixed observation and control timing composition.');
  }
  return Object.freeze({ route, helper: Object.freeze({ ...parsed.data, executable: Object.freeze(parsed.data.executable) }),
    sharedDigest: desktopSharedAuthorityDigest(identity) });
}
