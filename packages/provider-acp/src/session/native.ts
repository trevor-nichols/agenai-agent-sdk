import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';

import { AcpProviderSessionError } from './errors.js';

export function nativeObject(value: AcpJsonValue | undefined, field: string): AcpJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcpProviderSessionError('acp_session_invalid_value', `ACP ${field} must be an object.`);
  }
  return value;
}

export function nativeString(value: AcpJsonValue | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new AcpProviderSessionError('acp_session_invalid_value', `ACP ${field} must be a string.`);
  }
  return value;
}

export function nativeIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 256
    || /[\p{Cc}\p{Cf}]/u.test(value)) throw new AcpProviderSessionError(
    'acp_descendant_identity_invalid', `The selected native ${field} is invalid.`);
  return value;
}

export function displayText(value: AcpJsonValue | undefined, fallback: string, limit = 120): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, limit).trimEnd();
}

export function nativeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export const SESSION_METADATA_UPDATES = new Set([
  'available_commands_update', 'current_mode_update', 'config_option_update',
  'session_info_update', 'usage_update',
]);
