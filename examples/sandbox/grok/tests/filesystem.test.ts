import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { SandboxAcpFileError } from "../index.js";
import { budgets, fixture, gate } from "./fixture.js";
import { nativeAvailableCommandsUpdate, nativeInitializeRequest, nativeInitializeResponse,
  nativeNewSessionRequest, nativeNewSessionResponse } from "./native-session.js";
import { nativeCollidingRead, nativePendingPrompt } from "./native-collision.js";

const rejected = { code: -32602, message: "Sandbox file request rejected." };
const bounded = { timeout: 5000 };

test("native numeric request IDs coexist with the fifth pending host prompt without a direction collision", bounded, async (t) => {
  const example = fixture();
  t.after(() => example.close());
  const session = example.files.bindSession("01a17339-c05e-7253-8a40-e81adac87346");
  example.contents.set("native/seed.txt", Buffer.from("owned guest bytes"));
  // Four synthetic completed turns advance the host sequence; the concurrent request payloads below are retained native frames.
  for (let index = 0; index < 4; index++) {
    const turn = session.openTurn();
    const prompt = example.client.request(nativePendingPrompt.method, nativePendingPrompt.params ?? {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const dispatched = example.frames.at(-1)?.message;
    assert.ok(dispatched && "id" in dispatched);
    example.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: dispatched.id, result: { stopReason: "end_turn" } })}\n`);
    assert.deepEqual(await prompt, { stopReason: "end_turn" });
    await turn.close();
  }
  const turn = session.openTurn();
  const prompt = example.client.request(nativePendingPrompt.method, nativePendingPrompt.params ?? {})
    .then((result) => ({ result }), (error: unknown) => ({ error }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const response = await Promise.race([
    example.send(nativeCollidingRead.method, nativeCollidingRead.params ?? {}, nativeCollidingRead.id).then((frame) => ({ kind: "response" as const, frame })),
    example.client.closed.then((closed) => ({ kind: "closed" as const, closed })),
  ]);
  if (response.kind === "closed") {
    const error = response.closed.error;
    assert.fail(`Native callback rejected while the host prompt remained pending: ${error && "reasonCode" in error ? error.reasonCode : response.closed.kind}`);
  }
  assert.deepEqual(response.frame, { jsonrpc: "2.0", id: 5, result: { content: "owned guest bytes" } });
  assert.deepEqual(example.frames.filter(({ message }) => "method" in message).at(-1)?.message,
    { ...nativePendingPrompt, id: "sandbox-grok:5" });
  // This synthetic completion echoes the actual host ID; the native callback's numeric ID remains unchanged.
  example.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "sandbox-grok:5", result: { stopReason: "end_turn" } })}\n`);
  assert.deepEqual(await prompt, { result: { stopReason: "end_turn" } });
  assert.deepEqual(example.accesses, [{ kind: "read", path: "native/seed.txt" }]);
  await turn.close();
});

test("Grok 1.0.62 retained session replay delivers its complete native catalog and preserves configuration roundtrips", bounded, async (t) => {
  const example = fixture();
  t.after(() => example.close());
  const initialized = example.client.request(nativeInitializeRequest.method, nativeInitializeRequest.params ?? {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(example.frames.at(-1)?.message, { ...nativeInitializeRequest, id: "sandbox-grok:1" });
  // Counterfactual peer replies echo the actual host ID; all retained native result fields remain unchanged.
  example.stdout.write(`${JSON.stringify({ ...nativeInitializeResponse, id: "sandbox-grok:1" })}\n`);
  assert.ok("result" in nativeInitializeResponse);
  assert.deepEqual(await initialized, nativeInitializeResponse.result);

  const created = example.client.request(nativeNewSessionRequest.method, nativeNewSessionRequest.params ?? {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(example.frames.at(-1)?.message, { ...nativeNewSessionRequest, id: "sandbox-grok:2" });
  example.stdout.write(`${JSON.stringify({ ...nativeNewSessionResponse, id: "sandbox-grok:2" })}\n`);
  assert.ok("result" in nativeNewSessionResponse);
  assert.deepEqual(await created, nativeNewSessionResponse.result);
  example.stdout.write(`${JSON.stringify(nativeAvailableCommandsUpdate)}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(example.updates, [{ method: "session/update", params: nativeAvailableCommandsUpdate.params }]);

  // r1 stopped before configuration; this ACK is an explicit synthetic continuation, not native evidence.
  const params = { sessionId: "01a1732d-cfc5-7110-b6b6-edbca11b5ec6", configId: "reasoning_effort", value: "low" };
  const configured = example.client.request("session/set_config_option", params);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(example.frames.at(-1)?.message, { jsonrpc: "2.0", id: "sandbox-grok:3", method: "session/set_config_option", params });
  const result = { configOptions: [{ id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select",
    currentValue: "low", options: [{ value: "low", name: "Low" }] }] };
  example.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "sandbox-grok:3", result })}\n`);
  assert.deepEqual(await configured, result);
});

test("custom ACP composition reads exact strict UTF-8 ranges across byte chunks", bounded, async (t) => {
  const example = fixture();
  t.after(() => example.close());
  example.contents.set("seed.txt", Buffer.from("\uFEFFα\r\n\r\nβ\nlast\n"));
  const session = example.files.bindSession("native-session");
  const turn = session.openTurn();
  const cases = [
    { range: {}, content: "\uFEFFα\r\n\r\nβ\nlast\n" },
    { range: { line: 2, limit: 2 }, content: "\r\nβ" },
    { range: { line: 3, limit: 1 }, content: "β" },
    { range: { line: 4 }, content: "last\n" },
    { range: { line: 5, limit: 1 }, content: "" },
    { range: { line: 100 }, content: "" },
    { range: { limit: 0 }, content: "" },
  ];
  for (const [index, scenario] of cases.entries()) {
    assert.deepEqual(await example.read(undefined, scenario.range, index + 1), { jsonrpc: "2.0", id: index + 1, result: { content: scenario.content } });
  }
  for (const content of [Uint8Array.of(0xc3, 0x28), Uint8Array.of(0x61, 0x0a, 0xc3)]) {
    example.contents.set("seed.txt", content);
    const id = `invalid-${content.byteLength}`;
    assert.deepEqual(await example.read(undefined, { line: 1, limit: 1 }, id), { jsonrpc: "2.0", id, error: rejected });
  }
  example.contents.set("seed.txt", Buffer.from("valid"));
  assert.deepEqual(await example.read(undefined, { line: 0 }, "line-zero"), { jsonrpc: "2.0", id: "line-zero", error: rejected });
  assert.deepEqual(await example.read(undefined, {}, "valid-after"), { jsonrpc: "2.0", id: "valid-after", result: { content: "valid" } });
  await turn.close();
});

test("native session, turn, grant, guest path and finalization gates precede file dispatch", bounded, async (t) => {
  const example = fixture({ grant: "read_only" });
  t.after(() => example.close());
  example.contents.set("seed.txt", Buffer.from("original"));
  assert.deepEqual(await example.read(undefined, {}, "unbound"), { jsonrpc: "2.0", id: "unbound", error: rejected });
  const session = example.files.bindSession("native-session");
  assert.deepEqual(await example.read(undefined, {}, "no-turn"), { jsonrpc: "2.0", id: "no-turn", error: rejected });
  const turn = session.openTurn();
  const denied = [
    ["foreign", "fs/read_text_file", { sessionId: "foreign-session", path: "/workspace/work/seed.txt" }],
    ["write", "fs/write_text_file", { sessionId: "native-session", path: "/workspace/work/seed.txt", content: "replacement" }],
    ...["/etc/passwd", "/workspace/worker/seed.txt", "/workspace/work", "/workspace/work/../seed.txt", "/workspace/work/a//seed.txt", "/workspace/work/link/../seed.txt"]
      .map((path, index) => [`path-${index}`, "fs/read_text_file", { sessionId: "native-session", path }] as const),
  ] as const;
  for (const [id, method, params] of denied) assert.deepEqual(await example.send(method, params, id), { jsonrpc: "2.0", id, error: rejected });
  assert.deepEqual(example.accesses, []);
  assert.deepEqual(await example.read(undefined, {}, "allowed"), { jsonrpc: "2.0", id: "allowed", result: { content: "original" } });
  await turn.close();
  assert.deepEqual(await example.read(undefined, {}, "retired-turn"), { jsonrpc: "2.0", id: "retired-turn", error: rejected });
  const nextTurn = session.openTurn();
  assert.deepEqual(await example.read(undefined, {}, "next-turn"), { jsonrpc: "2.0", id: "next-turn", result: { content: "original" } });
  await nextTurn.close();
  await session.close();
  assert.throws(() => example.files.bindSession("another-session"), SandboxAcpFileError);
  assert.throws(() => session.openTurn(), SandboxAcpFileError);
  assert.deepEqual(await example.read(undefined, {}, "closed"), { jsonrpc: "2.0", id: "closed", error: rejected });
  assert.equal(Buffer.from(example.contents.get("seed.txt") ?? []).toString(), "original");
  assert.deepEqual(example.accesses, [{ kind: "read", path: "seed.txt" }, { kind: "read", path: "seed.txt" }]);
});

test("complete serialized response with escaped text and exact request ID fits at the frame boundary", bounded, async (t) => {
  const example = fixture();
  t.after(() => example.close());
  const session = example.files.bindSession("native-session");
  const turn = session.openTurn();
  const id = 'quoted-"\\';
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result: { content: "" } }));
  const escaped = '"\\\t';
  const content = escaped + "x".repeat(1024 - emptyEnvelopeBytes - 6);
  example.contents.set("seed.txt", Buffer.from(content));
  assert.deepEqual(await example.read(undefined, {}, id), { jsonrpc: "2.0", id, result: { content } });
  assert.equal(Buffer.byteLength(example.frames.at(-1)?.raw ?? ""), 1025);
  example.contents.set("seed.txt", Buffer.from(`${content}x`));
  assert.deepEqual(await example.read(undefined, {}, "same-len-id"), { jsonrpc: "2.0", id: "same-len-id", error: rejected });
  assert.deepEqual(await example.read(undefined, { limit: 0 }, "still-open"), { jsonrpc: "2.0", id: "still-open", result: { content: "" } });
  await turn.close();
});

test("full-file scan budget covers bytes outside a selected range and UTF8 writes retain exact bounded chunks", bounded, async (t) => {
  const example = fixture({ budgets: { ...budgets, maxReadBytes: 8, maxWriteBytes: 2048 } });
  t.after(() => example.close());
  const session = example.files.bindSession("native-session");
  const turn = session.openTurn();
  example.contents.set("seed.txt", Buffer.from("first\nsecond\n"));
  assert.deepEqual(await example.read(undefined, { limit: 1 }, "scan"), { jsonrpc: "2.0", id: "scan", error: rejected });
  assert.deepEqual(await example.write("α".repeat(600), undefined, "write"), { jsonrpc: "2.0", id: "write", result: {} });
  assert.deepEqual(example.writeChunks, [512, 512, 176]);
  assert.deepEqual(example.contents.get("seed.txt"), Buffer.from("α".repeat(600)));
  assert.deepEqual(await example.write("\uD800", undefined, "surrogate"), { jsonrpc: "2.0", id: "surrogate", error: rejected });
  assert.deepEqual(await example.write("x".repeat(2049), undefined, "oversize"), { jsonrpc: "2.0", id: "oversize", error: rejected });
  assert.deepEqual(example.accesses, [{ kind: "read", path: "seed.txt" }, { kind: "write", path: "seed.txt" }]);
  await turn.close();
});

test("turn revocation aborts entered work, drains responses and fences queued dispatch before a later turn", bounded, async (t) => {
  const entered = gate();
  const released = gate();
  let readSignal: AbortSignal | undefined;
  const example = fixture({ async beforeRead(signal) { readSignal = signal; entered.resolve(); await released.promise; } });
  t.after(() => example.close());
  example.contents.set("seed.txt", Buffer.from("payload"));
  const session = example.files.bindSession("native-session");
  const turn = session.openTurn();
  const first = example.read(undefined, {}, "entered");
  const queued = example.write("must-not-publish", undefined, "queued");
  await entered.promise;
  let closed = false;
  const closing = turn.close().then(() => { closed = true; });
  assert.equal(readSignal?.aborted, true);
  assert.throws(() => session.openTurn(), SandboxAcpFileError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.deepEqual(example.accesses, [{ kind: "read", path: "seed.txt" }]);
  released.resolve();
  assert.deepEqual(await first, { jsonrpc: "2.0", id: "entered", error: rejected });
  assert.deepEqual(await queued, { jsonrpc: "2.0", id: "queued", error: rejected });
  await closing;
  assert.equal(closed, true);
  assert.equal(Buffer.from(example.contents.get("seed.txt") ?? []).toString(), "payload");
  const next = session.openTurn();
  assert.deepEqual(await example.write("next", undefined, "next"), { jsonrpc: "2.0", id: "next", result: {} });
  await next.close();
});

test("published write racing revocation retains its factual receipt and never reports a clean ACK", bounded, async () => {
  const entered = gate();
  const released = gate();
  const example = fixture({ async afterWrite(bytes) {
    entered.resolve(); await released.promise;
    return { kind: "completed", effect: "published", bytes, permissions: 0o644 };
  } });
  const turn = example.files.bindSession("native-session").openTurn();
  const response = example.write("published", undefined, "race");
  await entered.promise;
  const closing = assert.rejects(turn.close(), (error: unknown) => error instanceof SandboxAcpFileError
    && error.writeObservation?.kind === "completed" && error.writeObservation.effect === "published" && error.writeObservation.bytes === 9n);
  released.resolve();
  assert.deepEqual(await response, { jsonrpc: "2.0", id: "race", error: rejected });
  await closing;
  assert.deepEqual(example.contents.get("seed.txt"), Buffer.from("published"));
  assert.deepEqual(await example.write("replay", undefined, "fenced"), { jsonrpc: "2.0", id: "fenced", error: rejected });
  await assert.rejects(example.close(), AggregateError);
  assert.deepEqual(example.sandbox.state, { kind: "stopped" });
});

test("unknown publication fences the scope without replay and preserves the unknown byte receipt", bounded, async () => {
  const example = fixture({ async afterWrite() { return { kind: "uncertain", effect: "unknown", bytes: null }; } });
  example.files.bindSession("native-session").openTurn();
  assert.deepEqual(await example.write("possibly-published", undefined, "uncertain"), { jsonrpc: "2.0", id: "uncertain", error: rejected });
  await assert.rejects(example.files.close(), (error: unknown) => error instanceof SandboxAcpFileError
    && error.writeObservation?.kind === "uncertain" && error.writeObservation.effect === "unknown" && error.writeObservation.bytes === null);
  assert.deepEqual(await example.write("do-not-replay", undefined, "replay"), { jsonrpc: "2.0", id: "replay", error: rejected });
  assert.deepEqual(example.accesses, [{ kind: "write", path: "seed.txt" }]);
  assert.deepEqual(example.contents.get("seed.txt"), Buffer.from("possibly-published"));
  await assert.rejects(example.close(), AggregateError);
  assert.deepEqual(example.sandbox.state, { kind: "stopped" });
});

test("overlong request IDs reject at transport admission before a guest file is read", bounded, async (t) => {
  const example = fixture();
  t.after(() => example.close());
  example.contents.set("seed.txt", Buffer.from("payload"));
  example.files.bindSession("native-session").openTurn();
  assert.deepEqual(await example.read(undefined, {}, "valid-id"), { jsonrpc: "2.0", id: "valid-id", result: { content: "payload" } });
  example.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(budgets.maxRequestIdBytes + 1), method: "fs/read_text_file",
    params: { sessionId: "native-session", path: "/workspace/work/seed.txt" } })}\n`);
  const closed = await example.client.closed;
  assert.equal(closed.kind, "fatal");
  assert.equal(closed.error && "reasonCode" in closed.error && closed.error.reasonCode, "acp_request_id_invalid");
  assert.deepEqual(example.accesses, [{ kind: "read", path: "seed.txt" }]);
});

test("turn cleanup waits for the actual bounded response write after the file callback has settled", bounded, async () => {
  const written = gate();
  let finishWrite: (() => void) | undefined;
  const stdin = new Writable({ write(_chunk, _encoding, callback) { finishWrite = callback; written.resolve(); } });
  const example = fixture({ stdin });
  example.contents.set("seed.txt", Buffer.from("payload"));
  const session = example.files.bindSession("native-session");
  const turn = session.openTurn();
  example.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "held", method: "fs/read_text_file", params: { sessionId: "native-session", path: "/workspace/work/seed.txt" } })}\n`);
  await written.promise;
  let closed = false;
  const closing = turn.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => session.openTurn(), SandboxAcpFileError);
  assert.equal(typeof finishWrite, "function");
  finishWrite?.();
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(example.accesses, [{ kind: "read", path: "seed.txt" }]);
  await example.close();
});
