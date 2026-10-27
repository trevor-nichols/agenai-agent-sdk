import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Writable } from "node:stream";
import { parseSandboxGuestPath, parseSandboxId, parseSandboxRelativePath } from "@agen-ai/sandbox";
import type { Sandbox, SandboxByteSource, SandboxFileOptions, SandboxFileReadResult, SandboxFileWriteOptions,
  SandboxFileWriteResult, SandboxReadWriteFiles, SandboxState } from "@agen-ai/sandbox";
import type { AcpJsonValue, AcpMessage, AcpNotificationContext, AcpRequestId } from "@agen-ai/acp-transport";
import { createSandboxGrokClient } from "../index.js";
import type { SandboxAcpFileBudgets } from "../index.js";

export function gate() { return Promise.withResolvers<void>(); }

export const budgets: SandboxAcpFileBudgets = {
  maxResponseFrameBytes: 1024, maxRequestIdBytes: 32, maxReadBytes: 256 * 1024,
  maxWriteBytes: 256 * 1024, writeChunkBytes: 512,
};

/** The fake stores bytes only; the adapter and real ACP transport own all policy and responses. */
export function fixture(options: {
  readonly grant?: "read_only" | "read_write";
  readonly budgets?: SandboxAcpFileBudgets;
  readonly stdin?: Writable;
  readonly beforeRead?: (signal: AbortSignal | undefined) => Promise<void>;
  readonly afterWrite?: (bytes: bigint, signal: AbortSignal | undefined) => Promise<SandboxFileWriteResult>;
} = {}) {
  const contents = new Map<string, Uint8Array>();
  const accesses: { kind: "read" | "write"; path: string }[] = [];
  const writeChunks: number[] = [];
  let state: SandboxState = { kind: "ready" };
  let nextId = 0;
  const port: SandboxReadWriteFiles = {
    kind: "read_write",
    stat() { throw new Error("This example never uses stat."); },
    list() { throw new Error("This example never uses list."); },
    async readFile(path, consume, operation?: SandboxFileOptions): Promise<SandboxFileReadResult> {
      accesses.push({ kind: "read", path });
      await options.beforeRead?.(operation?.signal);
      const content = contents.get(path);
      if (content === undefined) return { kind: "missing", bytes: 0n };
      const signal = operation?.signal ?? new AbortController().signal;
      await consume({ entry: { kind: "file", path: parseSandboxRelativePath(path), byteLength: content.byteLength, permissions: 0o644 },
        chunks: { async *[Symbol.asyncIterator]() {
          // Single bytes force multibyte UTF-8 and CRLF to cross source chunk boundaries.
          for (const byte of content) yield Uint8Array.of(byte);
        } } }, { signal });
      return { kind: "completed", bytes: BigInt(content.byteLength) };
    },
    async writeFile(path: string, source: SandboxByteSource, operation: SandboxFileWriteOptions): Promise<SandboxFileWriteResult> {
      accesses.push({ kind: "write", path });
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) { writeChunks.push(chunk.byteLength); chunks.push(chunk); }
      const content = Buffer.concat(chunks);
      contents.set(path, content);
      return await options.afterWrite?.(BigInt(content.byteLength), operation.signal)
        ?? { kind: "completed", effect: "published", bytes: BigInt(content.byteLength), permissions: 0o644 };
    },
  };
  const sandbox = Object.freeze<Sandbox>({
    id: parseSandboxId("controlled-sandbox"), workspace: parseSandboxGuestPath("/workspace/work"), files: port,
    get state() { return state; },
    effective: { backendIdentity: "controlled-memory", isolation: "container", resources: { cpus: 1, memoryBytes: 1024 ** 3, pids: 32 },
      temporaryStorage: { homeBytes: 1024 ** 2, tempBytes: 1024 ** 2 }, network: { kind: "isolated" }, files: { kind: "read_write" },
      nonRoot: true, readOnlyRoot: true, workspaceDiskQuota: { kind: "not_requested" } },
    get recoveryRecord(): never { throw new Error("The text adapter does not use recovery records."); },
    importTree(): never { throw new Error("The text adapter does not import trees."); },
    exportTree(): never { throw new Error("The text adapter does not export trees."); },
    reserveProcess(): never { throw new Error("The fixture supplies controlled ACP streams."); },
    async stop() { state = { kind: "stopped" }; },
    async destroy() { state = { kind: "destroyed" }; },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = options.stdin ?? new PassThrough();
  const frames: { message: AcpMessage; raw: string }[] = [];
  const updates: AcpNotificationContext[] = [];
  const received = new EventEmitter();
  let buffer = "";
  if (stdin instanceof PassThrough) stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const message: AcpMessage = JSON.parse(raw);
      frames.push({ message, raw });
      received.emit("response", message);
    }
  });
  const integration = createSandboxGrokClient({ sandbox, streams: { stdin, stdout, stderr },
    grant: { kind: options.grant ?? "read_write" }, budgets: options.budgets ?? budgets,
    onSessionUpdate: (context) => { updates.push(context); } });
  const send = (method: string, params: AcpJsonValue, id: AcpRequestId = `file-${++nextId}`) => {
    const response = new Promise<AcpMessage>((resolve) => {
      const listener = (message: AcpMessage) => {
        if ("id" in message && message.id === id && !("method" in message)) { received.off("response", listener); resolve(message); }
      };
      received.on("response", listener);
    });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
    return response;
  };
  const read = (path = "/workspace/work/seed.txt", range: Readonly<{ line?: number; limit?: number }> = {}, id?: AcpRequestId) =>
    send("fs/read_text_file", { sessionId: "native-session", path, ...range }, id);
  const write = (content: string, path = "/workspace/work/seed.txt", id?: AcpRequestId) =>
    send("fs/write_text_file", { sessionId: "native-session", path, content }, id);
  return { ...integration, sandbox, contents, accesses, writeChunks, frames, updates, send, read, write, stdout,
    async close() {
      integration.files.revoke();
      const settled = await Promise.allSettled([integration.client.dispose(), integration.files.close()]);
      await sandbox.stop();
      const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Example cleanup retained its original failures.");
    },
  };
}
