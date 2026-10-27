// ------------------------------------------------------------------------------------------------
//                decode.ts - Provisional incremental tar export - Complete framing before success
// ------------------------------------------------------------------------------------------------

import { archiveName, symlinkTarget, unsafeArchive } from '../paths.js';
import type { TarOptions, TarOutputEntry, TarSummary } from './contracts.js';
import { consumeTarEntry } from './entry.js';
import { BLOCK_BYTES, MAX_PAX_BYTES, MAX_TRAILER_BYTES, parseHeader } from './header.js';
import { parsePax } from './pax.js';
import type { PaxMetadata } from './pax.js';
import { TarReader } from './reader.js';

export async function readTar(source: AsyncIterable<Uint8Array>, consume: (entry: TarOutputEntry) => Promise<void>, options: TarOptions): Promise<TarSummary> {
  const reader = new TarReader(source, options);
  let files = 0n;
  let directories = 0n;
  let symlinks = 0n;
  let payloadBytes = 0n;
  let pendingPax: PaxMetadata | undefined;
  let primary: { readonly error: unknown } | undefined;
  let result: TarSummary | undefined;
  try {
    for (;;) {
      const block = await reader.required(BLOCK_BYTES);
      if (block.every((byte) => byte === 0)) {
        if (pendingPax) unsafeArchive('PAX metadata lacks its following entry.');
        await reader.zeroes(BLOCK_BYTES);
        let trailerBytes = BLOCK_BYTES * 2;
        for (;;) {
          const trailing = await reader.exact(BLOCK_BYTES, true);
          if (trailing === undefined) break;
          if (trailing.some((byte) => byte !== 0)) unsafeArchive('nonzero padding or trailer.');
          trailerBytes += BLOCK_BYTES;
          if (trailerBytes > MAX_TRAILER_BYTES) unsafeArchive('trailing padding exceeds the framing bound.');
        }
        result = Object.freeze({ files, directories, symlinks, payloadBytes, archiveBytes: reader.bytes });
        break;
      }
      const header = parseHeader(block);
      if (header.kind === 'pax') {
        if (pendingPax || header.size === 0 || header.size > MAX_PAX_BYTES) unsafeArchive('invalid bounded local PAX sequence.');
        pendingPax = parsePax(await reader.required(header.size));
        await reader.zeroes((BLOCK_BYTES - header.size % BLOCK_BYTES) % BLOCK_BYTES);
        continue;
      }
      const path = archiveName(pendingPax?.path ?? header.path, header.kind === 'directory');
      const target = pendingPax?.linkpath ?? header.target;
      if (header.kind !== 'symlink' && pendingPax?.linkpath !== undefined) unsafeArchive('PAX linkpath requires a symbolic-link entry.');
      pendingPax = undefined;
      if (header.kind === 'symlink') {
        if (options.symlinks !== 'preserve_internal') unsafeArchive('symbolic links require explicit preservation.');
        await consume(Object.freeze({ path, kind: 'symlink', size: 0, mode: header.mode, target: symlinkTarget(target) }));
        symlinks += 1n;
      } else {
        await consumeTarEntry(reader, { ...header, kind: header.kind }, path, consume, options.chunkBytes);
      }
      payloadBytes += BigInt(header.size);
      await reader.zeroes((BLOCK_BYTES - header.size % BLOCK_BYTES) % BLOCK_BYTES);
      if (header.kind === 'file') files += 1n;
      else if (header.kind === 'directory') directories += 1n;
    }
  } catch (error) { primary = { error }; }
  finally {
    try { await reader.close(); }
    catch (error) {
      if (primary) throw new AggregateError([primary.error, error], 'Archive validation and source cleanup both failed.');
      throw error;
    }
  }
  if (primary) throw primary.error;
  if (!result) unsafeArchive('archive framing did not settle.');
  return result;
}
