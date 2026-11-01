import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { acquireJsonInput } from '../input.mjs';

export async function preparedExecutable(selected) {
  assert.equal(await realpath(selected.path), selected.path, 'Native executable must be a physical original file.');
  const file = await open(selected.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    assert(before.isFile() && before.size <= 32n * 1024n ** 2n && (before.mode & 0o111n) !== 0n, 'Prepared bounded executable required.');
    const bytes = await file.readFile(); assert.equal(BigInt(bytes.length), before.size);
    const after = await file.stat({ bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], 'Prepared executable changed during acquisition.');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), selected.sha256, 'Prepared native executable differs from its original digest.');
    // Mach-O MH_MAGIC_64 and CPU_TYPE_ARM64. Universal or translated helpers need separate preparation.
    assert(bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c,
      'Concurrency native coordinator and host observer helpers must be native arm64 Mach-O files.');
    const current = await lstat(selected.path, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(current[key], after[key]);
    return Object.freeze({ ...selected, bytes: bytes.length, device: String(after.dev), inode: String(after.ino),
      mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs) });
  } finally { await file.close(); }
}

export async function admitConcurrencyPreparation(manifest, platform) {
  const selection = manifest.concurrency;
  const assets = [];
  for (const asset of [selection.helper.executable, manifest.network.routeAuthority.hostObserver.executable]) assets.push(await preparedExecutable(asset));
  const receipt = await acquireJsonInput(selection.vmPreparation.path, 4 * 1024 ** 2);
  assert.equal(receipt.input.sha256, selection.vmPreparation.sha256, 'Explicit VM preparation receipt bytes differ.');
  const actual = receipt.value;
  assert.equal(actual.format, 'agenai.desktop-coordinator-explicit-vm-preparation.v1');
  assert.equal(actual.status, 'pass'); assert.equal(actual.cleanup, 'confirmed_absent');
  assert.equal(actual.endpoint, platform.engine); assert.equal(actual.image, platform.sourceImage);
  assert.equal(actual.before.id, platform.expected.daemon.id); assert.equal(actual.after.id, actual.before.id);
  assert.match(actual.id, /^[a-f0-9]{64}$/u);
  assert.deepEqual(actual.absence, [{ reference: actual.id, status: 404 }, { reference: actual.name, status: 404 }]);
  assert(actual.completedAt <= actual.finishedAt && Date.parse(actual.finishedAt) <= Date.now(), 'VM preparation must finish before admission.');
  return Object.freeze({ assets: Object.freeze(assets), vmPreparation: receipt.input,
    preparationResource: Object.freeze({ id: actual.id, name: actual.name }), preparationUtf8: receipt.utf8 });
}
