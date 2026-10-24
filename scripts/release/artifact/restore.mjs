// ------------------------------------------------------------------------------------------------
//                restore.mjs - Validate original archive bytes before publishing a fresh release tree
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectReleaseSet } from "../verify-release-set.mjs";

const execFileAsync = promisify(execFile);

async function absent(file) {
  try { await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`Recovery destination already exists: ${file}`);
}

async function identity(file) {
  const value = await lstat(file, { bigint: true });
  return { device: value.dev, inode: value.ino };
}

async function removeOwned(file, owned, directory) {
  let current;
  try { current = await identity(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  assert.ok(current.device === owned.device && current.inode === owned.inode, `Recovery cleanup identity changed: ${file}`);
  if (directory) await rm(file, { recursive: true });
  else await unlink(file);
}

async function fileDigest(file) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { bytes += chunk.length; digest.update(chunk); }
  return { bytes, sha256: digest.digest("hex") };
}

export async function restoreReleaseArtifact({ repositoryRoot, archivePath, artifact, workflowRun, expected, taggedMetadata }) {
  const root = path.resolve(repositoryRoot);
  const destination = path.join(root, "release");
  const receiptPath = path.join(root, "release-artifact-receipt.json");
  await absent(destination);
  await absent(receiptPath);
  assert.ok((await lstat(archivePath)).isFile(), "Original artifact must be a regular archive file.");
  const archiveDigest = await fileDigest(archivePath);
  assert.equal(archiveDigest.bytes, artifact.size, "Original artifact size does not match GitHub metadata.");
  assert.equal(`sha256:${archiveDigest.sha256}`, artifact.digest, "Original artifact digest does not match GitHub metadata.");
  const source = await inspectReleaseSet({ repositoryRoot: root, releaseRef: expected.releaseRef });
  const filenames = source.packages.map(({ manifest }) => `${manifest.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agenai-release-artifact-"));
  const scratchIdentity = await identity(scratch);
  let destinationIdentity;
  let receiptIdentity;
  let receipt;
  let primary;
  const cleanupFailures = [];
  try {
    await execFileAsync("python3", [fileURLToPath(new URL("./extract.py", import.meta.url)), archivePath, scratch,
      JSON.stringify([...filenames.map((name) => `release/${name}`), "pnpm-lock.yaml", ".agenai-export.json"])], { maxBuffer: 1024 * 1024 });
    const retained = {};
    for (const name of ["pnpm-lock.yaml", ".agenai-export.json"]) {
      const bytes = await readFile(path.join(scratch, name));
      assert.ok(bytes.equals(taggedMetadata[name]), `Retained ${name} does not match the immutable release tag.`);
      retained[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    await inspectReleaseSet({ repositoryRoot: root, releaseDirectory: path.join(scratch, "release"), releaseRef: expected.releaseRef });
    const archives = [];
    for (const name of filenames) archives.push({ name, ...await fileDigest(path.join(scratch, "release", name)) });
    receipt = { format: "agenai.original-release-artifact.v1", repository: expected.repository,
      releaseRef: expected.releaseRef, releaseSha: expected.releaseSha, originalArtifact: artifact.metadata,
      originalWorkflowRun: workflowRun, downloadedArchive: archiveDigest, taggedMetadata: retained, archives };
    await mkdir(destination, { mode: 0o700 });
    destinationIdentity = await identity(destination);
    for (const name of filenames) await copyFile(path.join(scratch, "release", name), path.join(destination, name), constants.COPYFILE_EXCL);
    const handle = await open(receiptPath, "wx", 0o600);
    try {
      const stat = await handle.stat({ bigint: true });
      receiptIdentity = { device: stat.dev, inode: stat.ino };
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    } finally { await handle.close(); }
  } catch (error) { primary = { error }; }
  if (primary) {
    for (const [file, owned, directory] of [[receiptPath, receiptIdentity, false], [destination, destinationIdentity, true]]) {
      if (owned) { try { await removeOwned(file, owned, directory); } catch (error) { cleanupFailures.push(error); } }
    }
  }
  try { await removeOwned(scratch, scratchIdentity, true); } catch (error) { cleanupFailures.push(error); }
  if (primary || cleanupFailures.length) {
    if (primary && cleanupFailures.length === 0) throw primary.error;
    throw new AggregateError([...(primary ? [primary.error] : []), ...cleanupFailures], "Original artifact restoration or exact cleanup failed.");
  }
  return receipt;
}
