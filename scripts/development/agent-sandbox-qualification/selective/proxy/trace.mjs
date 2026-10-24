// ------------------------------------------------------------------------------------------------
//                trace.mjs - Bounded on-disk Engine request records and constant-size row counters
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';

export class RequestTrace {
  constructor(file) { this.file = file; this.pending = Promise.resolve(); this.nextId = 0; this.row = 'setup'; this.summaries = new Map(); }

  static async create(path) { return new RequestTrace(await open(path, 'wx', 0o600)); }

  begin(method, target) {
    const url = new URL(target, 'http://engine.invalid');
    const archivePath = /\/archive$/u.test(url.pathname) ? url.searchParams.get('path') : null;
    return { id: this.nextId++, row: this.row, method, target, archivePath, startedAt: new Date().toISOString(),
      status: null, uploadedBytes: 0, upstreamBodyBytes: 0, forwardedBodyBytes: 0, fault: null, failure: null };
  }

  async finish(record) {
    record.finishedAt = new Date().toISOString();
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    assert(bytes.length <= 2048, 'Engine trace record exceeded its bounded envelope.');
    let row = this.summaries.get(record.row);
    if (!row) {
      assert(this.summaries.size < 64, 'Qualification row census exceeded its selected bound.');
      row = { requests: 0, archiveHeads: 0, archiveGets: 0, archiveBytes: 0n, rootArchiveGets: 0, failures: 0 };
      this.summaries.set(record.row, row);
    }
    row.requests += 1;
    if (record.archivePath !== null && record.method === 'HEAD') row.archiveHeads += 1;
    if (record.archivePath !== null && record.method === 'GET') {
      row.archiveGets += 1;
      row.archiveBytes += BigInt(record.forwardedBodyBytes);
      if (['/workspace', '/workspace/work', '/workspace/', '/workspace/work/'].includes(record.archivePath)) row.rootArchiveGets += 1;
    }
    if (record.failure !== null) row.failures += 1;
    const actual = this.pending.then(async () => {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset, null);
        assert(bytesWritten > 0);
        offset += bytesWritten;
      }
    });
    this.pending = actual;
    await actual;
  }

  summary(row) { return { ...(this.summaries.get(row) ?? { requests: 0, archiveHeads: 0, archiveGets: 0, archiveBytes: 0n, rootArchiveGets: 0, failures: 0 }) }; }
  async close() {
    const failures = [];
    try { await this.pending; } catch (error) { failures.push(error); }
    try { await this.file.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Trace writes or descriptor cleanup failed.');
  }
}
