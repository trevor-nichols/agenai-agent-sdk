import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HistoryProcessOwner } from '../process/owner.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { CodexHistoryAccess, CodexHistoryConnection } from './contracts.js';
import { assertCodexExecutable } from './identity.js';
import type { ResolvedCodexHistoryProcessOptions } from './options.js';
import { CodexStdioClient } from './transport.js';

export class CodexProcessOwner implements CodexHistoryAccess {
  private constructor(private readonly owner: HistoryProcessOwner, private readonly options: ResolvedCodexHistoryProcessOptions) {}

  static async create(options: ResolvedCodexHistoryProcessOptions): Promise<CodexProcessOwner> {
    return new CodexProcessOwner(await HistoryProcessOwner.create(options.resources.temporaryRoot, 'agenai-codex-history-'), options);
  }

  async run<T>(operation: (connection: CodexHistoryConnection) => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.owner.run(async (scope) => {
      await assertCodexExecutable(this.options.executable, scope.signal);
      scope.signal.throwIfAborted();
      const operationRoot = scope.root;
      const paths = Object.fromEntries(['home', 'config', 'cache', 'data', 'state', 'tmp'].map((name) => [name, join(operationRoot, name)]));
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
      scope.signal.throwIfAborted();
      const child = spawn(this.options.resources.resourceLauncher, [
        '--as=2147483648', '--cpu=30', '--nofile=256', '--core=0', '--', this.options.resources.sandboxLauncher,
        '--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/',
        '--bind', operationRoot, operationRoot, '--bind', this.options.configHome, this.options.configHome,
        '--proc', '/proc', '--dev', '/dev', '--chdir', operationRoot,
        this.options.executable, 'app-server', '--listen', 'stdio://',
        '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false',
        '-c', 'features.sqlite=true', '-c', 'features.apps=false', '-c', 'features.plugins=false',
        '-c', 'features.local_thread_store_compression=false', '-c', 'features.background_paginated_rollout_migration=false',
      ], { cwd: operationRoot, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: '/usr/bin:/bin', HOME: paths.home, CODEX_HOME: this.options.configHome,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
        XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache, XDG_DATA_HOME: paths.data,
        XDG_STATE_HOME: paths.state, TMPDIR: paths.tmp, LANG: 'C.UTF-8', RUST_LOG: 'error',
      } });
      const client = new CodexStdioClient(child);
      scope.ownCleanup(() => client.dispose());
      const stop = () => client.stop(new AgentHistoryError('cancelled', 'Codex history operation was cancelled.'));
      scope.signal.addEventListener('abort', stop, { once: true });
      if (scope.signal.aborted) stop();
      try {
        await client.initialize(scope.signal);
        scope.signal.throwIfAborted();
        return await operation(client);
      } finally { scope.signal.removeEventListener('abort', stop); }
    }, signal);
  }

  dispose(): Promise<void> { return this.owner.dispose(); }
}
