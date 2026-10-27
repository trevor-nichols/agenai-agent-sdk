// ------------------------------------------------------------------------------------------------
//                encode.ts - Exact-length incremental tar writer - Caller quota and producer joins
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import { archiveName, symlinkTarget } from '../paths.js';
import type { TarInputEntry, TarOptions } from './contracts.js';
import { BLOCK_BYTES, MAX_OCTAL_SIZE, MAX_PAX_BYTES, makeHeader } from './header.js';
import { encodePax } from './pax.js';

async function* payload(entry: TarInputEntry, options: TarOptions): AsyncGenerator<Uint8Array> {
  let written = 0;
  if (entry.body !== undefined) {
    const source = entry.body;
    const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    let done = false;
    let primary: { readonly error: unknown } | undefined;
    try {
      for (;;) {
        options.signal.throwIfAborted();
        const item = await iterator.next();
        options.signal.throwIfAborted();
        if (item.done) { done = true; break; }
        const chunk = item.value;
        if (!(chunk instanceof Uint8Array) || chunk.length > options.chunkBytes) throw new SandboxOperationError('input_limit', 'Input file chunks exceed the selected byte buffer.');
        if (chunk.length > entry.size - written) throw new SandboxOperationError('input_limit', 'Input file body exceeds its declared size.');
        written += chunk.length;
        yield chunk;
      }
    } catch (error) { primary = { error }; }
    finally {
      if (!done) {
        try { await iterator.return?.(); }
        catch (error) {
          if (primary) throw new AggregateError([primary.error, error], 'Input file and producer cleanup both failed.');
          throw error;
        }
      }
    }
    if (primary) throw primary.error;
  }
  if (written !== entry.size) throw new SandboxOperationError('input_limit', 'Input file body ended before its declared size.');
  if (written % BLOCK_BYTES) yield new Uint8Array(BLOCK_BYTES - written % BLOCK_BYTES);
}

async function* blocks(entries: AsyncIterable<TarInputEntry> | Iterable<TarInputEntry>, options: TarOptions): AsyncGenerator<Uint8Array> {
  for await (const entry of entries) {
    options.signal.throwIfAborted();
    archiveName(entry.path, entry.kind === 'directory');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_OCTAL_SIZE) {
      throw new SandboxUnsupportedError('Docker tar entries require exact unsigned-octal sizes no greater than 8 GiB minus one byte.');
    }
    if (entry.kind !== 'file' && (entry.size !== 0 || entry.body !== undefined)) throw new SandboxUnsupportedError('Directory and symbolic-link tar entries cannot carry payload.');
    if (entry.kind === 'symlink' && options.symlinks !== 'preserve_internal') throw new SandboxUnsupportedError('Symbolic links require explicit preservation.');
    const target = entry.kind === 'symlink' ? symlinkTarget(entry.target) : undefined;
    const name = entry.kind === 'directory' ? `${entry.path}/` : entry.path;
    let headerName = name;
    let headerTarget = target;
    const longName = Buffer.byteLength(name) > 100;
    const longTarget = target !== undefined && Buffer.byteLength(target) > 100;
    if (longName || longTarget) {
      const pax = encodePax({ ...(longName ? { path: name } : {}), ...(longTarget ? { linkpath: target } : {}) });
      if (pax.length > MAX_PAX_BYTES) throw new SandboxUnsupportedError('Docker path metadata exceeds the selected bounded PAX representation.');
      yield makeHeader({ uid: entry.uid, gid: entry.gid, mode: entry.mode, path: 'PaxHeader', kind: 'pax', size: pax.length });
      for (let offset = 0; offset < pax.length; offset += options.chunkBytes) yield pax.subarray(offset, offset + options.chunkBytes);
      if (pax.length % BLOCK_BYTES) yield new Uint8Array(BLOCK_BYTES - pax.length % BLOCK_BYTES);
      if (longName) headerName = entry.kind === 'directory' ? 'entry/' : 'entry';
      if (longTarget) headerTarget = '';
    }
    yield makeHeader({ ...entry, path: headerName, target: headerTarget });
    if (entry.kind === 'file') yield* payload(entry, options);
  }
  options.signal.throwIfAborted();
  yield new Uint8Array(BLOCK_BYTES);
  yield new Uint8Array(BLOCK_BYTES);
}

export async function* writeTar(entries: AsyncIterable<TarInputEntry> | Iterable<TarInputEntry>, options: TarOptions): AsyncGenerator<Uint8Array> {
  let bytes = 0n;
  const iterator = blocks(entries, options);
  let done = false;
  let primary: { readonly error: unknown } | undefined;
  try {
    for (;;) {
      const item = await iterator.next();
      if (item.done) { done = true; break; }
      bytes += BigInt(item.value.length);
      if (options.maxArchiveBytes !== undefined && bytes > options.maxArchiveBytes) {
        throw new SandboxOperationError(options.limitCode, 'Workspace archive exceeds the caller-selected wire byte quota.');
      }
      yield item.value;
    }
  } catch (error) { primary = { error }; }
  finally {
    if (!done) {
      try { await iterator.return(undefined); }
      catch (error) {
        if (primary) throw new AggregateError([primary.error, error], 'Archive transfer and producer cleanup both failed.');
        throw error;
      }
    }
  }
  if (primary) throw primary.error;
}
