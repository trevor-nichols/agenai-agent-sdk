// Read-only MS001 endpoint identity research. No Docker mutation method is exposed.
import { createHash } from 'node:crypto';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, join } from 'node:path';

const statIdentity = (value) => ({ device: String(value.dev), inode: String(value.ino), mode: String(value.mode),
  uid: String(value.uid), gid: String(value.gid) });

export async function socketIdentity(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'unix:' || url.host || url.search || url.hash || !isAbsolute(url.pathname)) throw new Error('requires_local_unix_endpoint');
  const path = decodeURIComponent(url.pathname);
  const canonicalPath = await realpath(path);
  const chain = [];
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current, { bigint: true });
    chain.push({ path: current, ...statIdentity(entry),
      ...(entry.isSymbolicLink() ? { symlink: await readlink(current) } : {}) });
  }
  const socket = await lstat(canonicalPath, { bigint: true });
  if (!socket.isSocket() || await realpath(path) !== canonicalPath) throw new Error('physical_socket_unstable');
  return { endpoint, canonicalPath, chain, socket: { ...statIdentity(socket),
    birthtimeNs: String(socket.birthtimeNs), ctimeNs: String(socket.ctimeNs) } };
}

export function assertSameEndpoint(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('endpoint_replaced');
}

export function assertSamePhysicalSocket(left, right) {
  if (left.canonicalPath !== right.canonicalPath || JSON.stringify(left.socket) !== JSON.stringify(right.socket)) {
    throw new Error('physical_socket_conflict');
  }
}

async function getJson(endpoint, path, receipts) {
  const socketPath = decodeURIComponent(new URL(endpoint).pathname);
  return new Promise((resolve, reject) => {
    const entered = new Date().toISOString();
    const http = request({ socketPath, method: 'GET', path, agent: false,
      headers: { Connection: 'close' } }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) http.destroy(new Error('identity_response_bound'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        clearTimeout(deadline);
        const body = Buffer.concat(chunks);
        receipts.push({ endpoint, method: 'GET', path, entered, settled: new Date().toISOString(),
          status: response.statusCode, bytes: body.length,
          responseSha256: createHash('sha256').update(body).digest('hex') });
        if (response.statusCode !== 200) return reject(new Error(`identity_http_status:${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => http.destroy(new Error('identity_request_timeout')), 5000);
    http.once('error', (error) => { clearTimeout(deadline); reject(error); });
    http.end();
  });
}

export async function observeEndpoint(endpoint, expected, receipts) {
  const before = await socketIdentity(endpoint);
  const info = await getJson(endpoint, '/v1.52/info', receipts);
  const version = await getJson(endpoint, '/version', receipts);
  const after = await socketIdentity(endpoint);
  assertSameEndpoint(before, after);
  // Existing Desktop admission explicitly permits Docker info's aarch64 spelling.
  const architecture = info.Architecture === 'aarch64' ? 'arm64' : info.Architecture;
  const engine = { id: info.ID, version: info.ServerVersion, apiVersion: version.ApiVersion,
    architecture, kernelVersion: info.KernelVersion, operatingSystem: info.OperatingSystem };
  if (JSON.stringify(engine) !== JSON.stringify(expected) || version.Version !== expected.version
    || version.Arch !== expected.architecture || version.Os !== 'linux') {
    throw new Error(`engine_identity_conflict:${JSON.stringify({ engine, versionArchitecture: version.Arch, versionOS: version.Os })}`);
  }
  return { filesystem: after, engine,
    rawIdentity: { info: { ID: info.ID, ServerVersion: info.ServerVersion, Architecture: info.Architecture,
      KernelVersion: info.KernelVersion, OperatingSystem: info.OperatingSystem },
    version: { Version: version.Version, ApiVersion: version.ApiVersion, MinAPIVersion: version.MinAPIVersion,
      Arch: version.Arch, Os: version.Os, KernelVersion: version.KernelVersion, GitCommit: version.GitCommit,
      BuildTime: version.BuildTime } } };
}

export function assertBoundObservation(before, after) {
  assertSameEndpoint(before.filesystem, after.filesystem);
  if (JSON.stringify(before.engine) !== JSON.stringify(after.engine)) throw new Error('engine_identity_replaced');
}

export async function activateBound(module, binary, endpoint, expected, configuration, receipts) {
  const before = await observeEndpoint(endpoint, expected, receipts);
  const owner = await module.activate(binary, before.engine.id, { ...configuration,
    originalEndpointBinding: { filesystem: before.filesystem, engine: before.engine } });
  try {
    const after = await observeEndpoint(endpoint, expected, receipts);
    assertBoundObservation(before, after);
    return { owner, before, after };
  } catch (error) {
    // Retain the durable dirty registration if admission loses endpoint authority.
    await owner.holder.close();
    throw error;
  }
}
