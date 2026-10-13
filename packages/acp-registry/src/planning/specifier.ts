import { invalidRegistry } from '../shared/errors.js';
import { inputString } from '../selection/input.js';

export function packageName(value: unknown, kind: 'npx' | 'uvx', path: readonly (string | number)[]): string {
  const name = inputString(value, path, 214);
  const valid = kind === 'npx' ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/ : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  if (!valid.test(name)) invalidRegistry('acp_registry_package_resolution_invalid', path, 'Expected a canonical package name.');
  return name;
}

export function exactPackageVersion(value: unknown, kind: 'npx' | 'uvx', path: readonly (string | number)[]): string {
  const version = inputString(value, path, 128);
  if (!isExactPackageVersion(version, kind)) {
    invalidRegistry('acp_registry_package_resolution_invalid', path, 'An exact supported package version is required; tags and ranges are unresolved.');
  }
  return version;
}

export function isExactPackageVersion(version: string, kind: 'npx' | 'uvx'): boolean {
  const valid = kind === 'npx'
    ? /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*))*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/
    : /^(?:[1-9]\d*!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
  return valid.test(version);
}
