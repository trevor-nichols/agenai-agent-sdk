import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { CORE_CONSUMER_PACKAGES, consumerPackageManifest, packedOverridesSource, readDependencyBaseline,
  seedDependencyBaseline, verifyDependencyBaselineInstall } from "./dependency-baseline.mjs";

const exec = promisify(execFile);
const names = [...CORE_CONSUMER_PACKAGES, "@agen-ai/agent-orchestration", "@agen-ai/acp-transport", "@agen-ai/provider-acp", "@agen-ai/acp-registry"];
const registryVersions = { zod: "4.4.3", "@types/node": "24.10.1", typescript: "5.9.3", tsx: "4.19.3" };
const sri = (bytes, algorithm = "sha512") => `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
const filename = (name, version = "0.4.2") => `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
const local = (name) => `file:../packs/${filename(name)}`;
const key = (name) => `${name}@${local(name)}`;

async function archive(root, name, version, value, dependencies = {}) {
  const directory = path.join(root, "sources", name, value, "package");
  await mkdir(directory, { recursive: true });
  const manifest = { name, version, type: "module", main: "index.js", engines: { node: ">=22.0.0" }, dependencies };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "index.js"), `export const value = ${JSON.stringify(value)};\n`);
  const file = path.join(root, "packs", filename(name, version));
  await mkdir(path.dirname(file), { recursive: true });
  await exec("tar", ["-czf", file, "-C", path.dirname(directory), "package"]);
  return { manifest, tarballPath: file };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agenai-dependency-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineRoot = path.join(root, "baseline");
  const candidateRoot = path.join(root, "candidate");
  const baselineArtifacts = [];
  const artifacts = [];
  const registry = [];
  for (const name of names) {
    baselineArtifacts.push(await archive(baselineRoot, name, "0.4.2", "baseline", { zod: "4.4.3" }));
    artifacts.push(await archive(candidateRoot, name, "0.4.2", `candidate:${name}`, { zod: "4.4.3" }));
  }
  for (const [name, version] of Object.entries(registryVersions)) {
    registry.push(await archive(path.join(root, "registry"), name, version, `registry:${name}`));
  }
  for (const profile of ["core-consumer", "consumer"]) {
    const profileNames = profile === "core-consumer" ? CORE_CONSUMER_PACKAGES : names;
    const directory = path.join(baselineRoot, profile);
    await mkdir(directory, { recursive: true });
    const dependencies = Object.fromEntries(profileNames.map((name) => [name, `file:${path.join(baselineRoot, "packs", filename(name))}`]));
    const manifest = consumerPackageManifest(profile, dependencies);
    const hook = packedOverridesSource(dependencies);
    const importer = Object.fromEntries(["dependencies", "devDependencies"].map((section) => [section,
      Object.fromEntries(Object.entries(manifest[section]).map(([name, specifier]) => [name,
        { specifier, version: profileNames.includes(name) ? local(name) : specifier }]))]));
    const packages = {};
    const snapshots = {};
    for (const artifact of baselineArtifacts.filter((entry) => profileNames.includes(entry.manifest.name))) {
      const name = artifact.manifest.name;
      packages[key(name)] = { resolution: { integrity: sri(await readFile(artifact.tarballPath)), tarball: local(name) },
        version: "0.4.2", engines: { node: ">=22.0.0" } };
      snapshots[key(name)] = { dependencies: { zod: "4.4.3" } };
    }
    for (const artifact of registry.filter((entry) => profile === "consumer" || entry.manifest.name !== "tsx")) {
      const packageKey = `${artifact.manifest.name}@${artifact.manifest.version}`;
      packages[packageKey] = { resolution: { integrity: sri(await readFile(artifact.tarballPath)) } };
      snapshots[packageKey] = {};
    }
    const lock = { lockfileVersion: "9.0", settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      pnpmfileChecksum: sri(Buffer.from(hook), "sha256"), importers: { ".": importer }, packages, snapshots };
    await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
    await writeFile(path.join(directory, ".pnpmfile.cjs"), hook);
    await writeFile(path.join(directory, "pnpm-lock.yaml"), stringify(lock, { lineWidth: 0 }));
  }
  return { root, baselineRoot, candidateRoot, artifacts, registry };
}

async function candidateProfile(input, profile) {
  const directory = path.join(input.candidateRoot, profile);
  await mkdir(directory, { recursive: true });
  const selected = profile === "core-consumer" ? CORE_CONSUMER_PACKAGES : names;
  const dependencies = Object.fromEntries(selected.map((name) => [name, `file:${path.join(input.candidateRoot, "packs", filename(name))}`]));
  await writeFile(path.join(directory, "package.json"), JSON.stringify(consumerPackageManifest(profile, dependencies)));
  await writeFile(path.join(directory, ".pnpmfile.cjs"), packedOverridesSource(dependencies));
  return directory;
}

async function pinnedPackageManager(cwd) {
  const version = (command, args = []) => exec(command, [...args, "--version"], { cwd });
  if ((await version("pnpm")).stdout.trim() === "11.7.0") return { command: "pnpm", args: [] };
  // A newer global shim may otherwise try downloading the declared CLI into the isolated dependency store.
  const store = (await exec("pnpm", ["store", "path"], { cwd })).stdout.trim();
  const installed = path.join(store, "links/@/pnpm/11.7.0");
  for (const entry of (await readdir(installed, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const cli = path.join(installed, entry.name, "node_modules/pnpm/bin/pnpm.cjs");
    if ((await version(process.execPath, [cli])).stdout.trim() === "11.7.0") return { command: process.execPath, args: [cli] };
  }
  assert.fail("The frozen-install fixture requires an already installed pnpm11.7.0 CLI.");
}

test("dependency baselines rebind both consumers while preserving every other resolution", async (t) => {
  const input = await fixture(t);
  const baseline = await readDependencyBaseline(input.baselineRoot, names);
  // Subsequent packing consumes the admitted snapshot, never a supplied hook reread.
  await writeFile(path.join(input.baselineRoot, "consumer/.pnpmfile.cjs"), "throw new Error('untrusted replacement');\n");
  for (const profile of ["core-consumer", "consumer"]) {
    const directory = await candidateProfile(input, profile);
    const seed = await seedDependencyBaseline({ baseline, profile, consumerRoot: directory, artifacts: input.artifacts });
    const evidence = await verifyDependencyBaselineInstall(seed);
    assert.notEqual(evidence.seededLock.sha256, evidence.inputs.lock.sha256);
    assert.equal(evidence.installedLock.sha256, evidence.seededLock.sha256);
    assert.doesNotMatch(await readFile(path.join(directory, ".pnpmfile.cjs"), "utf8"), /untrusted replacement/u);
    const lock = parse(await readFile(path.join(directory, "pnpm-lock.yaml"), "utf8"));
    assert.deepEqual(lock.snapshots, baseline.profiles[profile].lock.snapshots);
    assert.deepEqual(lock.packages["zod@4.4.3"], baseline.profiles[profile].lock.packages["zod@4.4.3"]);
    assert.equal(lock.importers["."].dependencies["@agen-ai/validation"].specifier,
      `file:${path.join(input.candidateRoot, "packs", filename("@agen-ai/validation"))}`);
    assert.equal(lock.packages[key("@agen-ai/validation")].resolution.integrity, sri(await readFile(input.artifacts[0].tarballPath)));
  }
});

test("dependency baseline admission rejects changed manifests, hooks, locks and archive identities", async (t) => {
  const input = await fixture(t);
  const directory = path.join(input.baselineRoot, "consumer");
  const cases = [
    { file: "package.json", reason: /manifest differs/u, change: (bytes) => JSON.stringify({ ...JSON.parse(bytes), scripts: { install: "untrusted" } }) },
    { file: "package.json", reason: /manifest differs/u, change: (bytes) => {
      const value = JSON.parse(bytes); value.devDependencies.typescript = "5.0.0"; return JSON.stringify(value);
    } },
    { file: ".pnpmfile.cjs", reason: /hook differs/u, change: (bytes) => `${bytes}\nthrow new Error('must never execute');\n` },
    { file: "pnpm-lock.yaml", reason: /hook checksum differs/u, change: (bytes) => {
      const value = parse(bytes); value.pnpmfileChecksum = "sha256-wrong"; return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /profiles disagree/u, change: (bytes) => {
      const value = parse(bytes); value.packages["zod@4.4.3"].resolution.integrity = sri(Buffer.from("different core graph")); return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /valid YAML without duplicate keys/u, change: (bytes) => `${bytes}\nlockfileVersion: '9.0'\n` },
    { file: "pnpm-lock.yaml", reason: /requires lockfile version/u, change: (bytes) => {
      const value = parse(bytes); value.lockfileVersion = "10.0"; return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /unsupported keys/u, change: (bytes) => {
      const value = parse(bytes); value.overrides = { zod: "4.0.0" }; return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /importers.*unsupported keys/u, change: (bytes) => {
      const value = parse(bytes); value.importers.other = {}; return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /governed SDK archive selectors/u, change: (bytes) => {
      const value = parse(bytes); value.snapshots["outside@file:../../outside.tgz"] = {}; return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /archive integrity differs/u, change: (bytes) => {
      const value = parse(bytes); value.packages[key("@agen-ai/provider-acp")].resolution.integrity = sri(Buffer.from("different archive")); return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /snapshot edge differs for zod/u, change: (bytes) => {
      const value = parse(bytes); value.snapshots[key("@agen-ai/provider-acp")].dependencies.zod = "4.19.3";
      value.packages["zod@4.19.3"] = structuredClone(value.packages["tsx@4.19.3"]); value.snapshots["zod@4.19.3"] = {};
      return stringify(value);
    } },
    { file: "pnpm-lock.yaml", reason: /snapshot dependencies.*unsupported keys/u, change: (bytes) => {
      const value = parse(bytes); value.snapshots[key("@agen-ai/provider-acp")].dependencies.tsx = "4.19.3"; return stringify(value);
    } },
  ];
  for (const { file, reason, change } of cases) {
    const target = path.join(directory, file);
    const original = await readFile(target, "utf8");
    try {
      await writeFile(target, change(original));
      await assert.rejects(readDependencyBaseline(input.baselineRoot, names), reason);
    } finally { await writeFile(target, original); }
  }
});

test("candidate SDK declaration changes and post-install lock drift are refused", async (t) => {
  const input = await fixture(t);
  const baseline = await readDependencyBaseline(input.baselineRoot, names);
  const directory = await candidateProfile(input, "consumer");
  const changed = structuredClone(input.artifacts);
  changed[0].manifest.dependencies.zod = "^4.0.0";
  await assert.rejects(seedDependencyBaseline({ baseline, profile: "consumer", consumerRoot: directory, artifacts: changed }), /SDK dependency declarations changed/u);
  const seed = await seedDependencyBaseline({ baseline, profile: "consumer", consumerRoot: directory, artifacts: input.artifacts });
  const file = path.join(directory, "pnpm-lock.yaml");
  const altered = parse(await readFile(file, "utf8"));
  altered.packages["zod@4.4.3"].resolution.integrity = sri(Buffer.from("silent registry refresh"));
  await writeFile(file, stringify(altered, { lineWidth: 0 }));
  await assert.rejects(verifyDependencyBaselineInstall(seed), /rewrote the seeded lock bytes/u);
});

test("fresh frozen offline install consumes candidate archives without reusing baseline modules", { timeout: 30_000 }, async (t) => {
  const input = await fixture(t);
  const baseline = await readDependencyBaseline(input.baselineRoot, names);
  const before = await readFile(path.join(input.baselineRoot, "consumer/pnpm-lock.yaml"));
  const payloads = new Map(await Promise.all(input.registry.map(async (entry) => [
    `/${entry.manifest.name}/-/${path.basename(entry.manifest.name)}-${entry.manifest.version}.tgz`, await readFile(entry.tarballPath),
  ])));
  const server = createServer((request, response) => {
    const requested = decodeURIComponent(request.url);
    const bytes = payloads.get(requested);
    const metadata = input.registry.find((entry) => requested === `/${entry.manifest.name}`);
    if (metadata) {
      const manifest = metadata.manifest;
      const tarball = `http://127.0.0.1:${server.address().port}/${manifest.name}/-/${path.basename(manifest.name)}-${manifest.version}.tgz`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest, dist: { tarball, integrity: sri(payloads.get(new URL(tarball).pathname)) } } },
        time: { [manifest.version]: "2020-01-01T00:00:00.000Z" } }));
    } else {
      response.writeHead(bytes ? 200 : 404); response.end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.listening ? new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) : undefined);
  const registry = `http://127.0.0.1:${server.address().port}`;
  const pnpm = await pinnedPackageManager(input.root);
  t.diagnostic(JSON.stringify({ node: process.version, pnpm: { ...pnpm, version: "11.7.0" } }));
  const cache = path.join(input.root, "cache-seed");
  const store = path.join(input.root, "store");
  await mkdir(cache);
  await cp(path.join(input.baselineRoot, "packs"), path.join(input.root, "packs"), { recursive: true });
  await writeFile(path.join(cache, "pnpm-lock.yaml"), before);
  await exec(pnpm.command, [...pnpm.args, "fetch", "--ignore-scripts", "--store-dir", store, "--registry", registry], { cwd: cache, timeout: 15_000 })
    .catch((error) => { t.diagnostic(error.stdout); t.diagnostic(error.stderr); throw error; });
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const directory = await candidateProfile(input, "consumer");
  const seed = await seedDependencyBaseline({ baseline, profile: "consumer", consumerRoot: directory, artifacts: input.artifacts });
  await exec(pnpm.command, [...pnpm.args, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", store], { cwd: directory, timeout: 15_000 })
    .catch((error) => { t.diagnostic(error.stdout); t.diagnostic(error.stderr); throw error; });
  const evidence = await verifyDependencyBaselineInstall(seed);
  const run = await exec(process.execPath, ["--input-type=module", "--eval",
    'import { value } from "@agen-ai/provider-acp"; console.log(value);'], { cwd: directory });
  assert.equal(run.stdout.trim(), "candidate:@agen-ai/provider-acp");
  assert.equal(evidence.installedLock.sha256, evidence.seededLock.sha256);
  assert.deepEqual(await readFile(path.join(input.baselineRoot, "consumer/pnpm-lock.yaml")), before);
  await assert.rejects(readFile(path.join(input.baselineRoot, "consumer/node_modules/@agen-ai/provider-acp/package.json")), { code: "ENOENT" });
});
