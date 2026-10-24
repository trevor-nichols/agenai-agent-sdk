import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { HistoryProcessOwner } from '../process/owner.js';
import { terminateProcessGroup, waitForGroupExit } from '../process/group.js';
import type { GrokHistoryAccess, GrokHistoryConnection, GrokManagementAccess, GrokManagementConnection } from './contracts.js';
import { assertGrokExecutable, openGrokStore, type GrokSessionStore } from './identity.js';
import type { ResolvedGrokProcessOptions } from './options.js';
import { openGrokTransport } from './transport.js';
import { openGrokSearchProjects, type GrokProjectMount } from './mounts.js';

export class GrokProcessOwner implements GrokHistoryAccess, GrokManagementAccess {
  private constructor(private readonly owner: HistoryProcessOwner, private readonly options: ResolvedGrokProcessOptions,
    private readonly store: GrokSessionStore) {}

  static async create(options: ResolvedGrokProcessOptions, store: GrokSessionStore): Promise<GrokProcessOwner> {
    return new GrokProcessOwner(await HistoryProcessOwner.create(options.resources.temporaryRoot, 'agenai-grok-history-'), options, store);
  }

  run<T>(operation: (connection: GrokHistoryConnection) => Promise<T>, signal: AbortSignal, mode: 'read' | 'content-search' = 'read'): Promise<T> {
    return this.execute(operation, signal, mode);
  }

  mutate<T>(operation: (connection: GrokManagementConnection) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.options.localManagement === undefined) throw new AgentHistoryError('unsupported_scope', 'Grok local management requires caller-owned quiescence.');
    return this.execute(operation, signal, 'mutation');
  }

  private execute<T>(operation: (connection: GrokHistoryConnection & GrokManagementConnection) => Promise<T>, signal: AbortSignal,
    mode: 'read' | 'content-search' | 'mutation'): Promise<T> {
    return this.owner.run(async (scope) => {
      await assertGrokExecutable(this.options.executable, scope.signal);
      const store = await openGrokStore(this.store);
      let projects: readonly GrokProjectMount[] = [];
      const closeFiles = async () => { await Promise.all(projects.map((project) => project.handle.close())); await store.close(); };
      scope.ownCleanup(closeFiles);
      if (mode === 'content-search') projects = await openGrokSearchProjects(store);
      const paths = Object.fromEntries(['home', 'config', 'cache', 'data', 'state', 'tmp', 'grok'].map((name) => [name, join(scope.root, name)]));
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
      await mkdir(join(scope.root, 'grok', 'sessions'), { mode: 0o700 });
      const sandboxRoot = '/tmp/agenai-grok-history', grokHome = `${sandboxRoot}/grok`;
      const sandboxExecutable = `${sandboxRoot}/native-grok`;
      const mountArgs = mode === 'content-search'
        ? projects.flatMap((project, index) => ['--ro-bind-fd', String(index + 3), `${grokHome}/sessions/${project.name}`])
        : [mode === 'mutation' ? '--bind-fd' : '--ro-bind-fd', '3', `${grokHome}/sessions`];
      scope.signal.throwIfAborted();
      const child = spawn(this.options.resources.resourceLauncher, [
        '--as=4294967296', '--cpu=20', '--nofile=256', '--core=0', '--', this.options.resources.sandboxLauncher,
        '--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/',
        '--tmpfs', '/tmp', '--bind', scope.root, sandboxRoot, '--ro-bind', this.options.executable, sandboxExecutable,
        '--tmpfs', '/etc', '--proc', '/proc', '--dev', '/dev',
        ...mountArgs, '--chdir', sandboxRoot,
        sandboxExecutable, 'agent', '--no-leader', 'stdio',
      ], { cwd: scope.root, detached: true, stdio: ['pipe', 'pipe', 'pipe',
        ...(mode === 'content-search' ? projects.map((project) => project.handle.fd) : [store.fd])], env: {
        PATH: '/usr/bin:/bin', HOME: `${sandboxRoot}/home`, GROK_HOME: grokHome, XDG_CONFIG_HOME: `${sandboxRoot}/config`,
        XDG_CACHE_HOME: `${sandboxRoot}/cache`, XDG_DATA_HOME: `${sandboxRoot}/data`, XDG_STATE_HOME: `${sandboxRoot}/state`,
        TMPDIR: `${sandboxRoot}/tmp`, LANG: 'C.UTF-8', RUST_LOG: 'error', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true',
      } });
      const close = new Promise<void>((resolve) => child.once('close', () => resolve()));
      // Register ownership before importing the optional transport or waiting for initialization.
      let cleanup = async () => {
        if (child.pid !== undefined) terminateProcessGroup(child.pid);
        await close;
        if (child.pid !== undefined) await waitForGroupExit(child.pid);
      };
      scope.ownCleanup(async () => { await cleanup(); await closeFiles(); });
      child.once('error', () => {});
      const active = await openGrokTransport(child, mode === 'mutation' ? this.options.management : []);
      cleanup = () => active.dispose();
      const stop = () => active.stop();
      scope.signal.addEventListener('abort', stop, { once: true });
      if (scope.signal.aborted) stop();
      try {
        const connection = await active.initialize(scope.signal, this.options.limits.maximumDeadlineMs);
        if (scope.signal.aborted) throw new AgentHistoryError('cancelled', 'Grok history operation was cancelled.');
        return await operation(connection);
      } finally { scope.signal.removeEventListener('abort', stop); }
    }, signal);
  }

  dispose(): Promise<void> { return this.owner.dispose(); }
}
