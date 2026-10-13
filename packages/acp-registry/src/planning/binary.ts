import { invalidRegistry } from '../shared/errors.js';

export type AcpBinaryArchiveFormat = 'tar.gz' | 'tar.bz2' | 'tar' | 'zip' | 'raw';

export function resolveAcpBinaryArchiveFormat(url: string, explicit?: unknown): AcpBinaryArchiveFormat {
  const pathname = new URL(url).pathname.toLowerCase();
  if (/\.(?:dmg|pkg|deb|rpm|msi|appimage)$/u.test(pathname)) {
    invalidRegistry('acp_registry_binary_format_unsupported', ['binaryFormat'], 'System installation packages are not supported binary archives.');
  }
  const detected: AcpBinaryArchiveFormat | undefined = pathname.endsWith('.tar.gz') || pathname.endsWith('.tgz') ? 'tar.gz'
    : pathname.endsWith('.tar.bz2') || pathname.endsWith('.tbz2') || pathname.endsWith('.tbz') ? 'tar.bz2'
      : pathname.endsWith('.tar') ? 'tar'
        : pathname.endsWith('.zip') ? 'zip'
          : pathname.endsWith('.exe') || pathname.endsWith('.bin') ? 'raw' : undefined;
  if (explicit !== undefined && !['tar.gz', 'tar.bz2', 'tar', 'zip', 'raw'].includes(explicit as string)) {
    invalidRegistry('acp_registry_binary_format_unsupported', ['binaryFormat'], 'Select one supported binary archive format.');
  }
  if (explicit !== undefined && detected !== undefined && explicit !== detected) {
    invalidRegistry('acp_registry_binary_format_unsupported', ['binaryFormat'], 'The explicit format conflicts with the selected archive URL suffix.');
  }
  if (explicit !== undefined) return explicit as AcpBinaryArchiveFormat;
  if (detected !== undefined) return detected;
  return invalidRegistry('acp_registry_binary_format_required', ['binaryFormat'], 'Extensionless or unknown binary sources require an explicit archive format.');
}
