import { isAbsolute } from 'node:path';
import { AcpRpcHandlerError, type AcpJsonObject, type AcpJsonValue } from '@agen-ai/acp-transport';
import type { AcpHostFacilities, AcpHostTerminalExitStatus } from './contracts.js';

export function hostObject(value: unknown): AcpJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidHostRequest();
  return value as AcpJsonObject;
}

export function hostText(value: unknown, maximum = 4_096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > maximum || value.includes('\0')) throw invalidHostRequest();
  return value;
}

export function hostPath(value: unknown): string {
  const path = hostText(value);
  if (!isAbsolute(path)) throw invalidHostRequest();
  return path;
}

export function hostInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw invalidHostRequest();
  return value as number;
}

export function hostExitStatus(value: unknown): AcpHostTerminalExitStatus {
  const status = hostObject(value);
  const exitCode = status.exitCode == null ? undefined : hostInteger(status.exitCode, 0, 0xffff_ffff);
  const signal = status.signal == null ? undefined : hostText(status.signal, 80);
  return Object.freeze({ ...(exitCode === undefined ? {} : { exitCode }), ...(signal === undefined ? {} : { signal }) });
}

export function invalidHostRequest(): AcpRpcHandlerError {
  return new AcpRpcHandlerError(-32602, 'The host facility request or response is invalid.');
}

export function unsupportedHostRequest(): AcpRpcHandlerError {
  return new AcpRpcHandlerError(-32602, 'This host facility is not available.');
}

export function hostEnvironment(value: AcpJsonValue | undefined): Readonly<Record<string, string>> {
  if (value == null) return Object.freeze({});
  if (!Array.isArray(value) || value.length > 128) throw invalidHostRequest();
  const entries = value.map((item) => {
    const entry = hostObject(item);
    const name = hostText(entry.name, 256);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw invalidHostRequest();
    return [name, hostText(entry.value, 16_384, true)] as const;
  });
  if (new Set(entries.map(([name]) => name)).size !== entries.length) throw invalidHostRequest();
  return Object.freeze(Object.fromEntries(entries));
}

export function resolveHostFacilities(value: AcpHostFacilities = {}): AcpHostFacilities {
  const allowed = ['form', 'url', 'readTextFile', 'writeTextFile', 'createTerminal', 'authenticateInTerminal'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || Object.values(value).some((callback) => typeof callback !== 'function')) {
    throw new TypeError('ACP host facilities must contain only explicit supported callbacks.');
  }
  return Object.freeze({ ...value });
}

export function freezeHostData<Value extends AcpJsonValue>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeHostData(child as AcpJsonValue);
    Object.freeze(value);
  }
  return value;
}
