import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { addAbortSignal, Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { fromRandomAccessReaderPromise, RandomAccessReader, type Entry } from 'yauzl';
import unbzip2Stream from '@openpgp/unbzip2-stream';
import type { AcpInstallationLimits } from '../contracts.js';
import { AcpInstallationError } from '../errors.js';
import type { AcpBinaryArchiveFormat } from '../../../planning/binary.js';
import { ArchiveSink } from './sink.js';

const crc32 = createRequire(import.meta.url)('buffer-crc32') as typeof import('buffer-crc32');

export interface InspectArchiveInput {
  readonly artifactPath: string;
  readonly format: Exclude<AcpBinaryArchiveFormat, 'raw'>;
  readonly limits: AcpInstallationLimits;
  readonly signal?: AbortSignal;
  readonly readFiles?: readonly string[];
}

export interface ExtractArchiveInput extends InspectArchiveInput {
  readonly payloadRoot: string;
  readonly caseInsensitive?: boolean;
}

export async function inspectArchive(input: InspectArchiveInput): Promise<{ readonly files: Readonly<Record<string, Uint8Array>> }> {
  const sink = new ArchiveSink({ ...input, rejectLinks: true });
  await processArchive(input, sink);
  return { files: Object.freeze(sink.files) };
}

export async function extractArchive(input: ExtractArchiveInput): Promise<void> {
  const sink = new ArchiveSink(input);
  await processArchive(input, sink);
}

async function processArchive(input: InspectArchiveInput, sink: ArchiveSink): Promise<void> {
  input.signal?.throwIfAborted();
  if (!['tar.gz', 'tar.bz2', 'tar', 'zip'].includes(input.format)) throw new AcpInstallationError('unsupported_format', 'The selected archive decoder is unsupported.');
  await sink.initialize();
  const handle = await open(input.artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AcpInstallationError('unsafe_archive', 'An archive must be a regular file.');
    if (stat.size > input.limits.maxArtifactBytes) throw new AcpInstallationError('limit_exceeded', 'The archive exceeds the compressed byte budget.');
    if (input.format === 'zip') await processZip(handle, stat.size, input, sink);
    else await processTar(handle.createReadStream({ autoClose: false, signal: input.signal }), input, sink);
    input.signal?.throwIfAborted();
    await sink.finish();
  } catch (error) {
    if (input.signal?.aborted) throw new AcpInstallationError('aborted', 'Archive processing was canceled.', { cause: input.signal.reason });
    if (error instanceof AcpInstallationError) throw error;
    if (input.format === 'tar.bz2' && error instanceof Error && error.message === 'Maximum decompressed size exceeded') {
      throw new AcpInstallationError('limit_exceeded', 'Bzip2 data exceeds the decompressed byte budget.', { cause: error });
    }
    throw new AcpInstallationError('unsafe_archive', 'The archive is malformed or incomplete.', { cause: error });
  } finally { await handle.close(); }
}

async function processTar(source: Readable, input: InspectArchiveInput, sink: ArchiveSink): Promise<void> {
  const archive = extract();
  const budget = new TarBudget(input.limits.maxDecompressedBytes);
  let decoded: Readable;
  let feeding: Promise<void>;
  if (input.format === 'tar.bz2') {
    const reader = Readable.toWeb(source).getReader();
    // The maintained decoder names its cancellation hook `abort`; a Web reader calls it `cancel`.
    const bz2 = unbzip2Stream({ getReader: () => ({ read: () => reader.read(), abort: (reason) => reader.cancel(reason) }) }, input.limits.maxDecompressedBytes);
    decoded = Readable.fromWeb(bz2);
    feeding = pipeline(decoded, budget, archive, { signal: input.signal });
  } else if (input.format === 'tar.gz') {
    const gunzip = createGunzip();
    decoded = gunzip;
    feeding = pipeline(source, gunzip, budget, archive, { signal: input.signal });
  } else {
    decoded = source;
    feeding = pipeline(source, budget, archive, { signal: input.signal });
  }
  void feeding.catch(() => {});
  try {
    for await (const entry of archive) {
      const header = entry.header;
      if (!['file', 'directory', 'symlink', 'link'].includes(header.type)) throw new AcpInstallationError('unsafe_archive', 'Archive special files and unsupported entry types are forbidden.');
      if (header.pax && typeof header.pax === 'object' && Object.keys(header.pax).some((key) => key.startsWith('GNU.sparse') || key.startsWith('SCHILY.realsize'))) {
        throw new AcpInstallationError('unsafe_archive', 'Sparse archive files are unsupported.');
      }
      await sink.entry({ path: header.name, size: header.size, mode: header.mode,
        kind: header.type === 'link' ? 'hardlink' : header.type as 'file' | 'directory' | 'symlink',
        ...(header.linkname ? { target: header.linkname } : {}) }, archiveChunks(entry));
    }
    await feeding;
    budget.assertComplete();
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error('Archive processing failed.'));
    decoded.destroy();
    source.destroy();
    await feeding.catch(() => {});
    throw error;
  } finally { source.destroy(); }
}

async function processZip(handle: FileHandle, size: number, input: InspectArchiveInput, sink: ArchiveSink): Promise<void> {
  const zip = await fromRandomAccessReaderPromise(new ArchiveRandomAccessReader(handle), size, { autoClose: false, validateEntrySizes: true, strictFileNames: true });
  let failure: Error | undefined;
  let rejectNext: ((error: Error) => void) | undefined;
  let activeStream: Readable | undefined;
  const fail = (error: Error) => { failure = error; rejectNext?.(error); activeStream?.destroy(error); };
  const abort = () => { fail(new AcpInstallationError('aborted', 'ZIP archive processing was canceled.')); zip.close(); };
  zip.on('error', fail);
  input.signal?.addEventListener('abort', abort, { once: true });
  const nextEntry = (): Promise<Entry | undefined> => {
    if (failure) return Promise.reject(failure);
    input.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { zip.removeListener('entry', onEntry); zip.removeListener('end', onEnd); rejectNext = undefined; };
      const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
      const onEnd = () => { cleanup(); resolve(undefined); };
      rejectNext = (error) => { cleanup(); reject(error); };
      zip.once('entry', onEntry);
      zip.once('end', onEnd);
      try { zip.readEntry(); } catch (error) { cleanup(); reject(error); }
    });
  };
  let decompressedBytes = 0;
  try {
    if (zip.entryCount > input.limits.maxEntries) throw new AcpInstallationError('limit_exceeded', 'The ZIP archive contains too many entries.');
    for (;;) {
      const entry = await nextEntry();
      if (!entry) break;
      input.signal?.throwIfAborted();
      if (!entry.canDecodeFileData()) throw new AcpInstallationError('unsafe_archive', 'Encrypted ZIP files and unsupported compression methods are forbidden.');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || entry.uncompressedSize > input.limits.maxDecompressedBytes - decompressedBytes) throw new AcpInstallationError('limit_exceeded', 'ZIP data exceeds the decompressed byte budget.');
      const kind = zipEntryKind(entry);
      const stream = await zip.openReadStreamPromise(entry);
      activeStream = stream;
      if (input.signal) addAbortSignal(input.signal, stream);
      const chunks = async function* (): AsyncGenerator<Buffer> {
        let checksum = 0;
        let size = 0;
        try {
          for await (const chunk of stream) {
            input.signal?.throwIfAborted();
            const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += bytes.byteLength;
            decompressedBytes += bytes.byteLength;
            if (decompressedBytes > input.limits.maxDecompressedBytes || size > entry.uncompressedSize) throw new AcpInstallationError('limit_exceeded', 'ZIP data exceeds its declared size or decompressed byte budget.');
            checksum = crc32.unsigned(bytes, checksum);
            yield bytes;
          }
          if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new AcpInstallationError('unsafe_archive', 'ZIP file data does not match its declared size or CRC32.');
        } finally { stream.destroy(); }
      };
      try {
        if (kind === 'symlink') {
          if (entry.uncompressedSize > input.limits.maxPathBytes) throw new AcpInstallationError('limit_exceeded', 'A ZIP symlink target exceeds the path byte limit.');
          const targetChunks: Buffer[] = [];
          for await (const chunk of chunks()) targetChunks.push(chunk);
          const target = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(targetChunks));
          await sink.entry({ path: entry.fileName, kind, size: 0, mode: 0, target }, emptyChunks());
        } else await sink.entry({ path: entry.fileName, kind, size: entry.uncompressedSize, mode: entry.externalFileAttributes >>> 16 }, chunks());
      } finally { activeStream = undefined; stream.destroy(); }
    }
  } finally { input.signal?.removeEventListener('abort', abort); zip.close(); }
}

function zipEntryKind(entry: Entry): 'file' | 'directory' | 'symlink' {
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0o170000;
  if (type !== 0 && ![0o100000, 0o040000, 0o120000].includes(type)) throw new AcpInstallationError('unsafe_archive', 'ZIP special files are forbidden.');
  const directory = entry.fileName.endsWith('/');
  if (type === 0o120000) {
    if (directory) throw new AcpInstallationError('unsafe_archive', 'A ZIP entry has conflicting link and directory metadata.');
    return 'symlink';
  }
  if (type === 0o040000 && !directory || type === 0o100000 && directory) throw new AcpInstallationError('unsafe_archive', 'A ZIP entry has conflicting file type metadata.');
  return directory ? 'directory' : 'file';
}

async function* emptyChunks(): AsyncGenerator<Uint8Array> {}

async function* archiveChunks(chunks: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new AcpInstallationError('unsafe_archive', 'The archive decoder emitted non-byte file content.');
    yield chunk;
  }
}

class ArchiveRandomAccessReader extends RandomAccessReader {
  constructor(private readonly handle: FileHandle) { super(); }

  override _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle;
    return Readable.from((async function* () {
      let position = start;
      while (position < end) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) return;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })());
  }
}

class TarBudget extends Transform {
  private bytes = 0;
  private tail = Buffer.alloc(0);

  constructor(private readonly limit: number) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limit) { callback(new AcpInstallationError('limit_exceeded', 'Tar framing and file data exceed the decompressed byte budget.')); return; }
    this.tail = chunk.length >= 1024 ? Buffer.from(chunk.subarray(-1024)) : Buffer.concat([this.tail, chunk]).subarray(-1024);
    callback(null, chunk);
  }

  assertComplete(): void {
    if (this.bytes % 512 !== 0 || this.tail.length !== 1024 || this.tail.some((byte) => byte !== 0)) {
      throw new AcpInstallationError('unsafe_archive', 'A tar archive must end with complete zero-filled terminator blocks.');
    }
  }
}
