import { mkdir, readFile, stat } from 'node:fs/promises';
import { prepareNodeProviderWorkspace } from '@agen-ai/provider-tools/node';
import { AcceptEditsConfigError, parseAcceptEditsConfig } from './config.js';
import { exactListDecider } from './decisions.js';
import { terminalDecider } from './interactive.js';
import { AcceptEditsCleanupPendingError, failureCode } from './report.js';
import { runAcceptEdits } from './run.js';

export const acceptEditsHelp = [
  'Accept-edits example for the Claude and OpenCode Node providers (Linux x64/arm64, Node 24.18.0).',
  'Commands: --help | check-config --config ABS.json | prepare --config ABS.json | run --config ABS.json',
  'check-config reads only the configuration. prepare creates or validates the private workspace store and state parent.',
  'run opens one fresh session with the configured policy and executes one text turn with a real provider.',
  'The policy is discovered from the instance; an unsupported policy is refused before any session opens.',
  'Edits outside protected or restricted paths apply without a prompt under provider_accept_edits.',
  'Every shell command asks. Approvals are once-only for the exact action; unlisted actions are denied.',
  'The API key is read from a private file. Native binaries must match the installed package pins.',
].join('\n');

async function readConfig(path: string | undefined) {
  if (!path?.startsWith('/')) throw new AcceptEditsConfigError('The configuration path must be absolute.');
  const state = await stat(path).catch((cause: unknown) => { throw new AcceptEditsConfigError(cause); });
  if (!state.isFile() || state.size > 256 * 1024) throw new AcceptEditsConfigError('The configuration must be a regular file up to 256 KiB.');
  const text = await readFile(path, 'utf8');
  try { return parseAcceptEditsConfig(JSON.parse(text)); }
  catch (cause) { throw cause instanceof AcceptEditsConfigError ? cause : new AcceptEditsConfigError(cause); }
}

export async function acceptEditsCommand(argv: readonly string[], signal?: AbortSignal): Promise<Readonly<{ exitCode: number; output: unknown }>> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return { exitCode: 0, output: { help: acceptEditsHelp } };
  const [command, flag, path] = argv;
  if (argv.length !== 3 || flag !== '--config' || (command !== 'check-config' && command !== 'prepare' && command !== 'run')) {
    return { exitCode: 2, output: { failed: true, code: 'usage', help: acceptEditsHelp } };
  }
  const config = await readConfig(path);
  if (command === 'check-config') {
    return { exitCode: 0, output: { valid: true, provider: config.provider, route: config.route, model: config.model,
      requestedPolicy: config.policy, approvals: config.approvals.kind, nativeExecution: false } };
  }
  if (command === 'prepare') {
    await mkdir(config.workspace.stateParentDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const workspace = await prepareNodeProviderWorkspace({ directory: config.workspace.storeDirectory });
    return { exitCode: 0, output: { prepared: true, storeDirectory: workspace.storeDirectory,
      workspaceDirectory: workspace.workspaceDirectory, nativeExecution: false } };
  }
  const { approvals, ...run } = config;
  const decide = approvals.kind === 'exact' ? exactListDecider(approvals) : terminalDecider();
  const report = await runAcceptEdits(run, { decide, ...(signal ? { signal } : {}) });
  return { exitCode: report.status === 'completed' ? 0 : 1, output: report };
}

/** Safe failure output: codes and report fields only, never raw native diagnostics or credentials. */
export function safeFailure(error: unknown) {
  if (error instanceof AcceptEditsCleanupPendingError) {
    return { ...error.report, cleanupOwner: 'original_in_process_retry_only',
      message: 'Cleanup is pending. Keep this process alive and retry its original owners; the turn is never replayed.' };
  }
  return { failed: true, code: failureCode(error), message: 'The accept-edits example stopped before a session report was available.' };
}
