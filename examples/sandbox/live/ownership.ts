import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

type OwnedName = "capture.partial" | "capture" | "listing.sqlite" | "listing.sqlite-journal";

export interface LiveObservationOwner { close(): Promise<void> }

export class LiveObservationCleanupError extends Error {
  constructor(readonly primaryError: unknown, readonly cleanupError: unknown, private readonly owner: LiveObservationOwner) {
    super("Live observation cleanup remains owned.", { cause: primaryError });
    this.name = "LiveObservationCleanupError";
  }
  retryCleanup(): Promise<void> { return this.owner.close(); }
}

export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The caller exclusively owns this stable host hierarchy; guests never receive its path. */
export class ObservationDirectory implements LiveObservationOwner {
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly names = new Set<string>();
  private readonly handles = new Set<FileHandle>();

  private constructor(readonly directory: string, private readonly identity: BigIntStats) {}

  static async create(directory: string): Promise<ObservationDirectory> {
    if (!isAbsolute(directory) || normalize(directory) !== directory || directory.endsWith("/") || directory.includes("\0")) {
      throw new TypeError("Select a canonical absolute fresh observation directory.");
    }
    const parent = dirname(directory);
    if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) {
      throw new TypeError("Observation parent must be an existing physical directory under exclusive caller ownership.");
    }
    await mkdir(directory, { mode: 0o700 });
    try { return new ObservationDirectory(directory, await lstat(directory, { bigint: true })); }
    catch (error) { return cleanupAfterFailure(error, { close: () => rmdir(directory) }); }
  }

  path(name: OwnedName): string { this.names.add(name); return join(this.directory, name); }

  async verify(): Promise<void> {
    if (this.closed) throw new Error("Observation directory is closed.");
    const current = await lstat(this.directory, { bigint: true });
    if (!current.isDirectory() || !sameIdentity(current, this.identity)) throw new Error("Observation directory identity changed; cleanup ownership is retained.");
  }

  async createFile(name: OwnedName): Promise<FileHandle> {
    await this.verify();
    const handle = await open(this.path(name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    this.handles.add(handle);
    return handle;
  }

  async closeFile(handle: FileHandle): Promise<void> {
    await handle.close();
    this.handles.delete(handle);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = (async () => {
      for (const handle of this.handles) await this.closeFile(handle);
      await this.verify();
      const entries = await readdir(this.directory, { withFileTypes: true });
      if (entries.some((entry) => !this.names.has(entry.name) || !entry.isFile())) {
        throw new Error("Observation directory contains an unexpected entry; it is preserved.");
      }
      for (const entry of entries) await unlink(join(this.directory, entry.name));
      await rmdir(this.directory);
      this.closed = true;
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
}

export async function cleanupAfterFailure(primaryError: unknown, owner: LiveObservationOwner): Promise<never> {
  try { await owner.close(); }
  catch (cleanupError) { throw new LiveObservationCleanupError(primaryError, cleanupError, owner); }
  throw primaryError;
}
