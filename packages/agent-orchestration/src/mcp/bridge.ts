// ------------------------------------------------------------------------------------------------
//                bridge.ts - Explicit loopback MCP startup and retained producer cleanup
// ------------------------------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { validateAgentSessionHostBinding, type AgentHostToolResult } from "@agen-ai/agent-runtime";
import { DelegationOperationError } from "../shared/operational-errors.js";
import { authorizeRequest, McpHttpError, readRequestBody, webRequest, writeError, writeResponse } from "./http.js";
import { MCP_HEADER_BYTES, MCP_MAX_CONNECTIONS, MCP_MAX_HTTP_REQUESTS, MCP_RECEIPT_TIMEOUT_MS, requestTimeout, shutdownTimeout } from "./limits.js";
import { createMcpProtocol, mcpTools } from "./protocol.js";
import type { DelegationMcpBridge, StartDelegationMcpBridgeOptions } from "./types.js";

const activeBindings = new WeakSet<object>();

function aborted(): DOMException { return new DOMException("The MCP transport operation was canceled.", "AbortError"); }

async function untilAborted<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      cancel = () => reject(aborted());
      signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally { if (cancel) signal.removeEventListener("abort", cancel); }
}

async function withinDeadline<Value>(pending: Promise<Value>, deadline: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DelegationOperationError("recovery_required",
        "MCP producers have not quiesced; transport cleanup responsibility is retained.")), Math.max(1, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function requestKey(value: unknown): string | undefined {
  if (typeof value === "string" && Buffer.byteLength(value) <= 128) return `string:${value}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `number:${value}`;
  return undefined;
}

/** Starts one scoped listener. Pure runtime validation does not claim or release the supplied binding. */
export async function startDelegationMcpBridge(options: StartDelegationMcpBridgeOptions): Promise<DelegationMcpBridge> {
  const originalBinding = options.binding;
  const startupSignal = options.signal;
  startupSignal?.throwIfAborted();
  const timeoutMs = shutdownTimeout(options.shutdownTimeoutMs);
  const responseTimeoutMs = requestTimeout(options.requestTimeoutMs);
  const binding = validateAgentSessionHostBinding({ binding: originalBinding, support: {
    kind: "supported", toolTransport: "mcp", instructionPlacements: ["tool_context"],
  } });
  const tools = mcpTools(binding);
  const authorization = Buffer.from(`Bearer ${randomBytes(32).toString("base64url")}`);
  const lifetime = new AbortController();
  const requests = new Set<Promise<void>>();
  const calls = new Set<Promise<AgentHostToolResult>>();
  const sockets = new Set<Socket>();
  const controllers = new Map<string, AbortController>();
  const protocols = new Set<ReturnType<typeof createMcpProtocol>>();
  let accepting = true;
  let released = false;
  let releasing: Promise<void> | undefined;
  let listenerClose: Promise<void> | undefined;
  let host = "";
  let url = "";

  const assertAccepting = () => { if (!accepting) throw new McpHttpError(503); };
  const cancelRequest = (requestId: string | number) => {
    const key = requestKey(requestId);
    if (key !== undefined) controllers.get(key)?.abort(aborted());
  };
  const stopAdmission = () => {
    accepting = false;
    lifetime.abort(aborted());
    for (const socket of sockets) socket.destroy();
  };
  const closeProtocol = async (entry: ReturnType<typeof createMcpProtocol>) => {
    try { await entry.protocol.close(); protocols.delete(entry); }
    catch {
      stopAdmission();
      throw new DelegationOperationError("recovery_required", "MCP protocol cleanup is incomplete; cleanup responsibility is retained.");
    }
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const stop = () => controller.abort(aborted());
    const disconnect = () => { if (!response.writableEnded) stop(); };
    const destroy = () => { request.destroy(); response.destroy(); };
    request.once("aborted", stop);
    response.once("close", disconnect);
    signal.addEventListener("abort", destroy, { once: true });
    let timer = setTimeout(stop, MCP_RECEIPT_TIMEOUT_MS);
    let entry: ReturnType<typeof createMcpProtocol> | undefined;
    let key: string | undefined;
    try {
      assertAccepting();
      authorizeRequest(request, host, authorization);
      const body = await readRequestBody(request) as Record<string, unknown>;
      clearTimeout(timer);
      timer = setTimeout(stop, responseTimeoutMs);
      request.socket.setTimeout(responseTimeoutMs);
      signal.throwIfAborted();
      if (Object.hasOwn(body, "id")) {
        key = requestKey(body.id);
        if (key === undefined) throw new McpHttpError(400);
        if (controllers.has(key)) throw new McpHttpError(409);
        controllers.set(key, controller);
      }
      entry = createMcpProtocol({ binding, signal, calls, assertAccepting, cancelRequest }, tools);
      protocols.add(entry);
      await entry.protocol.connect(entry.transport);
      const result = await untilAborted(entry.transport.handleRequest(webRequest(request, url), { parsedBody: body }), signal);
      await writeResponse(response, result);
    } catch (error) { writeError(response, error instanceof McpHttpError ? error.status : signal.aborted ? 408 : 400); }
    finally {
      clearTimeout(timer);
      request.removeListener("aborted", stop);
      response.removeListener("close", disconnect);
      signal.removeEventListener("abort", destroy);
      if (key !== undefined && controllers.get(key) === controller) controllers.delete(key);
      if (entry) await closeProtocol(entry);
    }
  };

  const listener = createServer({ maxHeaderSize: MCP_HEADER_BYTES, requestTimeout: MCP_RECEIPT_TIMEOUT_MS,
    headersTimeout: MCP_RECEIPT_TIMEOUT_MS, connectionsCheckingInterval: 1_000, keepAliveTimeout: 1_000 }, (request, response) => {
    if (!accepting || requests.size >= MCP_MAX_HTTP_REQUESTS) { writeError(response, accepting ? 429 : 503); return; }
    const pending = serve(request, response).catch(() => { writeError(response, 500); })
      .finally(() => { requests.delete(pending); });
    requests.add(pending);
  });
  listener.maxConnections = MCP_MAX_CONNECTIONS;
  listener.on("error", stopAdmission);
  listener.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
    socket.setTimeout(MCP_RECEIPT_TIMEOUT_MS, () => { socket.destroy(); });
  });

  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    if (releasing) return releasing;
    stopAdmission();
    if (!listenerClose) listenerClose = new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")) reject(error); else resolve();
      });
    });
    const deadline = Date.now() + timeoutMs;
    releasing = Promise.resolve().then(async () => {
      await withinDeadline(Promise.allSettled([...requests, ...calls]), deadline);
      const closed = await withinDeadline(Promise.allSettled([listenerClose!, ...[...protocols].map(closeProtocol)]), deadline);
      if (calls.size !== 0 || requests.size !== 0 || protocols.size !== 0 || closed.some((result) => result.status === "rejected")) {
        throw new DelegationOperationError("recovery_required", "MCP transport cleanup is incomplete; the binding owner must retain its lease.");
      }
      released = true;
      activeBindings.delete(originalBinding);
    }).finally(() => { releasing = undefined; });
    return releasing;
  };

  startupSignal?.throwIfAborted();
  if (activeBindings.has(originalBinding)) throw new TypeError("This host binding already has an active MCP transport.");
  activeBindings.add(originalBinding);
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => { listener.removeListener("listening", opened); reject(new TypeError("The loopback MCP listener could not start.")); };
      const opened = () => { listener.removeListener("error", failed); resolve(); };
      listener.once("error", failed);
      listener.once("listening", opened);
      listener.listen(0, "127.0.0.1");
    });
    startupSignal?.throwIfAborted();
    const address = listener.address();
    if (!address || typeof address === "string") throw new TypeError("The loopback MCP listener has no address.");
    host = `127.0.0.1:${address.port}`;
    url = `http://${host}/mcp`;
  } catch (error) { await release(); throw error; }
  return Object.freeze({ server: Object.freeze({ name: "agenai_delegation", url,
    headers: Object.freeze({ Authorization: authorization.toString() }) }), release });
}
