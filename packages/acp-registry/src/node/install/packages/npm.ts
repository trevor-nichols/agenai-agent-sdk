import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AcpPreparedInstallation } from '../contracts.js';
import type { AcpInstallPreparationContext } from '../internal.js';
import { AcpInstallationError } from '../errors.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { sha256Digest } from '../../../shared/digest.js';
import { inputRecord, PLANNING_INPUT_LIMITS } from '../../../selection/input.js';
import { packageEnvironment, packagePolicy, packageTool, packageVerification, runPackageTool, verifyPackageClosure, npmConfiguration } from './context.js';
import { installedNpmPackages, isNodeEntryPoint, ownedRegularFile, readOwnedText, resolveInstalledDependency } from './metadata.js';
import { packageSources } from './sources.js';

function normalizeResolvedLock(content: string, sources: Awaited<ReturnType<typeof packageSources>>, localUrls: ReadonlyMap<string, string>, payloadRoot: string): string {
  const lock = inputRecord(parseBoundedRegistryJson(content, PLANNING_INPUT_LIMITS), []);
  const packages = inputRecord(lock.packages, []);
  for (const [path, value] of Object.entries(packages)) {
    if (!path) continue;
    const item = inputRecord(value, []);
    const name = path.split('node_modules/').at(-1);
    const source = sources.find((candidate) => candidate.descriptor.name === name && candidate.descriptor.version === item.version);
    if (!source || typeof item.resolved !== 'string'
      || new URL(item.resolved, pathToFileURL(join(payloadRoot, 'package-lock.json'))).href !== localUrls.get(`${source.descriptor.name}@${source.descriptor.version}`)) {
      throw new AcpInstallationError('integrity_mismatch', 'The resolved npm lock contains an artifact outside its exact local acquisition map.');
    }
    item.resolved = source.descriptor.url;
  }
  return JSON.stringify(lock, null, 2) + '\n';
}

export async function prepareNpm(context: AcpInstallPreparationContext): Promise<AcpPreparedInstallation> {
  packagePolicy(context, 'npx');
  const resolution = context.plan.packageResolution!;
  const node = packageTool(context, 'node');
  const npm = packageTool(context, 'npm');
  const env = await packageEnvironment(context);
  const flags = await npmConfiguration(context);
  const sources = await packageSources(context, 'npx');
  const mirror = join(context.workRoot, 'npm-artifacts');
  await mkdir(mirror, { mode: 0o700 });
  const localUrls = new Map<string, string>();
  for (const [index, source] of sources.entries()) {
    const path = join(mirror, `${index}.tgz`);
    await copyFile(source.artifact.path, path);
    localUrls.set(`${source.descriptor.name}@${source.descriptor.version}`, pathToFileURL(path).href);
  }
  for (const source of sources) {
    const bytes = source.files['package/package.json'];
    if (!bytes) throw new AcpInstallationError('unsupported_format', 'npm tarballs must contain one package/package.json.');
    const metadata = inputRecord(parseBoundedRegistryJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), PLANNING_INPUT_LIMITS), []);
    if (metadata.name !== source.descriptor.name || metadata.version !== source.descriptor.version) throw new AcpInstallationError('integrity_mismatch', 'An npm artifact does not own its selected package identity.');
  }
  const manifest = { name: 'acp-installed-agent', version: '1.0.0', private: true, dependencies: { [resolution.name]: resolution.version } };
  let lockContent: string;
  if (resolution.dependencyLock) {
    const lock = inputRecord(parseBoundedRegistryJson(resolution.dependencyLock.content, PLANNING_INPUT_LIMITS), []);
    const packages = inputRecord(lock.packages, []);
    for (const [path, value] of Object.entries(packages)) {
      if (!path) continue;
      const item = inputRecord(value, []);
      const name = path.split('node_modules/').at(-1);
      const source = sources.find((candidate) => candidate.descriptor.name === name && candidate.descriptor.version === item.version);
      if (!source) throw new AcpInstallationError('integrity_mismatch', 'The npm lock contains an artifact outside its supplied closure.');
      item.resolved = localUrls.get(`${source.descriptor.name}@${source.descriptor.version}`)!;
    }
    await writeFile(join(context.payloadRoot, 'package.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    await writeFile(join(context.payloadRoot, 'package-lock.json'), JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
    await runPackageTool(context, node.path, [npm.path, 'ci', ...flags], env);
    lockContent = resolution.dependencyLock.content;
  } else {
    if (new Set(sources.map((source) => source.descriptor.name)).size !== sources.length) throw new AcpInstallationError('unsupported_format', 'Unlocked offline npm inputs require one explicitly selected version per package name.');
    const dependencies = Object.fromEntries(sources.map((source) => [source.descriptor.name, localUrls.get(`${source.descriptor.name}@${source.descriptor.version}`)!]));
    await writeFile(join(context.payloadRoot, 'package.json'), JSON.stringify({ ...manifest, dependencies }), { flag: 'wx', mode: 0o600 });
    await runPackageTool(context, node.path, [npm.path, 'install', ...flags], env);
    await writeFile(join(context.payloadRoot, 'package.json'), JSON.stringify(manifest), { mode: 0o600 });
    await runPackageTool(context, node.path, [npm.path, 'install', '--package-lock-only', ...flags], env);
    lockContent = normalizeResolvedLock(await readOwnedText(join(context.payloadRoot, 'package-lock.json'), context.limits.maxReceiptBytes), sources, localUrls, context.payloadRoot);
  }
  // npm's hidden lock can cache dependency metadata supplied by the input lock instead of reading installed manifests.
  await rm(join(context.payloadRoot, 'node_modules', '.package-lock.json'), { force: true });
  await runPackageTool(context, node.path, [npm.path, 'ls', '--all', '--json', ...flags], env);
  const installed = await installedNpmPackages(context.payloadRoot, Math.min(context.limits.maxEntries, 2_048));
  const packages = installed.map((owner) => ({ name: owner.name, version: owner.version,
    dependencies: Object.keys(owner.dependencies).map((name) => {
      const dependency = resolveInstalledDependency(installed, owner, name, context.payloadRoot);
      return `${dependency.name}@${dependency.version}`;
    }).sort() })).sort((left, right) => `${left.name}@${left.version}` < `${right.name}@${right.version}` ? -1 : 1);
  verifyPackageClosure(packages, resolution.dependencyLock?.packages, resolution);
  if (packages.length !== sources.length || packages.some((item) => !sources.some((source) => source.descriptor.name === item.name && source.descriptor.version === item.version))) {
    throw new AcpInstallationError('integrity_mismatch', 'The installed npm tree differs from its acquired artifact closure.');
  }
  const root = installed.find((item) => item.name === resolution.name && item.version === resolution.version)!;
  const bin = typeof root.manifest.bin === 'string'
    ? resolution.command === resolution.name.split('/').at(-1) ? root.manifest.bin : undefined
    : root.manifest.bin === undefined ? undefined : inputRecord(root.manifest.bin, [])[resolution.command];
  if (typeof bin !== 'string') throw new AcpInstallationError('integrity_mismatch', 'The selected npm package does not own this executable command.');
  const path = await ownedRegularFile(root.directory, bin);
  if (!await isNodeEntryPoint(path)) throw new AcpInstallationError('unsupported_format', 'The selected npm bin needs a JavaScript extension or an exact supported Node shebang.');
  await writeFile(join(context.payloadRoot, 'package-lock.json'), lockContent, { mode: 0o600 });
  return { launch: { command: { kind: 'toolchain', toolchain: 'node' }, args: [{ kind: 'payload-path', path: relative(context.payloadRoot, path).split('\\').join('/') },
    ...context.plan.launch.args.map((value) => ({ kind: 'literal' as const, value }))], env: context.plan.launch.env, shell: false },
    artifacts: sources.map(({ artifact: { path: _, ...evidence } }) => evidence), toolchains: [node, npm], packages,
    resolvedLock: { format: 'npm-package-lock-v3', content: lockContent, digest: sha256Digest(lockContent) }, verification: packageVerification(context) };
}
