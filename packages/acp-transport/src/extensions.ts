// ------------------------------------------------------------------------------------------------
//                extensions.ts - Exact ACP extension registration - Dependencies: errors
// ------------------------------------------------------------------------------------------------

import { AcpProtocolError } from './errors.js';

export type AcpExtensionDirection =
  | 'outbound_request'
  | 'outbound_notification'
  | 'inbound_request'
  | 'inbound_notification';

export type AcpExtensionValidator = (value: unknown) => boolean;

export interface AcpExtensionDefinition {
  readonly method: string;
  readonly direction: AcpExtensionDirection;
  readonly validateParams: AcpExtensionValidator;
  readonly validateResult?: AcpExtensionValidator;
  readonly safelyIgnorable?: boolean;
}

export interface AcpExtensionRegistry {
  readonly get: (
    direction: AcpExtensionDirection,
    method: string,
  ) => AcpExtensionDefinition | null;
  readonly validateParams: (
    direction: AcpExtensionDirection,
    method: string,
    value: unknown,
  ) => void;
  readonly validateResult: (
    direction: AcpExtensionDirection,
    method: string,
    value: unknown,
  ) => void;
}

const EXTENSION_METHOD_PATTERN = /^(?:_|[A-Za-z0-9][A-Za-z0-9.-]*\/)[A-Za-z0-9._/-]{1,238}$/u;

function registryKey(direction: AcpExtensionDirection, method: string): string {
  return `${direction}\u0000${method}`;
}

export function createAcpExtensionRegistry(
  definitions: readonly AcpExtensionDefinition[] = [],
): AcpExtensionRegistry {
  const entries = new Map<string, AcpExtensionDefinition>();
  for (const definition of definitions) {
    if (!EXTENSION_METHOD_PATTERN.test(definition.method)) {
      throw new TypeError('ACP extension method name is invalid.');
    }
    if (typeof definition.validateParams !== 'function') {
      throw new TypeError('ACP extension requires a parameter validator.');
    }
    if (
      definition.direction.endsWith('request')
      && typeof definition.validateResult !== 'function'
    ) {
      throw new TypeError('ACP request extension requires a result validator.');
    }
    const key = registryKey(definition.direction, definition.method);
    if (entries.has(key)) throw new TypeError('ACP extension registration is duplicated.');
    entries.set(key, Object.freeze({ ...definition }));
  }

  const get = (direction: AcpExtensionDirection, method: string) => (
    entries.get(registryKey(direction, method)) ?? null
  );
  const registry: AcpExtensionRegistry = {
    get,
    validateParams: (direction, method, value) => {
      const definition = get(direction, method);
      if (!definition || !definition.validateParams(value)) {
        throw new AcpProtocolError('acp_extension_params_invalid', { direction, method });
      }
    },
    validateResult: (direction, method, value) => {
      const definition = get(direction, method);
      if (!definition?.validateResult || !definition.validateResult(value)) {
        throw new AcpProtocolError('acp_extension_result_invalid', { direction, method });
      }
    },
  };
  return Object.freeze(registry);
}
