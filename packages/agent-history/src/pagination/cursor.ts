import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import { AgentHistoryError } from '../lifecycle/errors.js';

const MAX_CURSOR_BYTES = 65_536;
const cursorSchema = z.strictObject({
  version: z.literal(1),
  source: z.strictObject({ providerKey: z.string().max(100), sourceId: z.string().max(128), generation: z.string().max(128) }),
  operation: z.enum(['catalog', 'transcript', 'views', 'metadataSearch', 'contentSearch']),
  query: z.string().regex(/^[a-f0-9]{64}$/u),
  native: z.string().min(1).max(32_768),
});

type CursorScope = Omit<z.infer<typeof cursorSchema>, 'version' | 'native'>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function queryDigest(input: object): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export interface HistoryCursorCodec {
  encode(scope: CursorScope, native: string): string;
  decode(scope: CursorScope, encoded: string): string;
}

export function createCursorCodec(): HistoryCursorCodec {
  const key = randomBytes(32);
  const seal = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return {
    encode(scope, native) {
      const parsed = cursorSchema.safeParse({ version: 1, ...scope, native });
      if (!parsed.success) throw new AgentHistoryError('limit_exhausted', 'The native continuation exceeds the supported cursor envelope.');
      const payload = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
      const encoded = `${payload}.${seal(payload).toString('base64url')}`;
      if (encoded.length > MAX_CURSOR_BYTES) throw new AgentHistoryError('limit_exhausted', 'The native continuation exceeds the supported cursor envelope.');
      return encoded;
    },
    decode(scope, encoded) {
      const invalid = () => new AgentHistoryError('invalid_cursor', 'History continuation does not match this source instance, operation and query.');
      if (encoded.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(encoded)) throw invalid();
      const [payload, signature] = encoded.split('.');
      if (payload === undefined || signature === undefined) throw invalid();
      const supplied = Buffer.from(signature, 'base64url');
      const expected = seal(payload);
      if (supplied.length !== expected.length || supplied.toString('base64url') !== signature || !timingSafeEqual(supplied, expected)) throw invalid();
      let value: unknown;
      try {
        const buffer = Buffer.from(payload, 'base64url');
        if (buffer.toString('base64url') !== payload) throw invalid();
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      } catch { throw invalid(); }
      const parsed = cursorSchema.safeParse(value);
      if (!parsed.success) throw invalid();
      const { version: _version, native, ...actual } = parsed.data;
      if (queryDigest(actual) !== queryDigest(scope)) throw invalid();
      return native;
    },
  };
}
