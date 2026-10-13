// ------------------------------------------------------------------------------------------------
//                http.ts - Bounded authenticated loopback HTTP request handling
// ------------------------------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_REQUEST_BYTES, MCP_RESPONSE_BYTES } from "./limits.js";

export class McpHttpError extends Error {
  constructor(readonly status: number) { super("The MCP HTTP request is unavailable."); }
}

export function authorizeRequest(request: IncomingMessage, expectedHost: string, authorization: Buffer): void {
  if (request.headers.host !== expectedHost || request.headers.origin !== undefined) throw new McpHttpError(403);
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string") throw new McpHttpError(401);
  const encoded = Buffer.from(supplied);
  if (encoded.length !== authorization.length || !timingSafeEqual(encoded, authorization)) throw new McpHttpError(401);
  if (request.url !== "/mcp") throw new McpHttpError(404);
  if (request.method !== "POST") throw new McpHttpError(405);
  if (request.headers["content-encoding"] !== undefined) throw new McpHttpError(415);
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MCP_REQUEST_BYTES)) throw new McpHttpError(413);
}

export async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MCP_REQUEST_BYTES) throw new McpHttpError(413);
    chunks.push(buffer);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw new McpHttpError(400); }
  // One JSON-RPC message per HTTP request bounds protocol producers and response envelopes.
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new McpHttpError(400);
  return body;
}

export function webRequest(request: IncomingMessage, url: string): Request {
  const headers = new Headers();
  // Authentication is enforced locally and is never forwarded to SDK diagnostics or callbacks.
  for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(url, { method: "POST", headers });
}

export async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const body = Buffer.from(await result.arrayBuffer());
  if (body.length > MCP_RESPONSE_BYTES) throw new McpHttpError(500);
  if (response.destroyed) return;
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", body.length);
  response.end(body);
}

export function writeError(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("connection", "close");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json");
  if (status === 405) response.setHeader("allow", "POST");
  response.end('{"error":"The MCP request is unavailable."}');
}
