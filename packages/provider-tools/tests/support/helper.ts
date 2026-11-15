import { PassThrough } from 'node:stream';
import { createNodeFilesystemHelperClient } from '@agen-ai/sandbox-docker/node';
import type { HelperProcess } from '../../src/node/helper.js';

const OPERATIONS = ['', 'stat', 'read', 'list', 'next', 'write', 'append', 'commit', 'cancel', 'close', 'heartbeat'];
const READY = { protocol: 'agenai.sandbox.filesystem.v1', layout: 'agenai.sandbox.workspace.v1', uid: 1000, gid: 1000 };

type Node = Readonly<{ kind: 'file'; bytes: Buffer }> | Readonly<{ kind: 'directory' }> | Readonly<{ kind: 'symlink' }>;
type Reply = Readonly<{ kind: number; body?: unknown }>;
export type CommitScript = 'complete' | 'changed' | 'published_uncertain' | 'lost';

const terminal = (status: string, effect: string, count: bigint | number, mode: number | null = null, entry: unknown = null): Reply =>
  ({ kind: 3, body: { status, effect, errno: 0, count: String(count), mode, entry } });
const rejected = (errno: number): Reply => ({ kind: 3, body: { status: 'rejected', effect: 'none', errno, count: '0', mode: null, entry: null } });

/**
 * An in-memory helper speaking the real wire protocol, so the production client parses every
 * receipt. Commit outcomes can be scripted per path to reach publication races deterministically.
 */
export function memoryHelper(initial: Readonly<Record<string, string | 'directory' | 'symlink'>>, commits: Readonly<Record<string, CommitScript>> = {}) {
  const tree = new Map<string, Node>([['.', { kind: 'directory' }]]);
  for (const [path, value] of Object.entries(initial)) {
    tree.set(path, value === 'directory' ? { kind: 'directory' } : value === 'symlink' ? { kind: 'symlink' } : { kind: 'file', bytes: Buffer.from(value) });
  }
  const input = new PassThrough();
  const output = new PassThrough();
  const operations: string[] = [];
  let cursor: { kind: 'read'; bytes: Buffer; offset: number } | { kind: 'list'; names: string[]; index: number; parent: string } | undefined;
  let staging: { path: string; mode: number; bytes: Buffer[] } | undefined;
  let buffered = Buffer.alloc(0);
  const send = (reply: Reply) => {
    const body = reply.body === undefined ? Buffer.alloc(0) : reply.kind === 1 ? reply.body as Buffer : Buffer.from(JSON.stringify(reply.body));
    const header = Buffer.alloc(8);
    header.writeUInt32BE(reply.kind, 0);
    header.writeUInt32BE(body.length, 4);
    output.write(Buffer.concat([header, body]));
  };
  const metadata = (node: Node) => ({ kind: node.kind, byteLength: node.kind === 'file' ? node.bytes.length : 0, mode: 0o644 });
  const answer = (operation: string, flags: number, path: string, data: Buffer): readonly Reply[] | 'end' => {
    const node = tree.get(path);
    switch (operation) {
      case 'stat': return node ? [terminal('complete', 'none', 0, null, metadata(node))] : [rejected(2)];
      case 'read':
        if (!node) return [rejected(2)];
        if (node.kind !== 'file') return [rejected(node.kind === 'symlink' ? 40 : 95)];
        cursor = { kind: 'read', bytes: node.bytes, offset: 0 };
        return [terminal('ready', 'none', 0, null, metadata(node))];
      case 'list': {
        if (node?.kind !== 'directory') return [rejected(node ? 20 : 2)];
        const prefix = path === '.' ? '' : `${path}/`;
        const names = [...tree.keys()].filter((key) => key !== '.' && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map((key) => key.slice(prefix.length)).sort();
        cursor = { kind: 'list', names, index: 0, parent: prefix };
        return [terminal('ready', 'none', 0, null, metadata(node))];
      }
      case 'next':
        if (cursor?.kind === 'read') {
          if (cursor.offset < cursor.bytes.length) {
            const body = cursor.bytes.subarray(cursor.offset, cursor.offset + 32_768);
            cursor.offset += body.length;
            return [{ kind: 1, body }];
          }
          const count = cursor.bytes.length;
          cursor = undefined;
          return [terminal('complete', 'none', count)];
        }
        if (cursor?.kind === 'list') {
          const name = cursor.names[cursor.index];
          if (name === undefined) { const count = cursor.index; cursor = undefined; return [terminal('complete', 'none', count)]; }
          cursor.index += 1;
          return [{ kind: 2, body: { nameHex: Buffer.from(name).toString('hex'), ...metadata(tree.get(`${cursor.parent}${name}`)!) } }];
        }
        return [];
      case 'cancel': cursor = undefined; staging = undefined; return [terminal('cancelled', 'none', 0)];
      case 'write': {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
        if (tree.get(parent)?.kind !== 'directory') return [rejected(2)];
        if (flags === 1 && node) return [rejected(17)];
        staging = { path, mode: flags, bytes: [] };
        return [terminal('ready', 'staged', 0)];
      }
      case 'append': {
        staging!.bytes.push(data);
        return [terminal('ready', 'staged', Buffer.concat(staging!.bytes).length)];
      }
      case 'commit': {
        const { path: target, bytes } = staging!;
        staging = undefined;
        const content = Buffer.concat(bytes);
        const script = commits[target] ?? 'complete';
        tree.set(target, { kind: 'file', bytes: content });
        if (script === 'lost') return 'end';
        if (script === 'published_uncertain') return [terminal('uncertain', 'published', content.length)];
        return [terminal(script, 'published', content.length, 0o644)];
      }
      case 'close': queueMicrotask(() => output.end()); return [terminal('closed', 'none', 0)];
      case 'heartbeat': return [{ kind: 5 }];
      default: return [];
    }
  };
  input.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 16) {
      const pathBytes = buffered.readUInt32BE(8);
      const dataBytes = buffered.readUInt32BE(12);
      if (buffered.length < 16 + pathBytes + dataBytes) return;
      const operation = OPERATIONS[buffered.readUInt32BE(0)] ?? 'invalid';
      const flags = buffered.readUInt32BE(4);
      const path = buffered.subarray(16, 16 + pathBytes).toString('utf8');
      const data = Buffer.from(buffered.subarray(16 + pathBytes, 16 + pathBytes + dataBytes));
      buffered = buffered.subarray(16 + pathBytes + dataBytes);
      if (operation !== 'heartbeat') operations.push(operation === 'next' || operation === 'append' || operation === 'commit' ? operation : `${operation} ${path}`);
      const replies = answer(operation, flags, path, data);
      if (replies === 'end') output.end();
      else for (const reply of replies) send(reply);
    }
  });
  const client = createNodeFilesystemHelperClient({ input, output, user: { uid: 1000, gid: 1000 } });
  send({ kind: 4, body: READY });
  let closes = 0;
  const helper: HelperProcess = {
    client,
    pidNamespace: null,
    async close() {
      closes += 1;
      const receipt = await client.close();
      if (receipt.kind !== 'closed') throw new Error('helper did not close');
    },
  };
  return {
    helper,
    operations,
    get closes() { return closes; },
    text(path: string): string | undefined { const node = tree.get(path); return node?.kind === 'file' ? node.bytes.toString('utf8') : undefined; },
  };
}
