import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectReleaseSet } from "./verify-release-set.mjs";

const execFileAsync = promisify(execFile);
const VERSION = "0.4.0";
// The coordinated release contract is independent of the validator's package inventory.
const PACKAGES = ["validation", "agent-protocol", "agent-runtime", "agent-orchestration", "acp-transport", "provider-acp", "acp-registry"];

async function fixture(t, archives = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenai-release-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: VERSION }));
  const manifests = new Map();
  for (const slug of PACKAGES) {
    const directory = `packages/${slug}`;
    const manifest = { name: `@agen-ai/${slug}`, version: VERSION, repository: { directory } };
    manifests.set(slug, manifest);
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, "package.json"), JSON.stringify(manifest));
  }
  const releaseDirectory = path.join(root, "release");
  const tarball = (slug) => path.join(releaseDirectory, `agen-ai-${slug}-${VERSION}.tgz`);
  const pack = async (slug, manifest = manifests.get(slug)) => {
    const input = await mkdtemp(path.join(root, "pack-"));
    await mkdir(path.join(input, "package"));
    await writeFile(path.join(input, "package/package.json"), JSON.stringify(manifest));
    await execFileAsync("tar", ["-czf", tarball(slug), "-C", input, "package"]);
  };
  if (archives) {
    await mkdir(releaseDirectory);
    for (const slug of PACKAGES) await pack(slug);
  }
  return { root, releaseDirectory, tarball, pack, manifests };
}

test("admits the complete seven-package source and packed identities before publication", async (t) => {
  const input = await fixture(t, true);
  const result = await inspectReleaseSet({ repositoryRoot: input.root, releaseDirectory: input.releaseDirectory,
    releaseRef: "refs/tags/v0.4.0" });
  assert.equal(result.version, VERSION);
  assert.deepEqual(result.packages.map(({ manifest }) => manifest.name), PACKAGES.map((slug) => `@agen-ai/${slug}`));
});

test("source admission rejects missing, unknown and mixed packages", async (t) => {
  for (const scenario of [
    { name: "missing", change: (f) => rm(path.join(f.root, "packages/agent-orchestration"), { recursive: true }), expected: /Source package inventory mismatch; missing: agent-orchestration/u },
    { name: "unknown", change: (f) => mkdir(path.join(f.root, "packages/unapproved")), expected: /unknown: unapproved/u },
    { name: "mixed version", change: (f) => writeFile(path.join(f.root, "packages/provider-acp/package.json"),
      JSON.stringify({ ...f.manifests.get("provider-acp"), version: "0.3.1" })), expected: /provider-acp does not match coordinated version 0\.4\.0/u },
    { name: "wrong identity", change: (f) => writeFile(path.join(f.root, "packages/acp-transport/package.json"),
      JSON.stringify({ ...f.manifests.get("acp-transport"), name: "@other/acp-transport" })), expected: /Unexpected package identity at packages\/acp-transport/u },
  ]) {
    await t.test(scenario.name, async (context) => {
      const input = await fixture(context);
      await scenario.change(input);
      await assert.rejects(inspectReleaseSet({ repositoryRoot: input.root }), scenario.expected);
    });
  }
});

test("archive admission rejects incomplete, unknown and mislabeled release artifacts", async (t) => {
  for (const scenario of [
    { name: "missing archive", change: (f) => rm(f.tarball("agent-orchestration")), expected: /Release archive inventory mismatch; missing: agen-ai-agent-orchestration-0\.4\.0\.tgz/u },
    { name: "unknown archive", change: (f) => copyFile(f.tarball("validation"), path.join(f.releaseDirectory, "unapproved.tgz")), expected: /unknown: unapproved\.tgz/u },
    { name: "empty archive", change: (f) => writeFile(f.tarball("provider-acp"), ""), expected: /Release archive is empty: agen-ai-provider-acp/u },
    { name: "mixed packed version", change: (f) => f.pack("acp-registry", { ...f.manifests.get("acp-registry"), version: "0.3.1" }), expected: /acp-registry-0\.4\.0\.tgz has a mixed version/u },
    { name: "wrong packed identity", change: (f) => f.pack("acp-transport", f.manifests.get("validation")), expected: /acp-transport-0\.4\.0\.tgz has the wrong package identity/u },
  ]) {
    await t.test(scenario.name, async (context) => {
      const input = await fixture(context, true);
      await scenario.change(input);
      await assert.rejects(inspectReleaseSet({ repositoryRoot: input.root, releaseDirectory: input.releaseDirectory }), scenario.expected);
    });
  }
});

test("the workflow command admits an exact tag and rejects an incomplete source before packing", async (t) => {
  const input = await fixture(t);
  const scripts = path.join(input.root, "scripts/release");
  await mkdir(scripts, { recursive: true });
  for (const name of ["verify-release-set.mjs", "package-inventory.mjs", "verify-package-publication.mjs"]) {
    await copyFile(fileURLToPath(new URL(name, import.meta.url)), path.join(scripts, name));
  }
  const command = [path.join(scripts, "verify-release-set.mjs"), "--release-ref", "refs/tags/v0.4.0"];
  const admitted = await execFileAsync(process.execPath, command);
  assert.match(admitted.stdout, /Coordinated 0\.4\.0 release set admitted \(7 packages\)/u);
  await assert.rejects(execFileAsync(process.execPath, [...command.slice(0, 2), "refs/tags/v0.3.1"]),
    (error) => /Release ref does not match the coordinated version/u.test(error.stderr));
  await rm(path.join(input.root, "packages/agent-runtime"), { recursive: true });
  await assert.rejects(execFileAsync(process.execPath, command),
    (error) => /Source package inventory mismatch; missing: agent-runtime/u.test(error.stderr));
});
