import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { SandboxFileOptions, SandboxFileReadResult, SandboxReadOnlyFiles, SandboxReadWriteFiles } from "@agen-ai/sandbox";
import { ObservationDirectory, cleanupAfterFailure, sameIdentity } from "./ownership.js";
import type { LiveObservationOwner } from "./ownership.js";

export class IncompleteFileCaptureError extends Error {
  constructor(readonly observation: SandboxFileReadResult) {
    super(`Guest file capture did not complete: ${observation.kind}.`);
    this.name = "IncompleteFileCaptureError";
  }
}

export interface CapturedSandboxFile extends LiveObservationOwner {
  readonly id: string;
  readonly byteLength: bigint;
  readonly sha256: string;
  /** Reads the captured host copy; it never reopens the guest path. Maximum working range is 64 KiB. */
  readRange(offset: number, length: number): Promise<Uint8Array>;
}

function assertSealed(current: BigIntStats, expected: BigIntStats): void {
  if (!current.isFile() || current.nlink !== 1n || !sameIdentity(current, expected) || current.size !== expected.size
    || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw new Error("Captured file identity or content metadata changed.");
  }
}

export async function captureSandboxFile(files: SandboxReadOnlyFiles | SandboxReadWriteFiles, path: string,
  directory: string, options?: SandboxFileOptions): Promise<CapturedSandboxFile> {
  const scratch = await ObservationDirectory.create(directory);
  let handle: FileHandle | undefined;
  let accepting = true;
  let closed = false;
  let active: Promise<Uint8Array> | undefined;
  let closing: Promise<void> | undefined;
  const owner: LiveObservationOwner = {
    close() {
      accepting = false;
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        await active?.catch(() => {});
        if (handle) { await scratch.closeFile(handle); handle = undefined; }
        await scratch.close();
        closed = true;
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
  try {
    handle = await scratch.createFile("capture.partial");
    const writer = handle;
    const digest = createHash("sha256");
    let byteLength = 0n;
    const observation = await files.readFile(path, async ({ chunks }, { signal }) => {
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal.throwIfAborted();
          const { bytesWritten } = await writer.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Captured file write made no progress.");
          offset += bytesWritten;
        }
        digest.update(chunk);
        byteLength += BigInt(chunk.byteLength);
      }
    }, options);
    if (observation.kind !== "completed") throw new IncompleteFileCaptureError(observation);
    if (observation.bytes !== byteLength) throw new Error("Captured byte count differs from the settled guest read.");
    await writer.chmod(0o400);
    const written = await writer.stat({ bigint: true });
    await scratch.closeFile(writer);
    handle = undefined;
    await scratch.verify();
    await rename(scratch.path("capture.partial"), scratch.path("capture"));
    handle = await open(scratch.path("capture"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const reader = handle;
    const sealed = await reader.stat({ bigint: true });
    if (!sealed.isFile() || sealed.nlink !== 1n || !sameIdentity(written, sealed) || sealed.size !== byteLength) throw new Error("Captured file publication could not be verified.");
    const sha256 = digest.digest("hex");
    return Object.freeze({
      id: randomUUID(), byteLength, sha256, close: owner.close,
      readRange(offset: number, length: number): Promise<Uint8Array> {
        if (!accepting || active) return Promise.reject(new Error("Captured range reads require an idle open observation owner."));
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 65536 || !Number.isSafeInteger(offset + length)
          || BigInt(offset) + BigInt(length) > byteLength) return Promise.reject(new RangeError("Range must lie within captured bytes and the 64-KiB working bound."));
        const actual = (async () => {
          await scratch.verify();
          assertSealed(await reader.stat({ bigint: true }), sealed);
          const result = new Uint8Array(length);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await reader.read(result, read, length - read, offset + read);
            if (!bytesRead) throw new Error("Captured file was truncated during a range read.");
            read += bytesRead;
          }
          assertSealed(await reader.stat({ bigint: true }), sealed);
          return result;
        })().finally(() => { if (active === actual) active = undefined; });
        active = actual;
        return actual;
      },
    });
  } catch (error) { return cleanupAfterFailure(error, owner); }
}
