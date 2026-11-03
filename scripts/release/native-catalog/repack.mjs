import assert from "node:assert/strict";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { catalogPayload, digest, readCatalogArchive } from "./bindings.mjs";

const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Only dependency-map ordering is inert; conditional exports and every other field retain order.
function verifyDependencyOrdering(qualified, actual) {
  assert.equal(typeof qualified, "string", "Invalid qualified manifest bytes.");
  assert(Buffer.byteLength(qualified) <= 64 * 1024, "Qualified manifest exceeds its budget.");
  const original = JSON.parse(qualified), current = JSON.parse(actual);
  for (const field of DEPENDENCY_MAPS) {
    assert.deepEqual(original[field], current[field], "Repack changed more than dependency ordering.");
    if (Object.hasOwn(original, field)) original[field] = current[field];
  }
  const ending = qualified.endsWith("\n") ? "\n" : "";
  assert.equal(JSON.stringify(original, null, 2) + ending, actual, "Repack changed more than dependency ordering.");
}

export async function verifyRepackPayloads({ root, releaseDirectory, version, actual, qualified, manifests }) {
  const changed = actual.filter((entry, index) => !isDeepStrictEqual(entry, qualified[index]));
  assert(Array.isArray(manifests) && manifests.length === changed.length, "Invalid qualified manifest inventory.");
  const originals = new Map();
  for (const entry of manifests) {
    assert(entry !== null && typeof entry === "object" && !Array.isArray(entry), "Invalid qualified manifest receipt.");
    assert.deepEqual(Object.keys(entry).sort(), ["manifest", "name"], "Invalid qualified manifest receipt fields.");
    assert(changed.some(({ name }) => name === entry.name) && !originals.has(entry.name), "Invalid qualified manifest inventory.");
    originals.set(entry.name, entry.manifest);
  }
  const reconstructed = [];
  for (const payload of actual) {
    if (!originals.has(payload.name)) { reconstructed.push(payload); continue; }
    const file = path.resolve(root, releaseDirectory, `${payload.name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    const { files, manifest } = await readCatalogArchive(file);
    const original = originals.get(payload.name);
    verifyDependencyOrdering(original, manifest);
    const entries = files.map((entry) => entry.path === "package.json"
      ? { ...entry, bytes: Buffer.byteLength(original), sha256: digest(original) } : entry);
    reconstructed.push(catalogPayload(payload.name, entries));
  }
  assert.deepEqual(reconstructed, qualified, "Catalog payloads applicability is stale.");
}
