// ------------------------------------------------------------------------------------------------
//                stat.ts - Exact bounded Docker Lstat observations - No final or ancestor symlinks
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import type { DockerEngineStreamResponse } from '../engine/contracts.js';
import { DOCKER_API } from '../policy/config.js';
import type { DockerApi } from '../resources/api.js';
import { unsafeArchive } from './paths.js';

const statSchema = z.strictObject({ name: z.string().min(1).max(1024), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: z.number().int().nonnegative().max(0xffff_ffff), mtime: z.string().min(1).max(64), linkTarget: z.string().max(4096) });
export type DockerPathStat = z.infer<typeof statSchema>;
const MODE_DIRECTORY = 0x8000_0000;
const MODE_TYPE = 0x8f28_0000;

export function pathStat(response: DockerEngineStreamResponse): DockerPathStat {
  const name = 'x-docker-container-path-stat';
  const encoded = response.headers[name];
  let count = 0;
  for (let index = 0; index < response.rawHeaders.length; index += 2) if (response.rawHeaders[index].toLowerCase() === name) count += 1;
  if (count !== 1 || typeof encoded !== 'string' || encoded.length > 8192
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) unsafeArchive('Docker stat header must be one bounded canonical Base64 value.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) unsafeArchive('Docker stat header is not canonical Base64.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return unsafeArchive('Docker stat header requires valid UTF-8 JSON.'); }
  const parsed = statSchema.safeParse(value);
  if (!parsed.success) unsafeArchive('Docker stat header does not match the bounded path-stat contract.');
  return parsed.data;
}

export function requireStat(stat: DockerPathStat, path: string, kind: 'file' | 'directory'): void {
  const type = (stat.mode & MODE_TYPE) >>> 0;
  if (stat.name !== path.slice(path.lastIndexOf('/') + 1) || stat.linkTarget !== ''
    || type !== (kind === 'directory' ? MODE_DIRECTORY : 0)) unsafeArchive('selected paths require the requested regular file or directory without symlink traversal.');
}

export function sameStat(actual: DockerPathStat, expected: DockerPathStat): void {
  if (actual.name !== expected.name || actual.size !== expected.size || actual.mode !== expected.mode
    || actual.mtime !== expected.mtime || actual.linkTarget !== expected.linkTarget) unsafeArchive('selected path metadata changed between stat and archive observations.');
}

export async function statPath(api: DockerApi, containerId: string, path: string, signal: AbortSignal, chunkBytes: number): Promise<DockerPathStat> {
  const result = await api.stream('HEAD', `${DOCKER_API}/containers/${containerId}/archive?path=${encodeURIComponent(path)}`, { signal, chunkBytes }, async (response) => {
    const stat = pathStat(response);
    for await (const chunk of response.body) if (chunk.length) unsafeArchive('HEAD unexpectedly returned a body.');
    return stat;
  });
  return result.value;
}

export async function selectedPathStat(api: DockerApi, containerId: string, relative: string, kind: 'file' | 'directory', signal: AbortSignal, chunkBytes: number): Promise<DockerPathStat> {
  const parts = ['workspace', 'work', ...relative.split('/')];
  for (let count = 1; count < parts.length; count += 1) {
    const path = `/${parts.slice(0, count).join('/')}`;
    requireStat(await statPath(api, containerId, path, signal, chunkBytes), path, 'directory');
  }
  const path = `/${parts.join('/')}`;
  const stat = await statPath(api, containerId, path, signal, chunkBytes);
  requireStat(stat, path, kind);
  return stat;
}
