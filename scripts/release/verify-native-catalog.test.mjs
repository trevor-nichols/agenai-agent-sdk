import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PUBLIC_PACKAGE_POLICIES } from "./package-inventory.mjs";
import { HELPER_FILES, NATIVE_CATALOG_TUPLE } from "./native-catalog/policy.mjs";

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL("./", import.meta.url));
const templateRoot = fileURLToPath(new URL("../../", import.meta.url));
const version = "0.4.11";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const protocolRelative = "scripts/development/agent-sandbox-qualification/capabilities/catalog/protocol.mjs";
const protocolSource = await readFile(path.join(templateRoot, protocolRelative)).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return readFile(new URL("../../../../development/agent-sandbox-qualification/capabilities/catalog/protocol.mjs", import.meta.url));
});

// These fake policy, observations and archives exist only in a task-owned temporary repository.
// Their tuple deliberately differs from production policy, so their record cannot qualify a real release.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-native-catalog-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts/release");
  await mkdir(scripts, { recursive: true });
  for (const file of ["verify-native-catalog.mjs", "verify-release-set.mjs", "verify-package-publication.mjs", "package-inventory.mjs"]) {
    await copyFile(path.join(source, file), path.join(scripts, file));
  }
  await cp(path.join(source, "native-catalog"), path.join(scripts, "native-catalog"), { recursive: true });
  await mkdir(path.dirname(path.join(root, protocolRelative)), { recursive: true });
  await writeFile(path.join(root, protocolRelative), protocolSource);
  await writeFile(path.join(root, protocolRelative.replace("protocol.mjs", "run.mjs")), "// Synthetic fixture execution owner; never executed.\n");
  await writeFile(path.join(root, "package.json"), json({ version, type: "module" }));
  const archiveData = [];
  for (const policy of PUBLIC_PACKAGE_POLICIES) {
    const manifest = { name: policy.name, version, repository: { directory: policy.root },
      dependencies: { "fixture-first": "1.0.0", "fixture-second": "2.0.0" },
      exports: { ".": { import: "./dist/index.js", default: "./dist/fallback.js" } } };
    await mkdir(path.join(root, policy.root), { recursive: true });
    await writeFile(path.join(root, policy.root, "package.json"), json(manifest));
    const files = { "package.json": JSON.stringify(manifest, null, 2), "dist/index.js": 'export const fixture = "synthetic";\n', "README.md": "Synthetic fixture only.\n" };
    if (policy.name === "@agen-ai/sandbox-docker") for (const local of HELPER_FILES) files[`dist/${local}`] = `// Synthetic ${local}\n`;
    archiveData.push({ name: policy.name, files });
  }
  const tuple = structuredClone(NATIVE_CATALOG_TUPLE);
  tuple.workloadImage = `sha256:${"f".repeat(64)}`;
  tuple.helper.image = `sha256:${"e".repeat(64)}`;
  const helper = HELPER_FILES.map((local) => ({ path: local, sha256: hash(`// Synthetic ${local}\n`) }));
  tuple.helper.sourceDigest = `sha256:${hash(JSON.stringify(helper))}`;
  await writeFile(path.join(scripts, "native-catalog/policy.mjs"), `// Deliberately synthetic isolated-test policy.\nexport const NATIVE_CATALOG_TUPLE=${JSON.stringify(tuple)};\nexport const HELPER_FILES=${JSON.stringify(HELPER_FILES)};\n`);
  const protocol = await import(pathToFileURL(path.join(root, protocolRelative)).href);
  const guestConfig = { format: "agenai.native-catalog-guest-config.v1", observation: "native",
    native: { executable: tuple.native.executable, bytes: tuple.native.bytes, sha256: tuple.native.sha256 },
    profile: "/workspace/work/native-state/grok", project: "/workspace/work/project", authFile: "/home/sandbox/.agenai-credentials/grok-auth.json" };
  const configuration = { format: "agenai.native-catalog-configuration.v1", platform: { profile: tuple.profile,
    expected: { controller: { os: "darwin", architecture: "arm64", nodeVersion: "24.18.0" },
      daemon: { id: "synthetic-daemon", version: "29.1.2", apiVersion: "1.52", architecture: "arm64", kernelVersion: "6.12.54-linuxkit" } },
    desktop: { version: "4.54.0", vmm: "apple-virtualization", rosetta: true, enhancedContainerIsolation: false } },
  workload: { imageDigest: tuple.workloadImage, user: { uid: 65534, gid: 65534 } }, native: structuredClone(tuple.native), bootstrap: structuredClone(tuple.bootstrap),
  credential: "first_party_oidc_access_only", destinations: ["cli-chat-proxy.grok.com", "api.x.ai", "assets.grok.com", "auth.x.ai", "grok.com"].map((hostname) => ({ hostname, port: 443 })),
  files: "disabled", modelTasks: 0, observationMs: 45000, cleanupMs: 30000, requestMs: 30000,
  guest: { process: { executable: "/usr/local/bin/node", args: ["/workspace/work/catalog/guest/run.mjs", "/workspace/work/catalog/config.json"], cwd: "/workspace/work",
    env: { HOME: "/home/sandbox", TMPDIR: "/tmp", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } },
  configuration: guestConfig, nativeLaunch: protocol.nativeLaunch(guestConfig), limits: protocol.limits },
  helperBaseImage: tuple.helper.baseImage, egress: { sourceDigest: tuple.helper.sourceDigest,
    configuration: { imageDigest: tuple.helper.image, protocol: tuple.helper.protocol, user: tuple.helper.user } },
  routeAuthority: { kind: "local_docker_desktop", profile: tuple.profile, stability: "caller_owned_quiescence",
    interception: "caller_owned_no_transparent_or_per_app_interception", engine: { id: "synthetic-daemon", endpoint: "selected_local_engine" },
    deployment: { desktopVersion: "4.54.0", desktopBuild: "212467", virtualMachineManager: "apple_virtualization", rosetta: true,
      enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false, networkingMode: "ipv4only", manualProxyConfiguration: false } } };
  const directory = path.join(root, "qualification/native-catalog"); await mkdir(directory, { recursive: true });
  const configPath = path.join(directory, `configuration-${version}.json`);
  await writeFile(configPath, json(configuration));
  const repack = async () => {
    await execFileAsync("python3", ["-c", `import io,json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]);(root/'release').mkdir(exist_ok=True)
for archive in json.loads(sys.argv[2]):
 name=archive['name'].replace('@','').replace('/','-')+'-${version}.tgz'
 with tarfile.open(root/'release'/name,'w:gz') as output:
  for local,text in archive['files'].items():
   data=text.encode();entry=tarfile.TarInfo('package/'+local);entry.size=len(data);entry.mode=0o644
   output.addfile(entry,io.BytesIO(data))
`, root, JSON.stringify(archiveData)]);
  };
  await repack();
  const bindingsModule = await import(pathToFileURL(path.join(scripts, "native-catalog/bindings.mjs")).href);
  const bindings = () => bindingsModule.inspectCatalogBindings({ repositoryRoot: root, releaseDirectory: "release", releaseRef: `refs/tags/v${version}` });
  const record = { format: "agenai.native-catalog.v1", version,
    provenance: { kind: "native", runId: "isolated-synthetic-fixture", observedAt: "2026-11-03T00:00:00.000Z", sourceRevision: "1".repeat(40), reportSha256: "2".repeat(64) },
    tuple, bindings: await bindings(),
    guestResult: { format: "agenai.native-catalog-guest.v1", observation: "native", status: "passed",
      runtime: { node: "v24.18.0", platform: "linux", architecture: "arm64", uid: 65534, gid: 65534 },
      transport: { status: "initialized", protocolVersion: 1 }, refresh: { status: "confirmed", endpoint: protocol.endpoint,
        events: ["http_fetch_started", "http_fetch_completed", "prefetch_completed", "catalog_requested", "catalog_observed"]
          .map((kind, index) => ({ sequence: index + 1, kind, count: ["http_fetch_completed", "prefetch_completed"].includes(kind) ? 2 : null })) },
      authentication: { status: "acknowledged", method: "oidc", cachedTokenAdvertised: false, cachedTokenRequested: false, acknowledged: true },
      catalog: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Synthetic Grok 4.6" }], grok47Advertised: false },
      requests: ["initialize", "_x.ai/auth/info", "_x.ai/models/list"], modelTasks: 0,
      termination: { code: 0, signal: null, forced: false },
      cleanup: { nativeJoined: true, stdoutJoined: true, stderrJoined: true }, failure: null },
    host: { freshProfile: true, accessOnly: true, loginOrRefresh: false, modelTasks: 0,
      cleanup: { originalOwner: true, nativeJoined: true, readerJoined: true, observersJoined: true, sandboxDestroyed: true,
        independentAbsence: true, resourceCount: 3, absentCount: 3 } } };
  const recordPath = path.join(directory, `${version}.json`);
  const save = () => writeFile(recordPath, json(record)); await save();
  const run = (releaseDirectory = "release") => execFileAsync(process.execPath,
    [path.join(scripts, "verify-native-catalog.mjs"), "--release-ref", `refs/tags/v${version}`, "--release-directory", releaseDirectory], { cwd: root, timeout: 30_000 });
  return { root, directory, recordPath, configPath, configuration, record, archiveData, repack, bindings, run, save };
}

test("actual CLI verifies isolated fake archive bindings and restored bytes without node_modules", async (t) => {
  const input = await fixture(t);
  await assert.rejects(readFile(path.join(input.root, "node_modules/package.json")), { code: "ENOENT" });
  const first = JSON.parse((await input.run()).stdout);
  assert.deepEqual(first, { proof: "reviewed-native-catalog-applicability", version, nativeRun: "isolated-synthetic-fixture",
    archives: 10, remoteRefresh: "confirmed", grok47Advertised: false, repacked: false });
  input.record.bindings.archives = input.record.bindings.archives.map(({ name, bytes, sha256 }) => ({ sha256, bytes, name }));
  await input.save();
  assert.deepEqual(JSON.parse((await input.run()).stdout), first);
  await cp(path.join(input.root, "release"), path.join(input.root, "restored-release"), { recursive: true });
  assert.deepEqual(JSON.parse((await input.run("restored-release")).stdout), first);
  await copyFile(path.join(source, "native-catalog/policy.mjs"), path.join(input.root, "scripts/release/native-catalog/policy.mjs"));
  await assert.rejects(input.run(), (error) => /differs from reviewed policy/u.test(error.stderr));
});

test("actual CLI rejects absent, synthetic, failed, fallback and incomplete native evidence", async (t) => {
  const input = await fixture(t);
  const original = structuredClone(input.record);
  for (const scenario of [
    { name: "synthetic", change: (r) => { r.provenance.kind = "synthetic"; }, error: /Synthetic catalog evidence/u },
    { name: "scripted guest", change: (r) => { r.guestResult.observation = "scripted"; }, error: /Scripted guest/u },
    { name: "failed", change: (r) => { r.guestResult.status = "failed"; r.guestResult.failure = "remote_fetch_failed"; }, error: /outcome is failed/u },
    { name: "unproven", change: (r) => { r.guestResult.status = "unproven"; r.guestResult.failure = "remote_unproven"; }, error: /outcome is failed/u },
    { name: "fallback list", change: (r) => { r.guestResult.status = "unproven"; r.guestResult.failure = "remote_unproven";
      r.guestResult.refresh.status = "unproven"; r.guestResult.refresh.events = [{ sequence: 1, kind: "fallback", count: null }]; }, error: /outcome is failed/u },
    { name: "host cleanup", change: (r) => { r.host.cleanup.originalOwner = false; }, error: /cleanup is incomplete/u },
    { name: "guest reader cleanup", change: (r) => { r.guestResult.cleanup.stderrJoined = false; }, error: /CatalogGuestError/u },
    { name: "independent absence", change: (r) => { r.host.cleanup.absentCount = 2; }, error: /absence is incomplete/u },
    { name: "native tuple", change: (r) => { r.tuple.native.sha256 = "a".repeat(64); }, error: /differs from reviewed policy/u },
    { name: "helper tuple", change: (r) => { r.tuple.helper.image = `sha256:${"a".repeat(64)}`; }, error: /differs from reviewed policy/u },
  ]) {
    await t.test(scenario.name, async () => {
      Object.assign(input.record, structuredClone(original)); scenario.change(input.record); await input.save();
      await assert.rejects(input.run(), (error) => scenario.error.test(error.stderr));
    });
  }
  await rm(input.recordPath);
  await assert.rejects(input.run(), (error) => /ENOENT/u.test(error.stderr));
});

test("actual CLI rejects changed runtime/helper/harness/config even when copied evidence claims consistency", async (t) => {
  const input = await fixture(t);
  await writeFile(path.join(input.root, protocolRelative.replace("protocol.mjs", "run.mjs")), "// changed synthetic execution owner\n");
  await assert.rejects(input.run(), (error) => /harness applicability is stale/u.test(error.stderr));
  await writeFile(path.join(input.root, protocolRelative.replace("protocol.mjs", "run.mjs")), "// Synthetic fixture execution owner; never executed.\n");
  await writeFile(input.configPath, json(input.configuration) + "\n");
  await assert.rejects(input.run(), (error) => /configuration applicability is stale/u.test(error.stderr));
  input.configuration.native.sha256 = "a".repeat(64);
  await writeFile(input.configPath, json(input.configuration)); input.record.bindings = await input.bindings(); await input.save();
  await assert.rejects(input.run(), (error) => /different native binary/u.test(error.stderr));
  input.configuration.native = structuredClone(NATIVE_CATALOG_TUPLE.native);
  await writeFile(input.configPath, json(input.configuration)); input.record.bindings = await input.bindings(); await input.save();
  const runtime = input.archiveData.find(({ name }) => name === "@agen-ai/agent-runtime"); runtime.files["dist/index.js"] += "// changed\n";
  await input.repack();
  await assert.rejects(input.run(), (error) => /ENOENT/u.test(error.stderr));
  runtime.files["dist/index.js"] = 'export const fixture = "synthetic";\n';
  const docker = input.archiveData.find(({ name }) => name === "@agen-ai/sandbox-docker"); docker.files["dist/network/policy.js"] += "// changed\n";
  await input.repack(); input.record.bindings = await input.bindings(); await input.save();
  await assert.rejects(input.run(), (error) => /Shipped helper differs/u.test(error.stderr));
});

test("documentation repacks require an exact reviewed pair and cannot replace executable payload", async (t) => {
  const input = await fixture(t);
  input.archiveData[0].files["README.md"] += "Documentation-only update.\n"; await input.repack();
  await assert.rejects(input.run(), (error) => /ENOENT/u.test(error.stderr));
  const actual = await input.bindings();
  const pair = { format: "agenai.native-catalog-repack.v1", evidenceSha256: hash(await readFile(input.recordPath)), purpose: "nonbehavioral_packaging",
    qualifiedArchives: input.record.bindings.archives, releaseArchives: actual.archives, payloads: actual.payloads, qualifiedManifests: [] };
  const pairPath = path.join(input.directory, `${version}-repack.json`); await writeFile(pairPath, json(pair));
  assert.equal(JSON.parse((await input.run()).stdout).repacked, true);
  pair.releaseArchives[0].sha256 = "0".repeat(64); await writeFile(pairPath, json(pair));
  await assert.rejects(input.run(), (error) => /stale final archive/u.test(error.stderr));
});

test("a reviewed dependency-order repack preserves the original payload commitment and conditional export order", async (t) => {
  const input = await fixture(t);
  const archive = input.archiveData.find(({ name }) => name === "@agen-ai/agent-orchestration");
  const originalManifest = archive.files["package.json"];
  const reordered = JSON.parse(originalManifest);
  reordered.dependencies = Object.fromEntries(Object.entries(reordered.dependencies).reverse());
  archive.files["package.json"] = JSON.stringify(reordered, null, 2);
  const pairPath = path.join(input.directory, `${version}-repack.json`);
  const pair = { format: "agenai.native-catalog-repack.v1", evidenceSha256: hash(await readFile(input.recordPath)), purpose: "nonbehavioral_packaging",
    qualifiedArchives: input.record.bindings.archives, qualifiedManifests: [{ name: archive.name, manifest: originalManifest }] };
  const savePair = async () => {
    await input.repack();
    const actual = await input.bindings();
    await writeFile(pairPath, json({ ...pair, releaseArchives: actual.archives, payloads: actual.payloads }));
  };
  await savePair();
  assert.deepEqual(JSON.parse((await input.run()).stdout), { proof: "reviewed-native-catalog-applicability", version,
    nativeRun: "isolated-synthetic-fixture", archives: 10, remoteRefresh: "confirmed", grok47Advertised: false, repacked: true });

  for (const scenario of ["dependency value", "conditional export order", "runtime bytes", "forged original manifest", "missing manifest"]) {
    await t.test(scenario, async () => {
      const changed = structuredClone(reordered);
      pair.qualifiedManifests = [{ name: archive.name, manifest: originalManifest }];
      if (scenario === "dependency value") changed.dependencies["fixture-first"] = "9.0.0";
      if (scenario === "conditional export order") changed.exports["."] = Object.fromEntries(Object.entries(changed.exports["."]).reverse());
      if (scenario === "forged original manifest") pair.qualifiedManifests[0].manifest = JSON.stringify(reordered, null, 2);
      if (scenario === "missing manifest") pair.qualifiedManifests = [];
      archive.files["package.json"] = JSON.stringify(changed, null, 2);
      archive.files["dist/index.js"] = scenario === "runtime bytes" ? 'export const fixture = "changed";\n' : 'export const fixture = "synthetic";\n';
      await savePair();
      await assert.rejects(input.run(), (error) => /dependency ordering|payloads applicability is stale|qualified manifest inventory/u.test(error.stderr));
    });
  }
});

test("self-consistent copied configuration bindings cannot change helper identity, bootstrap or authority", async (t) => {
  const input = await fixture(t), original = structuredClone(input.configuration);
  for (const change of [
    (value) => { value.bootstrap.sha256 = "b".repeat(64); },
    (value) => { value.egress.configuration.imageDigest = `sha256:${"b".repeat(64)}`; },
    (value) => { value.helperBaseImage = `sha256:${"b".repeat(64)}`; },
    (value) => { value.files = "read_write"; },
    (value) => { value.guest.nativeLaunch.env.XAI_API_KEY = "synthetic-forbidden-credential"; },
  ]) {
    const changed = structuredClone(original); change(changed);
    await writeFile(input.configPath, json(changed)); input.record.bindings = await input.bindings(); await input.save();
    await assert.rejects(input.run(), (error) => error.code === 1);
  }
});

test("archive inspection rejects links and duplicate payload members before applicability comparison", async (t) => {
  const input = await fixture(t);
  const file = path.join(input.root, `release/agen-ai-validation-${version}.tgz`);
  for (const scenario of ["link", "duplicate"]) {
    await input.repack();
    await execFileAsync("python3", ["-c", `import io,pathlib,sys,tarfile
target=pathlib.Path(sys.argv[1]);records=[]
with tarfile.open(target,'r:gz') as source:
 for entry in source:
  records.append((entry,source.extractfile(entry).read()))
with tarfile.open(target,'w:gz') as output:
 for entry,data in records:output.addfile(entry,io.BytesIO(data))
 entry=tarfile.TarInfo('package/dist/index.js' if sys.argv[2]=='duplicate' else 'package/unsafe')
 if sys.argv[2]=='link':entry.type=tarfile.SYMTYPE;entry.linkname='/outside'
 output.addfile(entry,io.BytesIO())
`, file, scenario]);
    await assert.rejects(input.run(), (error) => /Unsafe or duplicate catalog archive member|must be bounded regular files/u.test(error.stderr));
  }
});
