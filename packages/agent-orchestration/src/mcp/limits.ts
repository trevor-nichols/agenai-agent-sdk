// ------------------------------------------------------------------------------------------------
//                limits.ts - Fixed bounded MCP HTTP envelopes and concurrency
// ------------------------------------------------------------------------------------------------

export const MCP_REQUEST_BYTES = 65_536;
export const MCP_RESPONSE_BYTES = 131_072;
export const MCP_HEADER_BYTES = 8_192;
export const MCP_RECEIPT_TIMEOUT_MS = 10_000;
export const MCP_MAX_HTTP_REQUESTS = 32;
export const MCP_MAX_INVOCATIONS = 16;
export const MCP_MAX_CONNECTIONS = 32;

function finiteTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError("MCP operations require a finite positive timeout.");
  }
  return value;
}

export function shutdownTimeout(value = 10_000): number { return finiteTimeout(value); }
export function requestTimeout(value = 60_000): number { return finiteTimeout(value); }
