import assert from 'node:assert/strict';
import { sha } from '../coordinator/evidence.mjs';

export function parseCanonicalEnvelope(bytes) {
  const lines = []; let offset = 0;
  for (let index = 0; index < 3; index++) {
    const end = bytes.indexOf(10, offset); assert(end >= offset && end - offset <= 128, 'Original canonical framing is incomplete.');
    lines.push(bytes.subarray(offset, end).toString('ascii')); offset = end + 1;
  }
  assert.equal(lines[0], 'AGENAI-SNAPSHOT-1'); assert.match(lines[1], /^[a-f0-9]{64}$/u); assert.match(lines[2], /^[a-f0-9]{64}$/u);
  const payload = bytes.subarray(offset); assert.equal(sha(payload), lines[2], 'Original canonical payload checksum differs.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  assert.equal(value.format, 'agenai.docker-desktop-coordinator.v1'); assert.equal(value.engineKey, `sha256:${lines[1]}`);
  return { value, payload: { bytes: payload.length, sha256: lines[2] } };
}
