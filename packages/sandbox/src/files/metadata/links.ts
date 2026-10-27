import { Buffer } from 'node:buffer';
import { SandboxValidationError } from '../../errors.js';
import { SANDBOX_LIMITS } from '../../policy/limits.js';
import { parseSandboxRelativePath } from '../paths.js';
import type { SandboxRelativePath } from '../types.js';
import type { MetadataRecord } from './types.js';

function invalid(path: string, reason: string): never {
  throw new SandboxValidationError([{ code: 'invalid_input', path: ['path'], message: `Symbolic link ${path}: ${reason}` }]);
}

function workingBound(path: string, prefix: readonly string[], remaining: readonly string[]): void {
  const components = prefix.length + remaining.length;
  const bytes = prefix.reduce((size, item) => size + Buffer.byteLength(item) + 1, 0)
    + remaining.reduce((size, item) => size + Buffer.byteLength(item) + 1, 0);
  if (components > SANDBOX_LIMITS.maxSymlinkResolutionComponents || bytes > SANDBOX_LIMITS.maxSymlinkResolutionBytes) {
    invalid(path, 'resolution exceeds its bounded path working set');
  }
}

/** Resolves metadata only; no target is opened and missing components never skip confinement checks. */
export async function validateLink(record: Extract<MetadataRecord, { kind: 'symlink' }>,
  lookup: (path: SandboxRelativePath) => Promise<MetadataRecord | undefined>, root: SandboxRelativePath | undefined, signal: AbortSignal): Promise<void> {
  const rootDepth = root === undefined ? 0 : root.split('/').length;
  const prefix = record.path.split('/').slice(0, -1);
  let remaining = record.target.split('/');
  const seen = new Set<string>([JSON.stringify([record.path, []])]);
  let expansions = 1;
  workingBound(record.path, prefix, remaining);
  while (remaining.length) {
    signal.throwIfAborted();
    const component = remaining.shift();
    if (component === undefined || component === '' || component === '.') continue;
    if (component === '..') {
      if (prefix.length <= rootDepth) invalid(record.path, 'target escapes the selected publication root');
      prefix.pop(); continue;
    }
    prefix.push(component);
    const candidate = prefix.join('/');
    if (prefix.length > SANDBOX_LIMITS.maxPathSegments || Buffer.byteLength(candidate) > SANDBOX_LIMITS.maxPathBytes) {
      invalid(record.path, 'resolved path exceeds the common path envelope');
    }
    const observed = await lookup(parseSandboxRelativePath(candidate));
    if (observed?.kind === 'symlink') {
      const state = JSON.stringify([candidate, remaining]);
      if (seen.has(state)) return;
      if (++expansions > SANDBOX_LIMITS.maxSymlinkExpansions) invalid(record.path, 'resolution exceeds forty symbolic-link expansions');
      seen.add(state);
      prefix.pop(); remaining = [...observed.target.split('/'), ...remaining];
      workingBound(record.path, prefix, remaining);
    } else if (observed?.kind === 'file' && remaining.length !== 0) {
      invalid(record.path, 'target traverses a regular-file member');
    }
  }
}
