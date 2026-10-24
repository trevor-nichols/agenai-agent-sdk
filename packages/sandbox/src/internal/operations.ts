// ------------------------------------------------------------------------------------------------
//                operations.ts - Strict cancellation and scoped-run option boundaries
// ------------------------------------------------------------------------------------------------

import type { OperationOptions, SandboxRunOptions } from '../contracts.js';
import { parseSandboxRecoveryPolicy } from '../recovery/parse.js';
import { invalidInput } from './data.js';

export function parseOperationOptions(input: unknown = undefined): OperationOptions {
  if (input === undefined) return Object.freeze({});
  if (input === null || typeof input !== 'object'
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalidInput('Operation options must be a plain object');
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => key !== 'signal')) invalidInput('Operation options support only signal');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'signal');
  if (descriptor === undefined) return Object.freeze({});
  if (!('value' in descriptor) || !descriptor.enumerable) invalidInput('Operation signal must be a data field');
  const signal: unknown = descriptor.value;
  if (signal === undefined) return Object.freeze({});
  if (!(signal instanceof AbortSignal)) invalidInput('Operation signal must be an AbortSignal');
  return Object.freeze({ signal });
}

export function parseSandboxRunOptions(input: unknown): SandboxRunOptions {
  if (input === null || typeof input !== 'object'
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalidInput('Sandbox run options must be a plain object');
  if (Reflect.ownKeys(input).some((key) => key !== 'signal' && key !== 'recovery')) invalidInput('Sandbox run options support only recovery and signal');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'recovery');
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) invalidInput('Sandbox run options require an explicit recovery policy');
  const recovery = parseSandboxRecoveryPolicy(descriptor.value);
  const signal = Object.getOwnPropertyDescriptor(input, 'signal');
  if (signal === undefined) return Object.freeze({ recovery });
  if (!('value' in signal) || !signal.enumerable) invalidInput('Operation signal must be a data field');
  return Object.freeze({ ...parseOperationOptions({ signal: signal.value }), recovery });
}
