import { invalidRegistry } from '../shared/errors.js';

/** Both separators describe contained archive paths; they never choose a host shell or working directory. */
export function normalizeRegistryExecutable(input: string): string {
  const path = input.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /[:\0\p{Cc}\p{Cf}]/u.test(path)) invalidRegistry('unsafe_executable', ['cmd'], 'Registry commands must identify contained payload files.');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '' || /[. ]$/u.test(segment) && segment !== '.')) invalidRegistry('unsafe_executable', ['cmd'], 'Registry payload paths cannot traverse, contain empty segments or ambiguous trailing dots/spaces.');
  const normalized = segments.filter((segment) => segment !== '.').join('/');
  if (!normalized) invalidRegistry('unsafe_executable', ['cmd'], 'Registry commands must identify a payload file.');
  return normalized;
}

export function validateRegistryPackage(input: string, kind: 'npx' | 'uvx'): void {
  const npm = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(?:\*|[a-zA-Z0-9][a-zA-Z0-9.+_-]*|[\^~][0-9][a-zA-Z0-9.+_*-]*))?$/u;
  const python = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9.+!_-]*|(?:(?:==|!=|>=|<=|~=|>|<)[a-zA-Z0-9][a-zA-Z0-9.+!*_-]*)(?:,(?:==|!=|>=|<=|~=|>|<)[a-zA-Z0-9][a-zA-Z0-9.+!*_-]*)*)?$/u;
  if (!(kind === 'npx' ? npm : python).test(input)) invalidRegistry('unsafe_package', ['package'], 'Registry packages require literal registry names and supported version, tag or range selectors.');
}
