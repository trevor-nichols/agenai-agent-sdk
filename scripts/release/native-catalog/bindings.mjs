import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectReleaseSet } from "../verify-release-set.mjs";
import { HELPER_FILES } from "./policy.mjs";

const execFileAsync = promisify(execFile);
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const objectDigest = (value) => digest(JSON.stringify(value));

export const catalogPayload = (name, files) => ({ name, files: files.length,
  bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), sha256: objectDigest(files) });

export async function readCatalogArchive(file) {
  const { stdout } = await execFileAsync("python3", [fileURLToPath(new URL("./archive.py", import.meta.url)), file],
    { timeout: 30_000, maxBuffer: 4 * 1024 ** 2 });
  return JSON.parse(stdout);
}

export async function boundedFile(file, maximum = 1024 * 1024) {
  const metadata = await lstat(file);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximum, `Invalid bounded catalog file: ${file}`);
  const bytes = await readFile(file);
  assert(bytes.length <= maximum, "Catalog file exceeded its budget.");
  return bytes;
}

async function harnessCensus(root) {
  const prefix = "scripts/development/agent-sandbox-qualification";
  const files = [];
  let totalBytes = 0;
  async function visit(directory, local) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      assert(!entry.isSymbolicLink(), "Catalog harness must not contain links.");
      const file = path.join(directory, entry.name), name = `${local}/${entry.name}`;
      if (entry.isDirectory()) await visit(file, name);
      else if (/\.(?:mjs|js|ts|json|sh|c|h)$/u.test(entry.name) && !/\.test\.(?:mjs|js|ts)$/u.test(entry.name)) {
        const bytes = await boundedFile(file, 4 * 1024 ** 2);
        files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
        totalBytes += bytes.length;
        assert(files.length <= 4096 && totalBytes <= 32 * 1024 ** 2, "Catalog harness census exceeded its budget.");
      }
    }
  }
  await visit(path.join(root, prefix), prefix);
  assert(files.some(({ path: name }) => name === `${prefix}/capabilities/catalog/run.mjs`), "Catalog execution owner is missing.");
  assert(files.some(({ path: name }) => name === `${prefix}/capabilities/catalog/protocol.mjs`), "Catalog protocol is missing.");
  return { files: files.length, bytes: totalBytes, sha256: objectDigest(files) };
}

/** Capture publication applicability only; this function never manufactures native observations. */
export async function inspectCatalogBindings({ repositoryRoot, releaseDirectory, releaseRef }) {
  const source = await inspectReleaseSet({ repositoryRoot, releaseDirectory, releaseRef });
  const archives = [], payloads = [];
  let helper;
  for (const { manifest } of source.packages) {
    const filename = `${manifest.name.replace("@", "").replace("/", "-")}-${source.version}.tgz`;
    const file = path.resolve(repositoryRoot, releaseDirectory, filename);
    const bytes = await boundedFile(file, 64 * 1024 ** 2);
    archives.push({ name: manifest.name, bytes: bytes.length, sha256: digest(bytes) });
    const { files } = await readCatalogArchive(file);
    payloads.push(catalogPayload(manifest.name, files));
    if (manifest.name === "@agen-ai/sandbox-docker") {
      const selected = HELPER_FILES.map((local) => {
        const record = files.find(({ path: name }) => name === `dist/${local}`);
        assert(record, `Shipped catalog helper file is missing: ${local}`);
        return { path: local, sha256: record.sha256 };
      });
      helper = { files: selected, sourceDigest: `sha256:${objectDigest(selected)}` };
    }
  }
  const config = await boundedFile(path.join(repositoryRoot, "qualification/native-catalog", `configuration-${source.version}.json`));
  const configuration = JSON.parse(config);
  assert(configuration !== null && typeof configuration === "object" && !Array.isArray(configuration), "Catalog configuration must be an observed JSON object.");
  return { archives, payloads, harness: await harnessCensus(repositoryRoot),
    configuration: { bytes: config.length, sha256: digest(config) }, helper };
}
