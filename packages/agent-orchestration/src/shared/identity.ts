// ------------------------------------------------------------------------------------------------
//                identity.ts - Deterministic delegation identities and digests
// ------------------------------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { copyBoundedDelegationData } from "./bounds.js";

export function delegationCanonicalJson(input: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]));
    }
    return value;
  };
  return JSON.stringify(canonicalize(copyBoundedDelegationData(input)));
}

export function delegationDataBytes(input: unknown): number {
  return new TextEncoder().encode(delegationCanonicalJson(input)).byteLength;
}

export function delegationInputDigest(input: unknown): string {
  return createHash("sha256").update(delegationCanonicalJson(input)).digest("hex");
}

export function createDelegationId(): string {
  return randomUUID();
}

export function delegationSubordinateId(runId: string, kind: string): string {
  const hex = delegationInputDigest({ runId, kind });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
