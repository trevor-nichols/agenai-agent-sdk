// ------------------------------------------------------------------------------------------------
//                resources.mjs - Bounded independent Engine observations and disk preflight
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import http from 'node:http';
import { lstat, statfs } from 'node:fs/promises';
import { absolutePath } from './configuration.mjs';

export function engineControl(endpoint, method, path, allowed = [200]) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: endpoint.slice(7), path: `/v1.52${path}`, method, agent: false,
      maxHeaderSize: 16 * 1024 }, (response) => {
      let length = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 1024 ** 2) response.destroy(new Error('Independent control response exceeded one MiB.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          assert(allowed.includes(response.statusCode), `Independent ${method} ${path} returned ${response.statusCode}.`);
          const data = Buffer.concat(chunks);
          resolve({ status: response.statusCode, value: data.length ? JSON.parse(data.toString('utf8')) : null });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Independent control observation exceeded 30 seconds.')), 30_000);
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}

export async function observeAbsent(endpoint, record, checkpoint, roles = ['compute', 'storage', 'export', 'network']) {
  const observations = [];
  for (const resource of record.resources) {
    if (!roles.includes(resource.role)) continue;
    const id = resource.identity.kind === 'identified' ? resource.identity.id : resource.name;
    const path = resource.role === 'storage' ? `/volumes/${encodeURIComponent(id)}`
      : resource.role === 'network' ? `/networks/${encodeURIComponent(id)}` : `/containers/${encodeURIComponent(id)}/json`;
    const actual = await engineControl(endpoint, 'GET', path, [404]);
    observations.push({ checkpoint, role: resource.role, id, httpStatus: actual.status });
  }
  return observations;
}

export async function diskFacts(path) {
  absolutePath(path);
  const [entry, fs] = await Promise.all([lstat(path, { bigint: true }), statfs(path, { bigint: true })]);
  return { path, device: String(entry.dev), filesystemType: String(fs.type), blockBytes: String(fs.bsize),
    availableBytes: String(fs.bavail * fs.bsize), totalBytes: String(fs.blocks * fs.bsize) };
}

export async function diskPreflight(output, dockerRoot) {
  const paths = [output, absolutePath(dockerRoot)];
  const facts = await Promise.all(paths.map(diskFacts));
  for (const fact of facts) {
    assert(![0x01021994n, 0x858458f6n, 0x958458f6n].includes(BigInt(fact.filesystemType)), 'Qualification data must use disk storage, not tmpfs, ramfs or hugetlbfs.');
    assert(BigInt(fact.availableBytes) >= 64n * 1024n ** 3n, 'Qualification requires 64 GiB available on host source/sink and Engine storage filesystems.');
  }
  return { requiredAvailableBytes: String(64n * 1024n ** 3n), facts,
    scope: 'Read-only statfs preflight; concurrent unrelated allocation remains outside this lane. Source, sink and Engine workspace may share this filesystem.' };
}
