// ------------------------------------------------------------------------------------------------
//                guest.mjs - Independent guest full-byte digest and physical-allocation observation
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, statfs } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

assert.equal(process.argv.length, 3, 'Explicit guest workspace required.');
const root = process.argv[2];
assert(isAbsolute(root) && normalize(root) === root && !/[\0\r\n]/u.test(root));
const filesystem = await statfs(root, { bigint: true });
assert(![0x01021994n, 0x858458f6n, 0x958458f6n].includes(filesystem.type), 'Guest workspace must be disk-backed.');
const source = await open(`${root}/control/source.jsonl`, constants.O_RDONLY | constants.O_NOFOLLOW);
const output = await open(`${root}/control/guest.jsonl`, 'wx', 0o600);
const aggregate = createHash('sha256');
let files = 0;
let payloadBytes = 0n;
let allocatedBytes = 0n;
let largestFileBytes = 0;
let previous = '';
let pending = '';
const buffer = Buffer.alloc(64 * 1024);
try {
  for await (const chunk of source.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) {
    const text = pending + chunk.toString('utf8');
    let start = 0;
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      assert(end - start > 0 && end - start <= 2048, 'Bounded source record required.');
      const expected = JSON.parse(text.slice(start, end));
      start = end + 1;
      assert(Object.keys(expected).sort().join(',') === 'byteLength,path,sha256');
      assert(/^(?:dataset\/[0-9]{5}\.bin|artifacts\/nested\/result\.bin)$/u.test(expected.path) && expected.path > previous);
      assert(Number.isSafeInteger(expected.byteLength) && expected.byteLength > 0 && expected.byteLength <= 512 * 1024 ** 2);
      assert(/^[a-f0-9]{64}$/u.test(expected.sha256));
      previous = expected.path;
      const input = await open(`${root}/${expected.path}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash('sha256');
      let total = 0;
      try {
        const before = await input.stat({ bigint: true });
        assert(before.isFile() && before.size === BigInt(expected.byteLength));
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await input.stat({ bigint: true });
        assert.equal(total, expected.byteLength);
        assert(after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs);
        assert(after.blocks * 512n >= after.size, 'Guest dataset must be physically allocated.');
        allocatedBytes += after.blocks * 512n;
      } finally { await input.close(); }
      const sha256 = hash.digest('hex');
      assert.equal(sha256, expected.sha256);
      const observed = { path: expected.path, byteLength: total, sha256 };
      const line = `${JSON.stringify(observed)}\n`;
      await output.writeFile(line);
      aggregate.update(`${observed.path}\0${observed.byteLength}\0${observed.sha256}\n`);
      files += 1;
      payloadBytes += BigInt(total);
      largestFileBytes = Math.max(largestFileBytes, total);
    }
    pending = text.slice(start);
    assert(pending.length <= 2048);
  }
  assert.equal(pending, '', 'Source manifest must end completely.');
} finally { await Promise.all([source.close(), output.close()]); }
let censusFiles = 0;
let censusDataFiles = 0;
let censusDirectories = 0;
let censusPayloadBytes = 0n;
const visit = async (prefix) => {
  const directory = await opendir(prefix ? `${root}/${prefix}` : root, { bufferSize: 8 });
  for await (const entry of directory) {
    const local = prefix ? `${prefix}/${entry.name}` : entry.name;
    const actual = await lstat(`${root}/${local}`, { bigint: true });
    assert(!actual.isSymbolicLink());
    if (actual.isDirectory()) {
      assert(['artifacts', 'artifacts/nested', 'dataset', 'control'].includes(local));
      censusDirectories += 1;
      await visit(local);
    } else {
      assert(actual.isFile());
      if (/^(?:dataset\/[0-9]{5}\.bin|artifacts\/nested\/result\.bin)$/u.test(local)) censusDataFiles += 1;
      else assert(['control/source.jsonl', 'control/guest.mjs', 'control/guest.jsonl'].includes(local));
      censusFiles += 1;
      censusPayloadBytes += actual.size;
    }
  }
};
await visit('');
assert.equal(censusDataFiles, files);
assert.equal(censusFiles, files + 3);
assert.equal(censusDirectories, 4);
process.stdout.write(`${JSON.stringify({ node: process.version, files, payloadBytes: String(payloadBytes), allocatedBytes: String(allocatedBytes),
  largestFileBytes, aggregateSha256: aggregate.digest('hex'), census: { files: censusFiles, dataFiles: censusDataFiles,
    controlFiles: censusFiles - censusDataFiles, directories: censusDirectories, payloadBytes: String(censusPayloadBytes) },
  filesystem: { type: String(filesystem.type), blockBytes: String(filesystem.bsize), availableBytes: String(filesystem.bavail * filesystem.bsize) } })}\n`);
