import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseSandboxRelativePath } from "@agen-ai/sandbox";
import type { SandboxFileEntry, SandboxFileListResult, SandboxFileOptions, SandboxReadOnlyFiles, SandboxReadWriteFiles } from "@agen-ai/sandbox";
import { ObservationDirectory, cleanupAfterFailure } from "./ownership.js";
import type { LiveObservationOwner } from "./ownership.js";

export class IncompleteDirectoryObservationError extends Error {
  constructor(readonly observation: SandboxFileListResult) {
    super(`Guest directory observation did not complete: ${observation.kind}.`);
    this.name = "IncompleteDirectoryObservationError";
  }
}

export interface DirectoryObservationPage {
  readonly entries: readonly SandboxFileEntry[];
  readonly nextToken?: string;
}

export interface CapturedSandboxListing extends LiveObservationOwner {
  readonly generation: string;
  readonly entries: bigint;
  /** Tokens belong only to this captured observation; refreshing creates a new generation. */
  readPage(token?: string, limit?: number): Promise<DirectoryObservationPage>;
}

function readCursor(token: string | undefined, generation: string): string {
  if (token === undefined) return "";
  if (typeof token !== "string" || token.length > 32768 || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new TypeError("Invalid listing page token.");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(token, "base64url")));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || !("generation" in value) || value.generation !== generation || !("after" in value) || typeof value.after !== "string") {
    throw new TypeError("Listing page token is stale or belongs to another observation.");
  }
  return parseSandboxRelativePath(value.after);
}

function decodeEntry(value: unknown): SandboxFileEntry {
  if (typeof value !== "string" || Buffer.byteLength(value) > 32768) throw new Error("Invalid captured listing row.");
  const entry: unknown = JSON.parse(value);
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 4
    || !("kind" in entry) || !("path" in entry) || !("byteLength" in entry) || !("permissions" in entry)
    || (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink" && entry.kind !== "unsupported_hardlink" && entry.kind !== "unsupported_special")
    || typeof entry.path !== "string" || typeof entry.byteLength !== "number" || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0
    || typeof entry.permissions !== "number" || !Number.isSafeInteger(entry.permissions) || entry.permissions < 0 || entry.permissions > 0o777) {
    throw new Error("Captured listing row is not an admitted file observation.");
  }
  return Object.freeze({ kind: entry.kind, path: parseSandboxRelativePath(entry.path), byteLength: entry.byteLength, permissions: entry.permissions });
}

/** Requires Node >=22.13. SQLite stores and orders the captured metadata on caller-selected disk. */
export async function captureSandboxListing(files: SandboxReadOnlyFiles | SandboxReadWriteFiles, path: string,
  directory: string, options?: SandboxFileOptions): Promise<CapturedSandboxListing> {
  const scratch = await ObservationDirectory.create(directory);
  let database: DatabaseSync | undefined;
  let accepting = true;
  let closed = false;
  let active: Promise<DirectoryObservationPage> | undefined;
  let closing: Promise<void> | undefined;
  const owner: LiveObservationOwner = {
    close() {
      accepting = false;
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        await active?.catch(() => {});
        if (database) { database.close(); database = undefined; }
        await scratch.close();
        closed = true;
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
  try {
    const initial = await scratch.createFile("listing.sqlite");
    await scratch.closeFile(initial);
    const databasePath = scratch.path("listing.sqlite");
    scratch.path("listing.sqlite-journal");
    database = new DatabaseSync(databasePath, { allowExtension: false });
    database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-1024; PRAGMA trusted_schema=OFF;");
    database.exec("CREATE TABLE entry (path TEXT PRIMARY KEY COLLATE BINARY, payload TEXT NOT NULL) WITHOUT ROWID; BEGIN");
    const insert = database.prepare("INSERT INTO entry (path,payload) VALUES (?,?)");
    let entries = 0n;
    const observation = await files.list(path, async (entry, { signal }) => {
      signal.throwIfAborted();
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload) > 32768) throw new Error("Directory metadata exceeds the example's per-record working bound.");
      insert.run(entry.path, payload);
      entries += 1n;
    }, options);
    if (observation.kind !== "completed") throw new IncompleteDirectoryObservationError(observation);
    if (observation.entries !== entries) throw new Error("Captured entry count differs from the settled guest listing.");
    database.exec("COMMIT");
    database.close();
    database = undefined;
    await chmod(databasePath, 0o400);
    database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA busy_timeout=0; PRAGMA cache_size=-1024; PRAGMA trusted_schema=OFF;");
    const select = database.prepare("SELECT path,payload FROM entry WHERE path > ? ORDER BY path COLLATE BINARY LIMIT ?");
    const generation = randomUUID();
    return Object.freeze({
      generation, entries, close: owner.close,
      readPage(token?: string, limit = 128): Promise<DirectoryObservationPage> {
        if (!accepting || active) return Promise.reject(new Error("Listing pages require an idle open observation owner."));
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) return Promise.reject(new RangeError("Page size must be between 1 and 256 entries."));
        let after: string;
        try { after = readCursor(token, generation); } catch (error) { return Promise.reject(error); }
        const actual = (async () => {
          await scratch.verify();
          const rows = select.all(after, limit + 1);
          const page = rows.slice(0, limit).map((row) => decodeEntry(row.payload));
          const last = page.at(-1);
          return Object.freeze({ entries: Object.freeze(page),
            ...(rows.length > limit && last ? { nextToken: Buffer.from(JSON.stringify({ generation, after: last.path })).toString("base64url") } : {}),
          });
        })().finally(() => { if (active === actual) active = undefined; });
        active = actual;
        return actual;
      },
    });
  } catch (error) { return cleanupAfterFailure(error, owner); }
}
