// ------------------------------------------------------------------------------------------------
//                serializedJsonBytes.ts - JSON byte accounting without payload materialization - Dependencies: agent protocol
// ------------------------------------------------------------------------------------------------

import type { AgentJsonValue } from "@agenai/agent-protocol";

// ------------------------------------------------------------------------------------------------
//                Exact JSON and UTF-8 Accounting
// ------------------------------------------------------------------------------------------------

function serializedJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
      continue;
    }
    if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      bytes += 2;
      continue;
    }
    if (codeUnit < 0x20) {
      bytes += 6;
      continue;
    }
    if (codeUnit < 0x80) {
      bytes += 1;
      continue;
    }
    if (codeUnit < 0x800) {
      bytes += 2;
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
      continue;
    }
    bytes += codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

export function serializedAgentJsonValueBytes(value: AgentJsonValue): number {
  if (value === null) return 4;
  if (typeof value === "string") return serializedJsonStringBytes(value);
  if (typeof value === "number") return String(value).length;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) {
    return value.reduce(
      (bytes, item, index) =>
        bytes + serializedAgentJsonValueBytes(item) + (index === 0 ? 0 : 1),
      2,
    );
  }

  return Object.entries(value).reduce(
    (bytes, [key, item], index) =>
      bytes +
      serializedJsonStringBytes(key) +
      1 +
      serializedAgentJsonValueBytes(item) +
      (index === 0 ? 0 : 1),
    2,
  );
}
