// Complete coordinated source and archive admission before the first package publication.

import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PUBLIC_PACKAGE_POLICIES } from "./package-inventory.mjs";
import { readTarballManifest } from "./verify-package-publication.mjs";

async function readManifest(file) {
  assert.ok((await lstat(file)).isFile(), `Manifest must be a regular file: ${file}`);
  return JSON.parse(await readFile(file, "utf8"));
}

function assertInventory(actual, expected, label) {
  const missing = expected.filter((name) => !actual.includes(name));
  const unknown = actual.filter((name) => !expected.includes(name));
  assert.ok(missing.length === 0 && unknown.length === 0,
    `${label} inventory mismatch; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}`);
}

export async function inspectReleaseSet({ repositoryRoot, releaseDirectory, releaseRef }) {
  const root = path.resolve(repositoryRoot);
  const rootManifest = await readManifest(path.join(root, "package.json"));
  const version = rootManifest.version;
  assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u,
    "Coordinated release version must be an exact version.");
  if (releaseRef !== undefined) assert.equal(releaseRef, `refs/tags/v${version}`, "Release ref does not match the coordinated version.");
  const packageEntries = await readdir(path.join(root, "packages"), { withFileTypes: true });
  assertInventory(packageEntries.map((entry) => entry.name), PUBLIC_PACKAGE_POLICIES.map((policy) => path.basename(policy.root)), "Source package");
  assert.ok(packageEntries.every((entry) => entry.isDirectory()), "Source packages must be directories, never links.");
  const packages = [];
  for (const policy of PUBLIC_PACKAGE_POLICIES) {
    const manifest = await readManifest(path.join(root, policy.root, "package.json"));
    assert.equal(manifest.name, policy.name, `Unexpected package identity at ${policy.root}.`);
    assert.equal(manifest.version, version, `${policy.name} does not match coordinated version ${version}.`);
    packages.push(Object.freeze({ policy, manifest }));
  }
  if (releaseDirectory !== undefined) {
    const directory = path.resolve(root, releaseDirectory);
    const archives = await readdir(directory, { withFileTypes: true });
    const filenames = packages.map(({ manifest }) => `${manifest.name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    assertInventory(archives.map((entry) => entry.name), filenames, "Release archive");
    assert.ok(archives.every((entry) => entry.isFile()), "Release archives must be regular files, never links.");
    for (const [index, { policy, manifest }] of packages.entries()) {
      const archive = path.join(directory, filenames[index]);
      assert.ok((await lstat(archive)).size > 0, `Release archive is empty: ${filenames[index]}`);
      const packed = await readTarballManifest(archive);
      assert.equal(packed.name, manifest.name, `Release archive ${filenames[index]} has the wrong package identity.`);
      assert.equal(packed.version, version, `Release archive ${filenames[index]} has a mixed version.`);
      assert.equal(packed.repository?.directory, policy.root, `Release archive ${filenames[index]} has the wrong repository directory.`);
    }
  }
  return Object.freeze({ version, packages: Object.freeze(packages) });
}

async function main() {
  const options = { repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)) };
  for (let index = 2; index < process.argv.length; index += 2) {
    const argument = process.argv[index];
    const value = process.argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}.`);
    if (argument === "--release-ref") options.releaseRef = value;
    else if (argument === "--release-directory") options.releaseDirectory = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const result = await inspectReleaseSet(options);
  process.stdout.write(`Coordinated ${result.version} release set admitted (${result.packages.length} packages).\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
