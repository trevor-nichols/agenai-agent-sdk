import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseDocument, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const SDK_VERSION = "0.4.2";
export const CORE_CONSUMER_PACKAGES = ["@agen-ai/validation", "@agen-ai/agent-protocol", "@agen-ai/agent-runtime"];
const GRAPH_FIELDS = ["name", "version", "engines", "os", "cpu", "libc", "dependencies", "optionalDependencies",
  "peerDependencies", "peerDependenciesMeta", "dependenciesMeta", "devDependencies", "bundledDependencies", "bundleDependencies", "pnpm"];
const integrity = (bytes, algorithm) => `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
const identity = (file, bytes) => ({ path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const graph = (manifest) => Object.fromEntries(GRAPH_FIELDS.filter((key) => Object.hasOwn(manifest, key)).map((key) => [key, manifest[key]]));
const filename = (name) => `${name.replace("@", "").replace("/", "-")}-${SDK_VERSION}.tgz`;
const selector = (name) => `file:../packs/${filename(name)}`;
const packageKey = (name) => `${name}@${selector(name)}`;

function object(value, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function keys(value, expected, label) {
  assert.deepEqual(Object.keys(object(value, label)).sort(), [...expected].sort(), `${label} has unsupported keys`);
}

export function consumerPackageManifest(profile, dependencies) {
  assert.ok(profile === "core-consumer" || profile === "consumer", "Unknown packed consumer profile");
  return {
    name: profile === "core-consumer" ? "agent-sdk-core-only-interaction-proof" : "agent-sdk-external-consumer-proof",
    version: "1.0.0", private: true, type: "module", packageManager: "pnpm@11.7.0", engines: { node: ">=22.0.0" },
    dependencies: { ...dependencies, zod: "4.4.3" },
    devDependencies: { "@types/node": "24.10.1", typescript: "5.9.3", ...(profile === "consumer" ? { tsx: "4.19.3" } : {}) },
  };
}

export function packedOverridesSource(dependencies) {
  return `const packedDependencies = ${JSON.stringify(dependencies)};\nmodule.exports = { hooks: { readPackage(pkg) {\n  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {\n    if (!pkg[section]) continue;\n    for (const [name, tarball] of Object.entries(packedDependencies)) {\n      if (Object.hasOwn(pkg[section], name)) pkg[section][name] = tarball;\n    }\n  }\n  return pkg;\n} } };\n`;
}

async function readInput(file) {
  assert.ok((await lstat(file)).isFile(), `Dependency baseline input must be a regular file: ${file}`);
  assert.equal(await realpath(file), file, `Dependency baseline input must be physical: ${file}`);
  const bytes = await readFile(file);
  assert.ok(bytes.length <= 64 * 1024 * 1024, `Dependency baseline input is too large: ${file}`);
  return { bytes, identity: identity(file, bytes) };
}

function parseLock(bytes) {
  assert.ok(bytes.length <= 4 * 1024 * 1024, "Dependency baseline lock is too large");
  const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
  assert.equal(document.errors.length, 0, "Dependency baseline lock must be valid YAML without duplicate keys");
  assert.equal(document.warnings.length, 0, "Dependency baseline lock must not contain unsupported YAML tags");
  const lock = document.toJS({ maxAliasCount: 0 });
  keys(lock, ["lockfileVersion", "settings", "pnpmfileChecksum", "importers", "packages", "snapshots"], "Dependency baseline lock");
  assert.equal(lock.lockfileVersion, "9.0", "Dependency baseline requires lockfile version9.0");
  assert.deepEqual(lock.settings, { autoInstallPeers: true, excludeLinksFromLockfile: false }, "Unsupported dependency baseline settings");
  keys(lock.importers, ["."], "Dependency baseline importers");
  object(lock.packages, "Dependency baseline packages");
  object(lock.snapshots, "Dependency baseline snapshots");
  return lock;
}

function admitProfile(profile, names, root, inputs) {
  const dependencies = Object.fromEntries(names.map((name) => [name, `file:${path.join(root, "packs", filename(name))}`]));
  const manifest = JSON.parse(inputs.manifest.bytes.toString("utf8"));
  assert.deepEqual(manifest, consumerPackageManifest(profile, dependencies), `Dependency baseline ${profile} manifest differs from generated consumer`);
  const hook = packedOverridesSource(dependencies);
  assert.equal(inputs.hook.bytes.toString("utf8"), hook, `Dependency baseline ${profile} hook differs from generated hook`);
  const lock = parseLock(inputs.lock.bytes);
  assert.equal(lock.pnpmfileChecksum, integrity(Buffer.from(hook), "sha256"), "Dependency baseline hook checksum differs");
  const importer = lock.importers["."];
  keys(importer, ["dependencies", "devDependencies"], "Dependency baseline importer");
  for (const section of ["dependencies", "devDependencies"]) {
    keys(importer[section], Object.keys(manifest[section]), `Dependency baseline ${section}`);
    for (const [name, specifier] of Object.entries(manifest[section])) {
      assert.deepEqual(importer[section][name], { specifier, version: names.includes(name) ? selector(name) : specifier },
        `Dependency baseline importer differs for ${name}`);
    }
  }
  const sdkKeys = names.map(packageKey).sort();
  for (const section of ["packages", "snapshots"]) {
    const actual = Object.keys(lock[section]).filter((key) => key.startsWith("@agen-ai/") || key.includes("file:")).sort();
    assert.deepEqual(actual, sdkKeys, `Dependency baseline ${section} must contain only the governed SDK archive selectors`);
  }
  for (const name of names) {
    const entry = lock.packages[packageKey(name)];
    keys(entry, ["resolution", "version", "engines"], `Dependency baseline SDK package ${name}`);
    keys(entry.resolution, ["integrity", "tarball"], `Dependency baseline SDK resolution ${name}`);
    assert.equal(entry.resolution.tarball, selector(name), "Dependency baseline SDK archive selector differs");
    assert.equal(entry.version, SDK_VERSION, "Dependency baseline SDK version differs");
    assert.deepEqual(entry.engines, { node: ">=22.0.0" }, "Dependency baseline SDK engines differ");
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (sdkKeys.includes(key)) continue;
    keys(entry.resolution, ["integrity"], `Dependency baseline registry resolution ${key}`);
    assert.match(entry.resolution.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, "Dependency baseline requires registry archive integrity");
  }
  const admittedFiles = new Set([...names.map(selector), ...Object.values(dependencies)]);
  const checkLocalReferences = (value) => {
    if (typeof value === "string" && /^(?:file:|link:|workspace:|\.\.?\/|\/)/u.test(value)) {
      assert.ok(admittedFiles.has(value), `Dependency baseline contains an ungoverned local reference: ${value}`);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) checkLocalReferences(child);
    }
  };
  checkLocalReferences(lock);
  return { names, manifest, lock, inputs };
}

function admitSdkSnapshot(profile, name, manifest) {
  for (const section of ["optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    assert.ok(!manifest[section] || Object.keys(manifest[section]).length === 0,
      `Dependency baseline SDK ${section} graph is unsupported for ${name}`);
  }
  const dependencies = manifest.dependencies ?? {};
  const snapshot = profile.lock.snapshots[packageKey(name)];
  keys(snapshot, ["dependencies", ...(Object.hasOwn(snapshot, "transitivePeerDependencies") ? ["transitivePeerDependencies"] : [])],
    `Dependency baseline SDK snapshot ${name}`);
  keys(snapshot.dependencies, Object.keys(dependencies), `Dependency baseline SDK snapshot dependencies ${name}`);
  for (const [dependency, declared] of Object.entries(dependencies)) {
    const resolved = snapshot.dependencies[dependency];
    if (dependency.startsWith("@agen-ai/")) {
      assert.ok(profile.names.includes(dependency), `Dependency baseline SDK dependency is outside its profile: ${dependency}`);
      assert.equal(resolved, selector(dependency), `Dependency baseline SDK snapshot edge differs for ${dependency}`);
    } else {
      assert.match(declared, /^\d+\.\d+\.\d+$/u, `Dependency baseline SDK requires an exact registry dependency: ${dependency}`);
      assert.equal(typeof resolved, "string", `Dependency baseline SDK snapshot edge must be a version: ${dependency}`);
      assert.equal(resolved.split("(")[0], declared, `Dependency baseline SDK snapshot edge differs for ${dependency}`);
      assert.ok(Object.hasOwn(profile.lock.packages, `${dependency}@${declared}`)
        && Object.hasOwn(profile.lock.snapshots, `${dependency}@${resolved}`),
      `Dependency baseline SDK snapshot edge is unresolved for ${dependency}`);
    }
  }
}

export async function readDependencyBaseline(root, packageNames) {
  assert.equal(await realpath(root), root, "Dependency baseline root must be an existing physical directory");
  assert.equal(new Set(packageNames).size, 7, "Dependency baseline requires the exact seven-package inventory");
  const profiles = {};
  for (const profile of ["core-consumer", "consumer"]) {
    const directory = path.join(root, profile);
    const inputs = { manifest: await readInput(path.join(directory, "package.json")),
      hook: await readInput(path.join(directory, ".pnpmfile.cjs")), lock: await readInput(path.join(directory, "pnpm-lock.yaml")) };
    profiles[profile] = admitProfile(profile, profile === "core-consumer" ? CORE_CONSUMER_PACKAGES : packageNames, root, inputs);
  }
  for (const section of ["packages", "snapshots"]) {
    for (const [key, value] of Object.entries(profiles["core-consumer"].lock[section])) {
      assert.deepEqual(profiles.consumer.lock[section][key], value, `Dependency baseline profiles disagree for ${key}`);
    }
  }
  const archives = {};
  for (const name of packageNames) {
    const file = path.join(root, "packs", filename(name));
    const archive = await readInput(file);
    for (const profile of Object.values(profiles)) {
      if (!profile.names.includes(name)) continue;
      assert.equal(profile.lock.packages[packageKey(name)].resolution.integrity, integrity(archive.bytes, "sha512"),
        `Dependency baseline archive integrity differs for ${name}`);
    }
    const { stdout } = await execFileAsync("tar", ["-xOzf", file, "--", "package/package.json"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    // Bind the inspected manifest to the same archive bytes admitted above.
    assert.deepEqual(await readFile(file), archive.bytes, `Dependency baseline archive changed while inspecting ${name}`);
    const manifest = JSON.parse(stdout);
    assert.equal(manifest.name, name); assert.equal(manifest.version, SDK_VERSION);
    for (const profile of Object.values(profiles)) {
      if (profile.names.includes(name)) admitSdkSnapshot(profile, name, manifest);
    }
    archives[name] = { identity: archive.identity, manifest: identity(`${file}#package/package.json`, Buffer.from(stdout)), graph: graph(manifest) };
  }
  return { root, profiles, archives };
}

export async function seedDependencyBaseline({ baseline, profile, consumerRoot, artifacts }) {
  const admitted = baseline.profiles[profile];
  const lock = structuredClone(admitted.lock);
  const dependencies = Object.fromEntries(admitted.names.map((name) => {
    const artifact = artifacts.find((entry) => entry.manifest.name === name);
    assert.ok(artifact, `Missing candidate SDK archive: ${name}`);
    assert.deepEqual(graph(artifact.manifest), baseline.archives[name].graph, `SDK dependency declarations changed for ${name}`);
    assert.equal(artifact.tarballPath, path.resolve(consumerRoot, "../packs", filename(name)), "Candidate SDK archive must use the governed sibling packs layout");
    return [name, `file:${artifact.tarballPath}`];
  }));
  const manifest = consumerPackageManifest(profile, dependencies);
  const hook = packedOverridesSource(dependencies);
  const manifestFile = path.join(consumerRoot, "package.json");
  const hookFile = path.join(consumerRoot, ".pnpmfile.cjs");
  const manifestBytes = await readFile(manifestFile);
  const hookBytes = await readFile(hookFile);
  assert.deepEqual(JSON.parse(manifestBytes.toString("utf8")), manifest, "Candidate consumer manifest differs");
  assert.equal(hookBytes.toString("utf8"), hook, "Candidate generated hook differs");
  const candidateArchives = [];
  for (const name of admitted.names) {
    const artifact = artifacts.find((entry) => entry.manifest.name === name);
    const archiveBytes = await readFile(artifact.tarballPath);
    lock.importers["."].dependencies[name].specifier = dependencies[name];
    lock.packages[packageKey(name)].resolution.integrity = integrity(archiveBytes, "sha512");
    candidateArchives.push(identity(artifact.tarballPath, archiveBytes));
  }
  lock.pnpmfileChecksum = integrity(Buffer.from(hook), "sha256");
  const bytes = Buffer.from(stringify(lock, { lineWidth: 0 }));
  const file = path.join(consumerRoot, "pnpm-lock.yaml");
  await writeFile(file, bytes, { flag: "wx" });
  return { profile, consumerRoot, lock, bytes, manifestBytes, hookBytes, baseline: admitted,
    evidence: { baselineRoot: baseline.root, profile, inputs: Object.fromEntries(Object.entries(admitted.inputs).map(([key, input]) => [key, input.identity])),
      baselineArchives: admitted.names.map((name) => ({ ...baseline.archives[name].identity, manifest: baseline.archives[name].manifest })), candidateArchives,
      candidateManifest: identity(manifestFile, manifestBytes), generatedHook: identity(hookFile, hookBytes), seededLock: identity(file, bytes) } };
}

export async function verifyDependencyBaselineInstall(seed) {
  const file = path.join(seed.consumerRoot, "pnpm-lock.yaml");
  const bytes = await readFile(file);
  assert.deepEqual(bytes, seed.bytes, "Frozen consumer installation rewrote the seeded lock bytes");
  assert.deepEqual(await readFile(path.join(seed.consumerRoot, "package.json")), seed.manifestBytes, "Frozen consumer installation changed its manifest");
  assert.deepEqual(await readFile(path.join(seed.consumerRoot, ".pnpmfile.cjs")), seed.hookBytes, "Frozen consumer installation changed its generated hook");
  for (const archive of seed.evidence.candidateArchives) {
    assert.deepEqual(identity(archive.path, await readFile(archive.path)), archive, "Frozen consumer installation changed a candidate archive");
  }
  assert.deepEqual(parseLock(bytes), seed.lock, "Frozen consumer installation changed the admitted dependency graph");
  const restored = structuredClone(seed.lock);
  restored.pnpmfileChecksum = seed.baseline.lock.pnpmfileChecksum;
  for (const name of seed.baseline.names) {
    restored.importers["."].dependencies[name].specifier = seed.baseline.lock.importers["."].dependencies[name].specifier;
    restored.packages[packageKey(name)].resolution.integrity = seed.baseline.lock.packages[packageKey(name)].resolution.integrity;
  }
  assert.deepEqual(restored, seed.baseline.lock, "Dependency baseline changed outside governed candidate inputs");
  return { ...seed.evidence, installedLock: identity(file, bytes), unchangedDependencyGraphSha256: createHash("sha256")
    .update(JSON.stringify(restored)).digest("hex") };
}
