// ------------------------------------------------------------------------------------------------
//                files.ts - Pull-driven live operation ownership, streaming callbacks and publication
// ------------------------------------------------------------------------------------------------

import { parseSandboxRelativePath, SandboxOperationError, SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxByteSource, SandboxFileListConsumer, SandboxFileListResult, SandboxFileReadConsumer,
  SandboxFileReadResult, SandboxFileStatResult, SandboxFileWriteResult, SandboxLivePath, SandboxRelativePath } from '@agen-ai/sandbox';
import type { SandboxDriverFileOptions, SandboxDriverFileWriteOptions, SandboxDriverFiles } from '@agen-ai/sandbox/backend';
import { FilesystemChannel } from './channel.js';
import { FILESYSTEM_CHUNK_BYTES } from './protocol.js';
import type { FilesystemTerminal } from './protocol.js';
import type { FilesystemAccess } from '../../policy/filesystem.js';
import { entry, observation, terminal, unpublished } from './settlement.js';

export class DockerFilesystem {
  readonly files: SandboxDriverFiles;
  private busy = false;

  constructor(private readonly channel: FilesystemChannel, access: FilesystemAccess,
    private readonly beforeOperation: (signal: AbortSignal) => Promise<void>) {
    const read = {
      stat: (path: SandboxLivePath, options: SandboxDriverFileOptions) => this.perform(options, () => this.stat(path, options)),
      list: (path: SandboxLivePath, consume: SandboxFileListConsumer, options: SandboxDriverFileOptions) => this.perform(options, () => this.list(path, consume, options)),
      readFile: (path: SandboxRelativePath, consume: SandboxFileReadConsumer, options: SandboxDriverFileOptions) => this.perform(options, () => this.read(path, consume, options)),
    };
    this.files = access === 'read_only' ? Object.freeze({ kind: 'read_only', ...read }) : Object.freeze({ kind: 'read_write', ...read,
      writeFile: (path: SandboxRelativePath, source: SandboxByteSource, options: SandboxDriverFileWriteOptions) => this.perform(options, () => this.write(path, source, options)),
    });
  }

  private async perform<Value>(options: SandboxDriverFileOptions, operation: () => Promise<Value>): Promise<Value> {
    if (this.busy) throw new SandboxStateError('The filesystem helper already owns an entered operation.');
    options.signal.throwIfAborted();
    this.busy = true;
    const abort = () => this.channel.interrupt(new SandboxOperationError('cancelled', 'Live filesystem operation was cancelled.', { cause: options.signal.reason }));
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal.aborted) abort();
      await this.beforeOperation(options.signal);
      return await operation();
    } catch (cause) {
      this.channel.interrupt(cause);
      throw cause;
    } finally {
      options.signal.removeEventListener('abort', abort);
      this.busy = false;
    }
  }

  private async stat(path: SandboxLivePath, options: SandboxDriverFileOptions): Promise<SandboxFileStatResult> {
    const result = terminal(await this.channel.request({ operation: 'stat', path }, options.signal));
    const outcome = observation(result);
    if (outcome.kind !== 'completed') return outcome;
    if (!result.entry || result.count !== '0') throw new SandboxOperationError('driver_failure', 'Filesystem stat omitted its exact metadata observation.');
    return Object.freeze({ kind: 'completed', entry: entry(result.entry, path) });
  }

  private async cancel(signal: AbortSignal): Promise<void> {
    const result = terminal(await this.channel.request({ operation: 'cancel' }, signal));
    if (result.status !== 'cancelled' || result.effect !== 'none' || result.errno !== 0) {
      throw new SandboxOperationError('driver_failure', 'Filesystem cancellation did not settle its entered staging and descriptors.');
    }
  }

  private async list(path: SandboxLivePath, consume: SandboxFileListConsumer, options: SandboxDriverFileOptions): Promise<SandboxFileListResult> {
    const opened = terminal(await this.channel.request({ operation: 'list', path }, options.signal));
    if (opened.status !== 'ready') return { ...observation(opened), entries: 0n };
    if (opened.effect !== 'none' || opened.count !== '0' || opened.entry?.kind !== 'directory') {
      throw new SandboxOperationError('driver_failure', 'Filesystem listing did not open one admitted directory.');
    }
    let entries = 0n;
    while (true) {
      const reply = await this.channel.request({ operation: 'next' }, options.signal);
      if (reply.kind !== 'entry') {
        const result = terminal(reply);
        if (BigInt(result.count) !== entries) throw new SandboxOperationError('driver_failure', 'Filesystem listing counter differs from delivered entries.');
        return { ...observation(result), entries };
      }
      if (options.quotas.maxEntries !== undefined && entries >= options.quotas.maxEntries) {
        await this.cancel(options.signal);
        return { kind: 'rejected', reason: 'quota_exceeded', entries };
      }
      const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(reply.entry.nameHex, 'hex'));
      const relative = parseSandboxRelativePath(path === '.' ? name : `${path}/${name}`);
      await consume(entry(reply.entry, relative), { signal: options.signal });
      entries += 1n;
    }
  }

  private async read(path: SandboxRelativePath, consume: SandboxFileReadConsumer, options: SandboxDriverFileOptions): Promise<SandboxFileReadResult> {
    const opened = terminal(await this.channel.request({ operation: 'read', path }, options.signal));
    if (opened.status !== 'ready') return { ...observation(opened), bytes: 0n };
    if (opened.effect !== 'none' || opened.count !== '0' || opened.entry?.kind !== 'file') {
      throw new SandboxOperationError('driver_failure', 'Filesystem read did not open one admitted regular file.');
    }
    let bytes = 0n;
    let outcome: SandboxFileReadResult | undefined;
    const channel = this.channel;
    const chunks = async function* () {
      while (!outcome) {
        const reply = await channel.request({ operation: 'next' }, options.signal);
        if (reply.kind !== 'bytes') {
          const result = terminal(reply);
          if (BigInt(result.count) !== bytes) throw new SandboxOperationError('driver_failure', 'Filesystem read counter differs from received bytes.');
          outcome = { ...observation(result), bytes };
          return;
        }
        if (options.quotas.maxBytes !== undefined && BigInt(reply.bytes.byteLength) > options.quotas.maxBytes - bytes) {
          await cancel();
          outcome = { kind: 'rejected', reason: 'quota_exceeded', bytes };
          return;
        }
        for (let offset = 0; offset < reply.bytes.byteLength; offset += options.chunkBytes) {
          const part = reply.bytes.slice(offset, offset + options.chunkBytes);
          bytes += BigInt(part.byteLength);
          yield part;
        }
      }
    };
    const cancel = () => this.cancel(options.signal);
    const stream = chunks();
    try { await consume({ entry: { ...entry(opened.entry, path), kind: 'file' }, chunks: stream }, { signal: options.signal }); }
    finally { await stream.return(); }
    if (outcome) return outcome;
    await this.cancel(options.signal);
    return { kind: 'cancelled', reason: 'callback_closed', bytes };
  }

  private async write(path: SandboxRelativePath, source: SandboxByteSource, options: SandboxDriverFileWriteOptions): Promise<SandboxFileWriteResult> {
    const opened = terminal(await this.channel.request({ operation: 'write', path, mode: options.mode }, options.signal));
    if (opened.status !== 'ready') return unpublished(opened, 0n);
    if (opened.effect !== 'staged' || opened.count !== '0') throw new SandboxOperationError('driver_failure', 'Filesystem write did not reserve one private staging file.');
    let bytes = 0n;
    for await (const chunk of source) {
      options.signal.throwIfAborted();
      if (options.quotas.maxBytes !== undefined && BigInt(chunk.byteLength) > options.quotas.maxBytes - bytes) {
        await this.cancel(options.signal);
        return { kind: 'rejected', reason: 'quota_exceeded', effect: 'none', bytes };
      }
      for (let offset = 0; offset < chunk.byteLength; offset += FILESYSTEM_CHUNK_BYTES) {
        const part = chunk.subarray(offset, offset + FILESYSTEM_CHUNK_BYTES);
        const appended = terminal(await this.channel.request({ operation: 'append', bytes: part }, options.signal));
        bytes += BigInt(part.byteLength);
        if (appended.status !== 'ready' || appended.effect !== 'staged' || BigInt(appended.count) !== bytes) {
          throw new SandboxOperationError('driver_failure', 'Filesystem staging acknowledgement differs from accepted bytes.');
        }
      }
    }
    let result: FilesystemTerminal;
    try { result = terminal(await this.channel.request({ operation: 'commit' }, options.signal)); }
    catch { return { kind: 'uncertain', effect: 'unknown', bytes }; }
    if (BigInt(result.count) !== bytes) throw new SandboxOperationError('driver_failure', 'Filesystem publication counter differs from staged bytes.');
    if (result.effect === 'published') {
      if (result.status === 'complete' || result.status === 'changed') {
        if (result.mode === null) throw new SandboxOperationError('driver_failure', 'Filesystem publication omitted observed permissions.');
        return { kind: result.status === 'complete' ? 'completed' : 'changed', effect: 'published', bytes, permissions: result.mode };
      }
      return { kind: 'uncertain', effect: 'published', bytes };
    }
    if (result.status === 'uncertain') return { kind: 'uncertain', effect: 'unknown', bytes };
    return unpublished(result, bytes);
  }
}
