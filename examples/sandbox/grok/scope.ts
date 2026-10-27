import { DEFAULT_ACP_PROTOCOL_LIMITS, resolveAcpProtocolLimits } from "@agen-ai/acp-transport";
import type { AcpJsonObject, AcpJsonValue, AcpProtocolLimits, AcpReverseRequestContext, AcpReverseRequestHandler } from "@agen-ai/acp-transport";
import type { Sandbox, SandboxFileWriteResult } from "@agen-ai/sandbox";
import { admitRequestId, admitResponse, captureBudgets, fileRequest, guestFilePath, lineNumber, SandboxAcpFileError, writeContent } from "./requests.js";
import type { SandboxAcpFileBudgets } from "./requests.js";
import { readSandboxText } from "./text.js";

export interface SandboxAcpTurnLease {
  readonly signal: AbortSignal;
  /** Revokes synchronously; fulfills only after callbacks and actual response writes settle. */
  close(): Promise<void>;
}

export interface SandboxAcpFileScope {
  readonly capabilities: Readonly<{ fs: Readonly<{ readTextFile: true; writeTextFile: boolean }>; terminal: false }>;
  readonly handlers: Readonly<Record<"fs/read_text_file" | "fs/write_text_file", AcpReverseRequestHandler>>;
  readonly transportLimits: AcpProtocolLimits;
  /** One immutable native session binding for this exact sandbox generation. */
  bindSession(nativeSessionId: string): Readonly<{ openTurn(): SandboxAcpTurnLease; close(): Promise<void> }>;
  revoke(): void;
  close(): Promise<void>;
}

interface Turn {
  readonly controller: AbortController;
  closing?: Promise<void>;
}
type ScopeState = Readonly<{ kind: "unbound" }> | Readonly<{ kind: "bound"; nativeSessionId: string }> | Readonly<{ kind: "revoked" }>;

/** Consumer policy only: no native/provider/product identifiers enter sandbox's public contracts. */
export function createSandboxAcpFileScope(input: {
  readonly sandbox: Sandbox;
  readonly grant: Readonly<{ kind: "read_only" | "read_write" }>;
  readonly budgets: SandboxAcpFileBudgets;
  readonly limits?: Partial<AcpProtocolLimits>;
}): SandboxAcpFileScope {
  const sandbox = input.sandbox;
  const files = sandbox.files;
  const workspace = sandbox.workspace;
  const grant = input.grant.kind;
  if ((grant !== "read_only" && grant !== "read_write") || files.kind === "disabled"
    || (grant === "read_write" && files.kind !== "read_write")) {
    throw new TypeError("Select an explicit grant supported by this sandbox's live files handle.");
  }
  const budgets = captureBudgets(input.budgets);
  if ((input.limits?.maxOutboundFrameBytes !== undefined && input.limits.maxOutboundFrameBytes !== budgets.maxResponseFrameBytes)
    || (input.limits?.maxRequestIdBytes !== undefined && input.limits.maxRequestIdBytes !== budgets.maxRequestIdBytes)) {
    throw new TypeError("File and transport frame/ID budgets must agree.");
  }
  const transportLimits = resolveAcpProtocolLimits({ ...input.limits,
    maxOutboundFrameBytes: budgets.maxResponseFrameBytes,
    maxOutboundBufferedBytes: input.limits?.maxOutboundBufferedBytes
      ?? Math.max(DEFAULT_ACP_PROTOCOL_LIMITS.maxOutboundBufferedBytes, budgets.maxResponseFrameBytes + 1),
    maxRequestIdBytes: budgets.maxRequestIdBytes,
  });
  const controller = new AbortController();
  const pending = new Map<Promise<void>, Turn>();
  let state: ScopeState = { kind: "unbound" };
  let turn: Turn | undefined;
  let queue: Promise<void> = Promise.resolve();
  let effectFailure: SandboxAcpFileError | undefined;

  const revoke = () => {
    state = { kind: "revoked" };
    controller.abort(new SandboxAcpFileError("inactive_scope"));
    turn?.controller.abort(new SandboxAcpFileError("inactive_scope"));
  };
  const join = async (selected?: Turn) => {
    for (;;) {
      const owned = [...pending].filter(([, owner]) => selected === undefined || owner === selected).map(([work]) => work);
      if (!owned.length) break;
      await Promise.all(owned);
    }
    if (effectFailure) throw effectFailure;
  };
  const close = () => { revoke(); return join(); };

  const perform = async (context: AcpReverseRequestContext, request: AcpJsonObject, signal: AbortSignal): Promise<AcpJsonValue> => {
    signal.throwIfAborted();
    if (sandbox.state.kind !== "ready") throw new SandboxAcpFileError("inactive_scope");
    const write = context.method === "fs/write_text_file";
    const path = guestFilePath(workspace, request.path);
    if (!write) {
      const line = lineNumber(request.line, 1);
      const limit = lineNumber(request.limit, 0);
      const content = await readSandboxText({ files, path, id: context.id, budgets, signal,
        ...(line === undefined ? {} : { line }), ...(limit === undefined ? {} : { limit }) });
      return { content };
    }
    if (grant !== "read_write" || files.kind !== "read_write") throw new SandboxAcpFileError("inactive_scope");
    const content = writeContent(request.content, budgets.maxWriteBytes);
    admitResponse(context.id, {}, budgets.maxResponseFrameBytes);
    function* chunks() {
      for (let offset = 0; offset < content.byteLength; offset += budgets.writeChunkBytes) {
        yield content.subarray(offset, offset + budgets.writeChunkBytes);
      }
    }
    // Synchronous admission rejection precedes dispatch and cannot publish this write.
    const writing = files.writeFile(path, chunks(), { mode: "replace", signal, quotas: { maxBytes: budgets.maxWriteBytes } });
    let observation: SandboxFileWriteResult;
    try { observation = await writing; }
    catch (cause) {
      const error = new SandboxAcpFileError("write_failed");
      error.cause = cause;
      effectFailure ??= error;
      revoke();
      throw error;
    }
    if (observation.kind === "completed" && observation.bytes === BigInt(content.byteLength) && !signal.aborted) return {};
    const error = new SandboxAcpFileError("write_failed", observation);
    if (observation.effect !== "none") { effectFailure ??= error; revoke(); }
    throw error;
  };

  const handle: AcpReverseRequestHandler = (context) => {
    admitRequestId(context.id, budgets.maxRequestIdBytes);
    const request = fileRequest(context.params, context.method === "fs/write_text_file");
    if (state.kind !== "bound" || request.sessionId !== state.nativeSessionId || !turn || turn.controller.signal.aborted
      || controller.signal.aborted || sandbox.state.kind !== "ready") throw new SandboxAcpFileError("inactive_scope");
    if (pending.size >= transportLimits.maxInboundRequestConcurrency) throw new SandboxAcpFileError("capacity");
    const owner = turn;
    const signal = AbortSignal.any([context.signal, controller.signal, owner.controller.signal]);
    pending.set(context.settled, owner);
    const retired = () => { pending.delete(context.settled); };
    void context.settled.then(retired, retired);
    const operation = queue.then(() => perform(context, request, signal));
    queue = operation.then(() => {}, () => {});
    return operation;
  };

  return Object.freeze({
    capabilities: Object.freeze({ fs: Object.freeze({ readTextFile: true, writeTextFile: grant === "read_write" }), terminal: false }),
    handlers: Object.freeze({ "fs/read_text_file": handle, "fs/write_text_file": handle }),
    transportLimits,
    bindSession(nativeSessionId: string) {
      if (state.kind !== "unbound" || sandbox.state.kind !== "ready" || !nativeSessionId || !nativeSessionId.isWellFormed()
        || Buffer.byteLength(nativeSessionId) > transportLimits.maxInboundFrameBytes) throw new SandboxAcpFileError("inactive_scope");
      state = Object.freeze({ kind: "bound", nativeSessionId });
      return Object.freeze({
        close,
        openTurn(): SandboxAcpTurnLease {
          if (state.kind !== "bound" || turn || controller.signal.aborted || sandbox.state.kind !== "ready") throw new SandboxAcpFileError("inactive_scope");
          const owned: Turn = { controller: new AbortController() };
          turn = owned;
          return Object.freeze({
            signal: owned.controller.signal,
            close(): Promise<void> {
              owned.controller.abort(new SandboxAcpFileError("inactive_scope"));
              owned.closing ??= join(owned).finally(() => { if (turn === owned) turn = undefined; });
              return owned.closing;
            },
          });
        },
      });
    },
    revoke,
    close,
  });
}
