import { AcpRegistryFetchError } from './contracts.js';

export async function readRegistryContent(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new AcpRegistryFetchError('response_too_large', 'The registry response exceeds the accepted byte limit.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > maxBytes - size) {
        throw new AcpRegistryFetchError('response_too_large', 'The registry response exceeds the accepted byte limit.');
      }
      bytes.set(result.value, size);
      size += result.value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the original read or byte-limit failure. */ }
    reader.releaseLock();
  }
  return bytes.slice(0, size);
}

export function decodeRegistryContent(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AcpRegistryFetchError('invalid_utf8', 'The registry response must contain valid UTF-8.');
  }
}
