import { SandboxStateError } from '../errors.js';
import type { SandboxByteSource } from '../files/types.js';
import { invalidInput } from '../internal/data.js';
import type { SandboxDriverFiles } from './driver.js';
import { listFiles, readFile, statFile, writeFile } from './operation.js';
import type { OwnedLiveOperation } from './operation.js';
import { parseFileOptions, parseFilePath, parseFileWriteOptions } from './parse.js';
import type { ParsedFileOptions } from './parse.js';
import type { SandboxFileAccess, SandboxFileListConsumer, SandboxFileOptions, SandboxFileReadConsumer,
  SandboxFiles, SandboxFileWriteOptions, SandboxFileWriteResult } from './types.js';

type Admission = <Result>(options: ParsedFileOptions, perform: (controller: AbortController) => OwnedLiveOperation<Result>,
  inspect?: (result: Result) => void) => Promise<Result>;

export function createLiveFiles(access: SandboxFileAccess, port: SandboxDriverFiles | undefined, chunkBytes: number,
  enter: Admission, observeWrite: (result: SandboxFileWriteResult) => void): SandboxFiles {
  if (access.kind === 'disabled') {
    if (port !== undefined) throw new SandboxStateError('A disabled filesystem request cannot acquire a live facility port.');
    return Object.freeze({ kind: 'disabled' });
  }
  if (!port || port.kind !== access.kind || typeof port.stat !== 'function' || typeof port.list !== 'function'
    || typeof port.readFile !== 'function' || (port.kind === 'read_write' && typeof port.writeFile !== 'function')) {
    throw new SandboxStateError('Backend did not supply exactly its requested live filesystem authority.');
  }
  const driverOptions = (controller: AbortController, options: ParsedFileOptions) => ({ signal: controller.signal, quotas: options.quotas, chunkBytes });
  const reads = {
    stat: (input: string, options?: SandboxFileOptions) => {
      const path = parseFilePath(input, true);
      const parsed = parseFileOptions(options);
      return enter(parsed, (controller) => statFile(port, path, controller, driverOptions(controller, parsed)));
    },
    list: (input: string, consume: SandboxFileListConsumer, options?: SandboxFileOptions) => {
      const path = parseFilePath(input, true);
      if (typeof consume !== 'function') invalidInput('Live listing requires an asynchronous entry consumer');
      const parsed = parseFileOptions(options);
      return enter(parsed, (controller) => listFiles(port, path, consume, controller, driverOptions(controller, parsed)));
    },
    readFile: (input: string, consume: SandboxFileReadConsumer, options?: SandboxFileOptions) => {
      const path = parseFilePath(input, false);
      if (path === '.') invalidInput('Live reads require a regular file path');
      if (typeof consume !== 'function') invalidInput('Live reads require an asynchronous file consumer');
      const parsed = parseFileOptions(options);
      return enter(parsed, (controller) => readFile(port, path, consume, controller, driverOptions(controller, parsed)));
    },
  };
  if (port.kind === 'read_only') return Object.freeze({ kind: 'read_only', ...reads });
  return Object.freeze({ kind: 'read_write', ...reads, writeFile: (input: string, source: SandboxByteSource, inputOptions: SandboxFileWriteOptions) => {
    const path = parseFilePath(input, false);
    if (path === '.') invalidInput('Live writes require a regular file path');
    const options = parseFileWriteOptions(inputOptions);
    return enter(options, (controller) => writeFile(port, path, source, options.mode, controller, driverOptions(controller, options)), observeWrite);
  } });
}
