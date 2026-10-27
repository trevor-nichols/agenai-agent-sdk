// ------------------------------------------------------------------------------------------------
//                filesystem-protocol.test.ts - Independent native wire bytes and strict frame admission
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFilesystemReply, encodeFilesystemRequest, filesystemReplyLength } from '../src/workspace/live/protocol.js';

test('native requests preserve binary data, exact UTF-8 paths and create/replace flags', () => {
  assert.equal(Buffer.from(encodeFilesystemRequest({ operation: 'write', path: 'é.txt', mode: 'replace' })).toString('hex'),
    '00000005000000020000000600000000c3a92e747874');
  assert.equal(Buffer.from(encodeFilesystemRequest({ operation: 'append', bytes: Uint8Array.of(0, 255, 128) })).toString('hex'),
    '0000000600000000000000000000000300ff80');
  assert.equal(Buffer.from(encodeFilesystemRequest({ operation: 'stat', path: '.' })).toString('hex'),
    '000000010000000000000001000000002e');
  for (const path of ['../escape', '/absolute', '\ud800.txt', '.', 'x'.repeat(256)]) {
    assert.throws(() => encodeFilesystemRequest({ operation: 'read', path }));
  }
});

test('native replies distinguish raw bytes, direct children and effect-bearing publication changes', () => {
  assert.deepEqual(decodeFilesystemReply(1, Uint8Array.of(0, 255)), { kind: 'bytes', bytes: Uint8Array.of(0, 255) });
  assert.deepEqual(decodeFilesystemReply(2, Buffer.from('{"nameHex":"c3a92e747874","kind":"file","byteLength":123,"mode":493}')),
    { kind: 'entry', entry: { nameHex: 'c3a92e747874', kind: 'file', byteLength: 123, mode: 493 } });
  assert.deepEqual(decodeFilesystemReply(3, Buffer.from('{"status":"changed","effect":"published","errno":0,"count":"18446744073709551615","mode":493,"entry":null}')),
    { kind: 'terminal', terminal: { status: 'changed', effect: 'published', errno: 0, count: '18446744073709551615', mode: 493, entry: null } });
});

test('untrusted framing and metadata reject before a consumer can borrow them', () => {
  for (const [kind, length] of [[0, 1], [1, 0], [1, 65537], [2, 2049], [5, 1]]) assert.throws(() => filesystemReplyLength(kind!, length!));
  const terminals = [
    '{"status":"complete","effect":"none","errno":0,"count":"01","mode":null,"entry":null}',
    '{"status":"complete","effect":"none","errno":0,"count":"18446744073709551616","mode":null,"entry":null}',
    '{"status":"complete","effect":"none","errno":0,"count":"0","mode":null,"entry":null,"extra":true}',
  ];
  for (const json of terminals) assert.throws(() => decodeFilesystemReply(3, Buffer.from(json)));
  for (const nameHex of ['2e2e', '612f62', '00', 'ff', '5c']) {
    assert.throws(() => decodeFilesystemReply(2, Buffer.from(JSON.stringify({ nameHex, kind: 'file', byteLength: 0, mode: 420 }))));
  }
  assert.throws(() => decodeFilesystemReply(4, Buffer.from('{"protocol":"agenai.sandbox.filesystem.v1","layout":"agenai.sandbox.workspace.v1","uid":0,"gid":65534}')));
});
