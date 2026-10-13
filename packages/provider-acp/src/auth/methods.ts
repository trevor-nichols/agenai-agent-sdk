import type { AcpJsonObject } from '@agen-ai/acp-transport';
import type { AgentAuthenticationFlow } from '@agen-ai/agent-protocol';
import type { AcpNegotiatedAgent } from '../connection/contracts.js';
import type { AcpAuthenticationMethods, AcpHostFacilities } from '../host/contracts.js';
import { hostObject, hostText } from '../host/validation.js';

export interface AcpAuthenticationMethod {
  readonly methodId: string;
  readonly type: 'agent' | 'terminal';
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function resolveAuthenticationMapping(value: AcpAuthenticationMethods = {}): AcpAuthenticationMethods {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((flow) => !['browser', 'device_code', 'terminal'].includes(flow))) {
    throw new TypeError('ACP authentication requires explicit supported flow mappings.');
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([flow, selection]) => {
    if (!selection || typeof selection !== 'object' || Object.keys(selection).some((key) => key !== 'methodId')) {
      throw new TypeError('ACP authentication selections contain only an advertised method ID.');
    }
    return [flow, Object.freeze({ methodId: hostText(selection.methodId, 256) })];
  })));
}

export function selectedAuthenticationMethods(
  negotiated: AcpNegotiatedAgent,
  selections: AcpAuthenticationMethods,
  host: AcpHostFacilities,
): ReadonlyMap<AgentAuthenticationFlow, AcpAuthenticationMethod> {
  if (negotiated.authMethods.length > 32) throw new TypeError('ACP authentication method inventory exceeds its bound.');
  const methods = new Map<string, AcpJsonObject>();
  for (const value of negotiated.authMethods) {
    const method = hostObject(value);
    const id = hostText(method.id, 256);
    if (methods.has(id)) throw new TypeError('ACP authentication method IDs must be unique.');
    methods.set(id, method);
  }
  const selected = new Map<AgentAuthenticationFlow, AcpAuthenticationMethod>();
  for (const flow of ['device_code', 'browser', 'terminal'] as const) {
    const selection = selections[flow];
    if (!selection) continue;
    const method = methods.get(selection.methodId);
    if (!method) throw new TypeError('A selected ACP authentication method was not advertised.');
    const type = method.type ?? 'agent';
    if (type !== 'agent' && type !== 'terminal') throw new TypeError('The selected ACP authentication method type is unsupported.');
    if ((flow === 'terminal' && (type !== 'terminal' || !host.authenticateInTerminal))
      || (flow !== 'terminal' && type !== 'agent')) throw new TypeError('ACP authentication method and host flow do not match.');
    const args = method.args ?? [];
    if (!Array.isArray(args) || args.length > 128) throw new TypeError('ACP authentication arguments exceed their bound.');
    const env = method.env == null ? {} : hostObject(method.env);
    if (Object.keys(env).length > 128) throw new TypeError('ACP authentication environment exceeds its bound.');
    const variables = Object.entries(env).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new TypeError('ACP authentication environment names are invalid.');
      return [name, hostText(value, 16_384, true)] as const;
    });
    selected.set(flow, Object.freeze({ methodId: selection.methodId, type,
      args: Object.freeze(args.map((value) => hostText(value, 16_384, true))), env: Object.freeze(Object.fromEntries(variables)) }));
  }
  return selected;
}
