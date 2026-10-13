// ------------------------------------------------------------------------------------------------
//                json.ts - Defensive JSON value inspection - Dependencies: limits/errors
// ------------------------------------------------------------------------------------------------

import { AcpProtocolError } from './errors.js';
import type { AcpProtocolLimits } from './limits.js';

// ------------------------------------------------------------------------------------------------
//                Types
// ------------------------------------------------------------------------------------------------

export type AcpJsonPrimitive = null | boolean | number | string;
export type AcpJsonValue = AcpJsonPrimitive | AcpJsonValue[] | AcpJsonObject;
export interface AcpJsonObject { readonly [key: string]: AcpJsonValue }

const PROHIBITED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isAcpPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ------------------------------------------------------------------------------------------------
//                Bounded Shape Validation
// ------------------------------------------------------------------------------------------------

export function assertBoundedAcpJson(
  value: unknown,
  limits: AcpProtocolLimits,
): asserts value is AcpJsonValue {
  let nodes = 0;
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > limits.maxJsonNodes) throw new AcpProtocolError('acp_json_node_limit_exceeded');
    if (current.depth > limits.maxJsonDepth) {
      throw new AcpProtocolError('acp_json_depth_limit_exceeded');
    }

    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new AcpProtocolError('acp_json_number_invalid');
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length > limits.maxArrayItems) {
        throw new AcpProtocolError('acp_json_array_limit_exceeded');
      }
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isAcpPlainObject(item)) throw new AcpProtocolError('acp_json_value_invalid');

    const entries = Object.entries(item);
    if (entries.length > limits.maxObjectProperties) {
      throw new AcpProtocolError('acp_json_object_limit_exceeded');
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index] ?? [];
      if (!key || PROHIBITED_KEYS.has(key)) {
        throw new AcpProtocolError('acp_json_prototype_key_denied');
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function parseBoundedAcpJson(text: string, limits: AcpProtocolLimits): AcpJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AcpProtocolError('acp_json_invalid');
  }
  assertBoundedAcpJson(parsed, limits);
  return parsed;
}
