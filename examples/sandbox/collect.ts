// ------------------------------------------------------------------------------------------------
//                collect.ts - Caller-bounded selected artifact collection for small examples
// ------------------------------------------------------------------------------------------------

import type { Sandbox, SandboxTransferOptions } from "@agen-ai/sandbox";

export interface CollectedSandboxFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export type SandboxTransferObservationOptions = Pick<SandboxTransferOptions, "signal" | "deadlineAt">;

/** Small-artifact convenience: the caller explicitly selects the aggregate byte and file-count bound. */
export async function collectSandboxFiles(sandbox: Sandbox, exportPaths: readonly string[], maxExportBytes: number,
  options: SandboxTransferObservationOptions = {}): Promise<readonly CollectedSandboxFile[]> {
  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes < 0) throw new RangeError("Select a nonnegative safe-integer export byte budget.");
  const files: CollectedSandboxFile[] = [];
  let total = 0;
  await sandbox.exportTree({ kind: "files", paths: exportPaths }, async (entry, { signal }) => {
    if (entry.kind !== "file" || files.length >= exportPaths.length) throw new Error("Selected export exceeded its explicit regular-file count.");
    if (entry.byteLength > maxExportBytes - total) throw new Error("Selected export exceeded its explicit aggregate byte budget.");
    const bytes = new Uint8Array(entry.byteLength);
    let offset = 0;
    for await (const chunk of entry.bytes) {
      signal.throwIfAborted();
      if (chunk.byteLength > bytes.byteLength - offset) throw new Error("Export body exceeded its declared byteLength.");
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== bytes.byteLength) throw new Error("Export body ended before its declared byteLength.");
    total += bytes.byteLength;
    files.push(Object.freeze({ path: entry.path, bytes, executable: entry.executable }));
  }, { ...options, quotas: { maxFiles: exportPaths.length, maxPaths: exportPaths.length,
    maxFileBytes: maxExportBytes, maxTotalBytes: maxExportBytes } });
  return Object.freeze(files);
}
