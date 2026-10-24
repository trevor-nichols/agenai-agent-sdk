import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHistoryError } from '../../lifecycle/errors.js';

const SDK_SHA256 = '48480d49d4493e2aec28227d8db8f8432743c7aa32facbdb9a7ce0a0363f7503';

export async function inspectClaudeSdk(): Promise<string> {
  try {
    const entry = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
    const entryPath = fileURLToPath(entry);
    const manifestChunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of createReadStream(join(dirname(entryPath), 'package.json'))) {
      bytes += chunk.length;
      if (bytes > 16_384) throw new Error('SDK manifest exceeds identity budget');
      manifestChunks.push(chunk);
    }
    const manifest: unknown = JSON.parse(Buffer.concat(manifestChunks).toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || !('name' in manifest) || !('version' in manifest)
      || manifest.name !== '@anthropic-ai/claude-agent-sdk' || manifest.version !== '0.3.306') throw new Error('Unqualified SDK');
    const digest = createHash('sha256');
    bytes = 0;
    for await (const chunk of createReadStream(entryPath)) {
      bytes += chunk.length;
      if (bytes > 67_108_864) throw new Error('SDK entry exceeds identity budget');
      digest.update(chunk);
    }
    if (digest.digest('hex') !== SDK_SHA256) throw new Error('Unqualified SDK entry');
    return entry;
  } catch {
    throw new AgentHistoryError('unsupported_scope', 'Install the qualified Claude Agent SDK 0.3.306 peer to open this history source.');
  }
}
