import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod/v4';
import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { captureDockerRouteAuthority } from '../network/routeAuthority.js';
import type { DockerDesktopRouteAuthorityBinding } from '../network/routeAuthority.js';
import type { DockerDesktopCoordinatorOptions } from '../network/desktop/coordinator/contracts.js';
import { DESKTOP_COORDINATOR_POLICY, DESKTOP_COORDINATOR_PROTOCOL } from '../network/desktop/coordinator/policy.js';
import { desktopSharedAuthorityDigest } from '../policy/coordination.js';

const helperSchema = z.strictObject({
  protocol: z.literal(DESKTOP_COORDINATOR_PROTOCOL),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  executable: z.strictObject({
    path: z.string().refine((value) => value.isWellFormed() && Buffer.byteLength(value) <= 4096 && isAbsolute(value)
      && normalize(value) === value && !value.endsWith('/') && !/\p{Cc}/u.test(value), 'Canonical absolute physical executable path required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});

export interface DesktopCoordinatorConfiguration {
  readonly route: DockerDesktopRouteAuthorityBinding;
  readonly helper: DockerDesktopCoordinatorOptions['helper'];
  readonly sharedDigest: string;
}

function dataObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new TypeError('Desktop coordinator configuration requires plain data objects.');
  }
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !property?.enumerable || !('value' in property)) {
      throw new TypeError('Desktop coordinator configuration rejects unknown fields and accessors.');
    }
    captured[key] = property.value;
  }
  return captured;
}

export function parseDesktopCoordinatorConfiguration(options: DockerDesktopCoordinatorOptions): DesktopCoordinatorConfiguration {
  const input = dataObject(options, ['routeAuthority', 'helper']);
  const route = captureDockerRouteAuthority(input.routeAuthority);
  if (route.kind !== 'local_docker_desktop') throw new TypeError('Desktop coordination requires an original Desktop route authority.');
  const helper = dataObject(input.helper, ['protocol', 'executable', 'sourceDigest']);
  helper.executable = dataObject(helper.executable, ['path', 'sha256']);
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
