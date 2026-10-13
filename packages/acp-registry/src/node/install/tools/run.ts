import { spawn } from 'node:child_process';
import type { AcpInstallToolResult, RunAcpInstallToolInput } from '../internal.js';
import { AcpInstallationError } from '../errors.js';

/** Internal trusted-tool runner. Callers supply the complete environment and literal arguments. */
export function runAcpInstallTool(input: RunAcpInstallToolInput): Promise<AcpInstallToolResult> {
  if (input.signal?.aborted) return Promise.reject(new AcpInstallationError('aborted', 'Installation tool was canceled before launch.'));
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: { ...input.env }, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const stdout = Buffer.allocUnsafe(input.maxOutputBytes), stderr = Buffer.allocUnsafe(input.maxOutputBytes);
    let stdoutBytes = 0, stderrBytes = 0;
    let bytes = 0;
    let failure: AcpInstallationError | undefined;
    let closed = false;
    const terminate = (error: AcpInstallationError) => {
      failure ??= error;
      if (closed) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') failure = new AcpInstallationError('tool_failed', 'Installation tool cleanup failed.', { cause });
      }
      // A child can leave inherited pipes in a descendant outside its process group.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const onAbort = () => terminate(new AcpInstallationError('aborted', 'Installation tool was canceled.'));
    const timer = setTimeout(() => terminate(new AcpInstallationError('timeout', 'Installation tool exceeded its deadline.')), input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const collect = (destination: Buffer, offset: number, chunk: Buffer): number => {
      if (failure) return offset;
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) terminate(new AcpInstallationError('limit_exceeded', 'Installation tool output exceeded its combined byte limit.'));
      else { chunk.copy(destination, offset); return offset + chunk.length; }
      return offset;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdout, stdoutBytes, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = collect(stderr, stderrBytes, chunk); });
    child.on('error', (cause) => { failure ??= new AcpInstallationError('tool_failed', 'Installation tool could not start.', { cause }); });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (signal || code === null) reject(new AcpInstallationError('tool_failed', 'Installation tool exited without a normal status.'));
      else resolve({ stdout: stdout.subarray(0, stdoutBytes).toString('utf8'), stderr: stderr.subarray(0, stderrBytes).toString('utf8'), exitCode: code });
    });
  });
}
