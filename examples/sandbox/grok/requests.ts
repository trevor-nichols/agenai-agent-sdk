import { AcpRpcHandlerError } from "@agen-ai/acp-transport";
import type { AcpJsonValue, AcpRequestId } from "@agen-ai/acp-transport";
import { parseSandboxRelativePath, SANDBOX_LIMITS } from "@agen-ai/sandbox";
import type { SandboxFileWriteResult, SandboxGuestPath, SandboxRelativePath } from "@agen-ai/sandbox";

const rejectionMessage = "Sandbox file request rejected.";

export type SandboxAcpFileFailure = "invalid_request" | "inactive_scope" | "capacity" | "read_failed" | "write_failed" | "response_budget";

/** A failed native response never proves that a guest write had no effect. */
export class SandboxAcpFileError extends AcpRpcHandlerError {
  constructor(readonly reason: SandboxAcpFileFailure, readonly writeObservation?: SandboxFileWriteResult) {
    super(-32602, rejectionMessage);
    this.name = "SandboxAcpFileError";
  }
}

export interface SandboxAcpFileBudgets {
  /** Entire serialized JSON-RPC envelope, excluding its single LF delimiter. */
  readonly maxResponseFrameBytes: number;
  readonly maxRequestIdBytes: number;
  /** Cumulative bytes scanned, including bytes outside the selected lines. */
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  /** Select the owning request's policy.transfers.chunkBytes. */
  readonly writeChunkBytes: number;
}

export function captureBudgets(input: SandboxAcpFileBudgets): SandboxAcpFileBudgets {
  const budgets = Object.freeze({ ...input });
  for (const key of ["maxResponseFrameBytes", "maxRequestIdBytes", "maxReadBytes", "maxWriteBytes", "writeChunkBytes"] as const) {
    const value = budgets[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("File budgets must be nonnegative safe integers.");
  }
  if (budgets.writeChunkBytes === 0 || budgets.writeChunkBytes > SANDBOX_LIMITS.maxTransferChunkBytes) {
    throw new RangeError("Write chunks must fit the public sandbox working chunk bound.");
  }
  const errorOverhead = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "", error: { code: -32602, message: rejectionMessage } }));
  // Even a maximally escaped admitted ID must leave room for a correlated rejection.
  if (budgets.maxResponseFrameBytes < errorOverhead + 6 * budgets.maxRequestIdBytes) {
    throw new RangeError("The response budget cannot hold every admitted request ID and its error envelope.");
  }
  return budgets;
}

export function admitRequestId(id: AcpRequestId, maxBytes: number): void {
  if (typeof id === "number" ? !Number.isSafeInteger(id)
    : !id || Buffer.byteLength(id) > maxBytes || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new SandboxAcpFileError("invalid_request");
  }
}

export function admitResponse(id: AcpRequestId, result: AcpJsonValue, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result })) > maxBytes) {
    throw new SandboxAcpFileError("response_budget");
  }
}

export function guestFilePath(workspace: SandboxGuestPath, value: AcpJsonValue | undefined): SandboxRelativePath {
  const prefix = workspace === "/" ? "/" : `${workspace}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new SandboxAcpFileError("invalid_request");
  try { return parseSandboxRelativePath(value.slice(prefix.length)); }
  catch { throw new SandboxAcpFileError("invalid_request"); }
}

export function fileRequest(value: AcpJsonValue | undefined, write: boolean) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SandboxAcpFileError("invalid_request");
  const allowed = write ? ["sessionId", "path", "content", "_meta"] : ["sessionId", "path", "line", "limit", "_meta"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || typeof value.sessionId !== "string" || !value.sessionId) {
    throw new SandboxAcpFileError("invalid_request");
  }
  return value;
}

export function lineNumber(value: AcpJsonValue | undefined, minimum: 0 | 1): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new SandboxAcpFileError("invalid_request");
  }
  return value;
}

export function writeContent(value: AcpJsonValue | undefined, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > maxBytes) {
    throw new SandboxAcpFileError("invalid_request");
  }
  return Buffer.from(value);
}
