import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export class AcceptEditsCredentialError extends Error {
  readonly code = 'credential_invalid';
  constructor() {
    super('The API-key file must be a private regular file owned by this user with one key line.');
    this.name = 'AcceptEditsCredentialError';
  }
}

const MAXIMUM_KEY_FILE_BYTES = 4_096;

/**
 * Reads one explicit API key. The file is opened without following links and must be private to the
 * caller; the key itself is never logged, copied or returned in a report.
 */
export async function readApiKeyFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new AcceptEditsCredentialError(); });
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.uid !== process.geteuid?.() || (state.mode & 0o077) !== 0 || state.size < 1 || state.size > MAXIMUM_KEY_FILE_BYTES) {
      throw new AcceptEditsCredentialError();
    }
    const buffer = Buffer.alloc(MAXIMUM_KEY_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    buffer.fill(0);
    const key = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (bytesRead !== state.size || !/^[\x21-\x7e]{8,4000}$/u.test(key)) throw new AcceptEditsCredentialError();
    return key;
  } finally {
    await handle.close();
  }
}
