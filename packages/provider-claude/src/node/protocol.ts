// ------------------------------------------------------------------------------------------------
//                protocol.ts - Closed bounded JSON-lines protocol between the driver and its SDK worker
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

export const WORKER_PROTOCOL = 'agenai.claude.worker.v4';
export const PROMPT_CHARACTERS = 131_072;
// A prompt can require six JSON bytes per UTF-16 code unit, plus its envelope. Results fit here too.
export const LINE_BYTES = 1_048_576;
// Fits two maximum 8-MiB edit strings even with six-byte JSON escapes; also the shared pending-call budget.
export const TOOL_CALL_BYTES = 128 * 1_048_576;
export const MCP_SERVER = 'agenai';

const text = (max: number) => z.string().max(max);
const callId = z.string().regex(/^call-[0-9]{1,9}$/u);

export const configureMessage = z.strictObject({
  type: z.literal('configure'),
  protocol: z.literal(WORKER_PROTOCOL),
  sdkEntry: text(4_096).startsWith('file:///'),
  executable: text(4_096),
  cwd: text(4_096),
  model: text(256),
  maxTurns: z.number().int().min(1).max(1_000),
  maxBudgetUsd: z.number().positive().max(1_000).optional(),
  environment: z.record(text(64).regex(/^[A-Z][A-Z0-9_]*$/u), text(4_096)),
  tools: z.array(z.strictObject({ name: text(64), description: text(1_024), inputSchema: z.record(z.string(), z.unknown()) })).min(1).max(16),
});
export type ConfigureMessage = z.output<typeof configureMessage>;

export const driverMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('prompt'), text: text(PROMPT_CHARACTERS).min(1) }),
  z.strictObject({ type: z.literal('tool_result'), callId, text: text(70_000), isError: z.boolean() }),
  z.strictObject({ type: z.literal('interrupt') }),
  z.strictObject({ type: z.literal('close') }),
]);
export type DriverMessage = z.output<typeof driverMessage>;

const exit = z.strictObject({ code: z.number().int().nullable(), signal: text(32).nullable() });

/** At most this many `modelUsage` entries cross the wire; `entries` reports how many Claude sent. */
export const MODEL_USAGE_ROWS = 8;
/**
 * A native token field: its value, `null` when Claude omitted it, or `invalid` for any other value.
 * JSON alone would turn a non-finite number into `null` and so into a missing field.
 */
const nativeCount = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.null(), z.literal('invalid')]);
const nativeCounters = {
  input: nativeCount, cacheRead: nativeCount, cacheCreation: nativeCount, cache5m: nativeCount, cache1h: nativeCount, output: nativeCount,
};
export const nativeTurnUsage = z.union([z.strictObject(nativeCounters), z.null(), z.literal('invalid')]);
export const nativeModelUsage = z.union([
  z.strictObject({
    entries: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    models: z.array(z.strictObject({ model: text(256), ...nativeCounters })).max(MODEL_USAGE_ROWS),
  }),
  z.null(),
  z.literal('invalid'),
]);
export type NativeCount = z.output<typeof nativeCount>;
export type NativeTurnUsage = z.output<typeof nativeTurnUsage>;
export type NativeModelUsage = z.output<typeof nativeModelUsage>;

export const workerMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), tools: z.array(text(128)).max(64), claudeCodeVersion: text(64).nullable() }),
  z.strictObject({ type: z.literal('init'), tools: z.array(text(128)).max(256), model: text(256), permissionMode: text(64), claudeCodeVersion: text(64) }),
  /** A native status reporting a permission mode; statuses without one carry no permission change. */
  z.strictObject({ type: z.literal('status'), permissionMode: text(64) }),
  /** The model Claude moved to after a refusal. */
  z.strictObject({ type: z.literal('model_fallback'), model: text(256) }),
  z.strictObject({ type: z.literal('tool_call'), callId, tool: text(64), input: z.unknown(), nativeRef: text(128).nullable() }),
  z.strictObject({ type: z.literal('assistant_text'), text: text(65_536), complete: z.boolean() }),
  z.strictObject({ type: z.literal('residual'), tool: text(128) }),
  /** `usage` is the main loop's per-turn usage, `modelUsage` the query's cumulative per-model usage. */
  z.strictObject({
    type: z.literal('result'), subtype: text(64), isError: z.boolean(), denials: z.array(text(128)).max(64),
    resultIndex: nativeCount, usage: nativeTurnUsage, modelUsage: nativeModelUsage,
  }),
  z.strictObject({ type: z.literal('failed'), stage: z.enum(['startup', 'runtime']), message: text(1_000) }),
  z.strictObject({ type: z.literal('closed'), children: z.array(exit).max(8) }),
]);
export type WorkerMessage = z.output<typeof workerMessage>;

/** Encodes one message as a bounded line; an oversize message is a local defect, never truncated. */
export function encodeLine(message: unknown, maxBytes = LINE_BYTES): string {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line) > maxBytes) throw new RangeError('Worker protocol line exceeds its byte bound.');
  return line;
}

/**
 * Splits a byte stream into bounded lines. An oversize line, invalid UTF-8 or a partial trailing
 * line fails the stream instead of buffering or guessing.
 */
export async function* boundedLines(stream: AsyncIterable<unknown>, maxBytes = LINE_BYTES): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Worker protocol stream produced a non-byte chunk.');
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, index);
      if (pendingBytes + part.byteLength > maxBytes) throw new RangeError('Worker protocol line exceeds its byte bound.');
      yield decoder.decode(Buffer.concat([...pending, part]));
      pending = [];
      pendingBytes = 0;
      start = index + 1;
    }
    const rest = chunk.subarray(start);
    pendingBytes += rest.byteLength;
    if (pendingBytes > maxBytes) throw new RangeError('Worker protocol line exceeds its byte bound.');
    if (rest.byteLength) pending.push(Buffer.from(rest));
  }
  if (pendingBytes) throw new TypeError('Worker protocol stream ended inside a line.');
}

export function parseLine<Schema extends z.ZodType>(schema: Schema, line: string): z.output<Schema> {
  let value: unknown;
  try { value = JSON.parse(line); } catch (cause) { throw new TypeError('Worker protocol line is not JSON.', { cause }); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError('Worker protocol message is outside its closed contract.', { cause: parsed.error });
  return parsed.data;
}
