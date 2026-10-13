import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpInstalledPackage, AcpPreparedInstallation } from '../contracts.js';
import type { AcpInstallPreparationContext } from '../internal.js';
import { AcpInstallationError } from '../errors.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import { sha256Digest } from '../../../shared/digest.js';
import { inputRecord, inputString, PLANNING_INPUT_LIMITS } from '../../../selection/input.js';
import { packageEnvironment, packagePolicy, packageTool, packageVerification, runPackageTool, verifyPackageClosure } from './context.js';
import { ownedRegularFile } from './metadata.js';
import { packageSources } from './sources.js';
import { pythonLaunchScript, pythonMetadataScript } from './python-scripts.js';

interface PythonPackage {
  readonly name: string;
  readonly version: string;
  readonly requires: readonly string[];
  readonly files: readonly string[];
  readonly entryPoints: readonly { readonly name: string; readonly group: string; readonly value: string }[];
}

function pythonName(value: string): string { return value.toLowerCase().replace(/[-_.]+/g, '-'); }

function pythonMetadata(output: string): readonly PythonPackage[] {
  const data = parseBoundedRegistryJson(output, PLANNING_INPUT_LIMITS);
  if (!Array.isArray(data) || data.length > 2_048) throw new AcpInstallationError('limit_exceeded', 'Python installed metadata exceeds its bounded package profile.');
  return data.map((item) => {
    const value = inputRecord(item, []);
    if (!Array.isArray(value.requires) || !Array.isArray(value.files) || !Array.isArray(value.entryPoints)) throw new AcpInstallationError('integrity_mismatch', 'Python distribution metadata is incomplete.');
    return { name: pythonName(inputString(value.name, [], 214)), version: inputString(value.version, [], 128),
      requires: value.requires.map((entry) => inputString(entry, [], 1_024)), files: value.files.map((entry) => inputString(entry, [], 1_024)),
      entryPoints: value.entryPoints.map((entry) => { const point = inputRecord(entry, []); return {
        name: inputString(point.name, [], 128), group: inputString(point.group, [], 128), value: inputString(point.value, [], 512) }; }) };
  });
}

function dependencyName(requirement: string): string {
  // uv verifies version constraints. This profile excludes conditional/extras/direct-source graph semantics.
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*(?:\([^\r\n;@\[\]]+\)|[<>=!~][^\r\n;@\[\]]+))?\s*$/.exec(requirement);
  if (!match) throw new AcpInstallationError('unsupported_format', 'Conditional, extra and direct-source Python requirements are unsupported.');
  return pythonName(match[1]!);
}

export async function prepareUv(context: AcpInstallPreparationContext): Promise<AcpPreparedInstallation> {
  packagePolicy(context, 'uvx');
  const resolution = context.plan.packageResolution!;
  const python = packageTool(context, 'python');
  const uv = packageTool(context, 'uv');
  const env = await packageEnvironment(context);
  const sources = await packageSources(context, 'uvx');
  const wheelhouse = join(context.workRoot, 'wheelhouse');
  const site = join(context.payloadRoot, 'site-packages');
  await mkdir(wheelhouse, { mode: 0o700 });
  await mkdir(site, { mode: 0o700 });
  for (const source of sources) await copyFile(source.artifact.path, join(wheelhouse, source.descriptor.filename));
  const resolvedContent = sources.map(({ descriptor }) => `${descriptor.name}==${descriptor.version} --hash=sha256:${descriptor.sha256.slice(7)}`).join('\n') + '\n';
  const lockContent = resolution.dependencyLock?.content ?? resolvedContent;
  const requirements = join(context.workRoot, 'requirements.txt');
  await writeFile(requirements, lockContent, { flag: 'wx', mode: 0o600 });
  await runPackageTool(context, uv.path, ['--no-config', '--no-cache', '--no-managed-python', '--no-python-downloads', 'pip', 'install',
    '--offline', '--no-index', '--find-links', wheelhouse, '--require-hashes', '--only-binary', ':all:', '--no-sources',
    '--link-mode', 'copy', '--python', python.path, '--target', site, '--requirements', requirements], env);
  const inspection = join(context.workRoot, 'inspect-python.py');
  await writeFile(inspection, pythonMetadataScript, { flag: 'wx', mode: 0o600 });
  const metadata = pythonMetadata(await runPackageTool(context, python.path, ['-I', '-B', '-S', inspection, site], env));
  const packages: AcpInstalledPackage[] = metadata.map((item) => ({ name: item.name, version: item.version,
    dependencies: item.requires.map((requirement) => {
      const name = dependencyName(requirement);
      const dependency = metadata.find((candidate) => candidate.name === name);
      if (!dependency) throw new AcpInstallationError('integrity_mismatch', 'A Python package requires an absent dependency.');
      return `${dependency.name}@${dependency.version}`;
    }).sort() })).sort((left, right) => `${left.name}@${left.version}` < `${right.name}@${right.version}` ? -1 : 1);
  verifyPackageClosure(packages, resolution.dependencyLock?.packages, resolution);
  if (packages.length !== sources.length || packages.some((item) => !sources.some((source) => source.descriptor.name === item.name && source.descriptor.version === item.version))) {
    throw new AcpInstallationError('integrity_mismatch', 'The installed Python distributions differ from their acquired artifact closure.');
  }
  if (metadata.some((item) => item.files.some((path) => path.endsWith('.pth')))) throw new AcpInstallationError('unsupported_format', 'Python path initialization files are unsupported by the isolated launch profile.');
  const root = metadata.find((item) => item.name === resolution.name && item.version === resolution.version)!;
  const points = root.entryPoints.filter((item) => item.group === 'console_scripts' && item.name === resolution.command);
  const point = points.length === 1 ? /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*):([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/.exec(points[0]!.value) : undefined;
  if (!point) throw new AcpInstallationError('integrity_mismatch', 'The selected Python distribution does not own this supported console-script command.');
  const moduleName = point[1]!;
  const candidates = [`${moduleName.replaceAll('.', '/')}.py`, `${moduleName.replaceAll('.', '/')}/__init__.py`];
  const owned = candidates.find((path) => root.files.includes(path));
  if (!owned || metadata.some((item) => item !== root && item.files.includes(owned))) throw new AcpInstallationError('integrity_mismatch', 'The console-script module must be uniquely owned by the selected Python distribution.');
  await ownedRegularFile(site, owned);
  await writeFile(join(context.payloadRoot, 'launch.py'), pythonLaunchScript(moduleName, point[2]!, resolution.command), { flag: 'wx', mode: 0o600 });
  await writeFile(join(context.payloadRoot, 'requirements.txt'), lockContent, { flag: 'wx', mode: 0o600 });
  return { launch: { command: { kind: 'toolchain', toolchain: 'python' }, args: [
    { kind: 'literal', value: '-I' }, { kind: 'literal', value: '-B' }, { kind: 'literal', value: '-S' }, { kind: 'payload-path', path: 'launch.py' },
    ...context.plan.launch.args.map((value) => ({ kind: 'literal' as const, value }))], env: context.plan.launch.env, shell: false },
    artifacts: sources.map(({ artifact: { path: _, ...evidence } }) => evidence), toolchains: [python, uv], packages,
    resolvedLock: { format: 'python-requirements-hashes', content: lockContent, digest: sha256Digest(lockContent) }, verification: packageVerification(context) };
}
