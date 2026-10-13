// ------------------------------------------------------------------------------------------------
//                protocol.ts - Strict JSON-RPC envelope contracts - Dependencies: JSON bounds
// ------------------------------------------------------------------------------------------------

import { AcpProtocolError } from './errors.js';
import { assertBoundedAcpJson, isAcpPlainObject, type AcpJsonValue } from './json.js';
import type { AcpProtocolLimits } from './limits.js';

export type AcpRequestId = string | number;

export interface AcpRequestMessage {
  readonly jsonrpc: '2.0';
  readonly id: AcpRequestId;
  readonly method: string;
  readonly params?: AcpJsonValue;
}

export interface AcpNotificationMessage {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: AcpJsonValue;
}

export interface AcpErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: AcpJsonValue;
}

export type AcpResponseMessage =
  | { readonly jsonrpc: '2.0'; readonly id: AcpRequestId; readonly result: AcpJsonValue }
  | { readonly jsonrpc: '2.0'; readonly id: AcpRequestId; readonly error: AcpErrorObject };

export type AcpMessage = AcpRequestMessage | AcpNotificationMessage | AcpResponseMessage;

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function acpRequestIdKey(id: AcpRequestId): string {
  return typeof id === 'string' ? `s:${id}` : `n:${id}`;
}

export function assertAcpRequestId(
  id: unknown,
  limits: AcpProtocolLimits,
): asserts id is AcpRequestId {
  if (typeof id === 'number') {
    if (!Number.isSafeInteger(id)) throw new AcpProtocolError('acp_request_id_invalid');
    return;
  }
  if (
    typeof id !== 'string'
    || id.length === 0
    || Buffer.byteLength(id, 'utf8') > limits.maxRequestIdBytes
    || /[\u0000-\u001f\u007f]/u.test(id)
  ) {
    throw new AcpProtocolError('acp_request_id_invalid');
  }
}

function assertMethod(method: unknown): asserts method is string {
  if (
    typeof method !== 'string'
    || method.length === 0
    || method.length > 240
    || /[\u0000-\u001f\u007f]/u.test(method)
  ) {
    throw new AcpProtocolError('acp_method_invalid');
  }
}

function parseError(value: unknown, limits: AcpProtocolLimits): AcpErrorObject {
  if (!isAcpPlainObject(value) || !hasExactKeys(value, ['code', 'message', 'data'])) {
    throw new AcpProtocolError('acp_error_object_invalid');
  }
  if (!Number.isSafeInteger(value.code)) throw new AcpProtocolError('acp_error_code_invalid');
  if (typeof value.message !== 'string' || Buffer.byteLength(value.message, 'utf8') > 2_048) {
    throw new AcpProtocolError('acp_error_message_invalid');
  }
  if ('data' in value) assertBoundedAcpJson(value.data, limits);
  return value as unknown as AcpErrorObject;
}

export function parseAcpMessage(value: AcpJsonValue, limits: AcpProtocolLimits): AcpMessage {
  if (!isAcpPlainObject(value)) throw new AcpProtocolError('acp_batch_or_non_object_denied');
  if (value.jsonrpc !== '2.0') throw new AcpProtocolError('acp_jsonrpc_version_invalid');

  const hasMethod = 'method' in value;
  const hasId = 'id' in value;
  if (hasMethod) {
    assertMethod(value.method);
    if ('params' in value) assertBoundedAcpJson(value.params, limits);
    if (hasId) {
      if (!hasExactKeys(value, ['jsonrpc', 'id', 'method', 'params'])) {
        throw new AcpProtocolError('acp_request_envelope_invalid');
      }
      assertAcpRequestId(value.id, limits);
      return value as unknown as AcpRequestMessage;
    }
    if (!hasExactKeys(value, ['jsonrpc', 'method', 'params'])) {
      throw new AcpProtocolError('acp_notification_envelope_invalid');
    }
    return value as unknown as AcpNotificationMessage;
  }

  if (!hasId || !hasExactKeys(value, ['jsonrpc', 'id', 'result', 'error'])) {
    throw new AcpProtocolError('acp_response_envelope_invalid');
  }
  assertAcpRequestId(value.id, limits);
  const hasResult = 'result' in value;
  const hasError = 'error' in value;
  if (hasResult === hasError) throw new AcpProtocolError('acp_response_outcome_invalid');
  if (hasResult) {
    assertBoundedAcpJson(value.result, limits);
    return value as unknown as AcpResponseMessage;
  }
  return { jsonrpc: '2.0', id: value.id, error: parseError(value.error, limits) };
}
