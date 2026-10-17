import { execFile } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm, realpath, stat } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { request, connectStream } from './ipc.mjs';

const execute = promisify(execFile);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const overlaps = (left, right) => left === '/' || right === '/' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

function settings(options) {
  const network = options.network ?? 'isolated';
  const tasksMax = options.tasksMax === undefined ? 64 : options.tasksMax;
  if (tasksMax !== 64 && tasksMax !== 128) throw new TypeError('Task limit must be 64 or 128.');
  if (!['isolated', 'host'].includes(network)) throw new TypeError('Network mode must be isolated or host.');
  if (!Array.isArray(options.mounts) || options.mounts.length > 32) throw new TypeError('Explicit bounded mounts are required.');
  const mounts = options.mounts.map(({ path, writable }) => {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || typeof writable !== 'boolean'
      || ['/proc', '/sys', '/run', '/dev', '/tmp', '/usr', '/bin', '/lib', '/lib64'].some((protectedPath) => overlaps(path, protectedPath))) {
      // Owned /dev/shm fixture/profile roots are the one deliberately admitted
      // /dev descendant. The whole /dev tree is never exposed.
      if (!(typeof path === 'string' && /^\/dev\/shm\/[^/]+(?:\/.*)?$/u.test(path)
        && resolve(path) === path && typeof writable === 'boolean')) throw new TypeError('Mount overlaps host control or runtime paths.');
    }
    return Object.freeze({ path, writable });
  });
  const networkInputs = options.networkInputs;
  if (network === 'isolated' && networkInputs !== undefined) throw new TypeError('Isolated networking does not accept host network inputs.');
  if (network === 'host' && (!networkInputs || !['resolver', 'hosts', 'certificates'].every((key) =>
    typeof networkInputs[key] === 'string' && isAbsolute(networkInputs[key])))) {
    throw new TypeError('Host networking requires explicit resolver, hosts and certificate inputs.');
  }
  return Object.freeze({ network, tasksMax, mounts: Object.freeze(mounts), networkInputs: networkInputs ? Object.freeze({
    resolver: networkInputs.resolver, hosts: networkInputs.hosts, certificates: networkInputs.certificates,
  }) : undefined });
}

function recipe(input) {
  if (!input || !isAbsolute(input.executable) || !isAbsolute(input.cwd) || !Array.isArray(input.args)
    || !input.args.every((argument) => typeof argument === 'string' && !argument.includes('\0'))
    || !input.env || typeof input.env !== 'object' || Array.isArray(input.env)
    || Object.entries(input.env).some(([key, value]) => !key || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0'))
    || !Number.isSafeInteger(input.shutdownTimeoutMs) || input.shutdownTimeoutMs < 10 || input.shutdownTimeoutMs > 30_000) {
    throw new TypeError('The host requires the validated immutable Node execution input.');
  }
  return Object.freeze({ executable: input.executable, cwd: input.cwd, args: Object.freeze([...input.args]),
    env: Object.freeze({ ...input.env }), shutdownTimeoutMs: input.shutdownTimeoutMs });
}

async function waitUntil(read, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(label);
    await delay(10);
  }
}

/**
 * Explicit host owner for one reference execution. Construction and reserve are
 * inert. Call host.start() before using executionBoundary, retain host through
 * the independent checkpoint, then await host.dispose(). A failed start leaves
 * this exact host owner callable; dispose never reconstructs a PID owner.
 */
export function createLinuxExecutionHost(options) {
  const configuration = settings(options);
  const epoch = randomUUID();
  const capability = randomBytes(32).toString('hex');
  const unit = `agenai-exec-${epoch}.service`;
  let operationRoot;
  let hostStart;
  let serviceStartEntered = false;
  let hostEnvironment;
  let ready = false;
  let hostQuiesced = false;
  let serviceRoot;
  let externalIntervention = null;
  let disposing = false;
  let disposed = false;
  let disposeWork;
  let reservation;
  let networkInputs = [];
  const limits = Object.freeze({ tasksMax: configuration.tasksMax, memoryMaxBytes: 536_870_912, runtimeMaxSec: 180 });
  const systemctl = (...args) => execute('/usr/bin/systemctl', ['--user', ...args], { env: hostEnvironment, timeout: 15_000, maxBuffer: 16_384 });
  const control = (message, timeoutMs) => {
    if (!operationRoot) throw new Error('The host supervisor has not started.');
    return request(join(operationRoot, 'control.sock'), { ...message, capability }, timeoutMs);
  };

  const start = () => {
    if (disposing) return Promise.reject(new Error('Host ownership is closed.'));
    if (hostStart) return hostStart;
    hostStart = (async () => {
      if (process.platform !== 'linux') throw new Error('This reference requires Linux cgroup v2.');
      const uid = process.getuid();
      hostEnvironment = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${uid}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
      await execute('/usr/bin/bwrap', ['--version'], { timeout: 5_000 });
      await execute('/usr/bin/systemctl', ['--user', 'show', '-p', 'ControlGroup'], { env: hostEnvironment, timeout: 5_000 });
      await stat('/sys/fs/cgroup/cgroup.controllers');
      for (const mount of configuration.mounts) {
        if (await realpath(mount.path) !== mount.path) throw new Error('Mount sources must be physical canonical paths.');
      }
      operationRoot = await mkdtemp('/dev/shm/agenai-exec-');
      await chmod(operationRoot, 0o700);
      if (configuration.mounts.some(({ path }) => overlaps(path, operationRoot))) throw new Error('Target mount exposes its execution owner.');
      if (configuration.network === 'host') {
        for (const [key, destination] of [['resolver', '/etc/resolv.conf'], ['hosts', '/etc/hosts']]) {
          const source = await realpath(configuration.networkInputs[key]);
          const information = await stat(source);
          if (!information.isFile() || information.size > 16_384) throw new Error('Network configuration must be a bounded regular file.');
          const bytes = await readFile(source);
          const staged = join(operationRoot, `${key}.conf`);
          await writeFile(staged, bytes, { mode: 0o600 });
          networkInputs.push({ source: staged, destination, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        const certificates = await realpath(configuration.networkInputs.certificates);
        if (!(await stat(certificates)).isDirectory()) throw new Error('Certificate input must be a directory.');
        networkInputs.push({ source: certificates, destination: '/etc/ssl/certs' });
      }
      await writeFile(join(operationRoot, 'host.json'), JSON.stringify({ epoch, capability, mounts: configuration.mounts,
        network: configuration.network === 'host', networkInputs, limits }), { mode: 0o600 });
      if (disposing) throw new Error('Host startup was fenced.');
      serviceStartEntered = true;
      await execute('/usr/bin/systemd-run', ['--user', `--unit=${unit}`, '--collect', '--no-block', '--service-type=exec',
        '--property=Delegate=yes', '--property=DelegateSubgroup=manager', `--property=TasksMax=${limits.tasksMax}`,
        '--property=MemoryMax=512M', '--property=RuntimeMaxSec=180', '--property=KillMode=control-group',
        '--property=TimeoutStopSec=5', '--property=StandardOutput=null', '--property=StandardError=null',
        process.execPath, join(sourceDirectory, 'supervisor.mjs'), operationRoot],
      { env: hostEnvironment, timeout: 10_000, maxBuffer: 16_384 });
      await waitUntil(async () => {
        try { const value = JSON.parse(await readFile(join(operationRoot, 'ready.json'), 'utf8')); return value.epoch === epoch; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }, 10_000, 'The delegated execution supervisor did not become ready.');
      const properties = await systemctl('show', '-p', 'Delegate', '-p', 'DelegateSubgroup', '-p', 'ControlGroup', unit);
      const actual = Object.fromEntries(properties.stdout.trim().split('\n').map((line) => line.split('=')));
      const observed = JSON.parse(await readFile(join(operationRoot, 'ready.json'), 'utf8'));
      serviceRoot = observed.root;
      if (actual.Delegate !== 'yes' || actual.DelegateSubgroup !== 'manager'
        || observed.root !== `/sys/fs/cgroup${actual.ControlGroup}`) throw new Error('Exclusive cgroup delegation was not established.');
      if (disposing) throw new Error('Host startup was fenced.');
      ready = true;
    })();
    return hostStart;
  };

  const reserve = (input) => {
    if (disposing || reservation) throw new Error('This reference host accepts one fresh reservation only.');
    const launch = recipe(input);
    const id = randomUUID();
    let entered = false;
    let fenced = false;
    let startWork;
    let releaseWork;
    let released = false;
    const streams = [];

    const startReservation = (context) => {
      if (entered || fenced) throw new Error('Execution start is once-only and admission is closed after release.');
      entered = true;
      startWork = (async () => {
        if (!ready || disposing) throw new Error('The explicitly owned host supervisor must be ready before execution.');
        if (context.signal?.aborted) throw context.signal.reason ?? new Error('Execution startup was aborted.');
        await control({ kind: 'launch', id, recipe: launch });
        if (fenced) throw new Error('Execution startup was fenced.');
        const acp = await connectStream(join(operationRoot, 'acp.sock'));
        streams.push(acp);
        const stderr = await connectStream(join(operationRoot, 'stderr.sock'));
        streams.push(stderr);
        if (streams.some((stream) => stream.destroyed || stream.errored)) throw new Error('Owned execution streams failed during startup.');
        if (fenced || context.signal?.aborted) throw context.signal?.reason ?? new Error('Execution startup was aborted.');
        return Object.freeze({ stdin: acp, stdout: acp, stderr });
      })();
      startWork.catch(() => {});
      return startWork;
    };

    const release = () => {
      fenced = true;
      if (released) return Promise.resolve();
      if (releaseWork) return releaseWork;
      releaseWork = (async () => {
        // Send the release command before joining entered startup, including a
        // launch request whose reply is still pending. A release tombstone
        // denies a late launch request at the supervisor too.
        if (entered && ready && !hostQuiesced) await control({ kind: 'release', id, timeoutMs: launch.shutdownTimeoutMs }, launch.shutdownTimeoutMs + 2_000);
        if (startWork) await startWork.catch(() => {});
        for (const stream of streams) {
          if (stream.closed) continue;
          const closed = new Promise((resolveClose) => stream.once('close', resolveClose));
          stream.destroy();
          await closed;
        }
        released = true;
      })().catch((error) => { releaseWork = undefined; throw error; });
      return releaseWork;
    };
    reservation = Object.freeze({ start: startReservation, release });
    return reservation;
  };

  const dispose = () => {
    disposing = true;
    if (disposed) return Promise.resolve();
    if (disposeWork) return disposeWork;
    disposeWork = (async () => {
      if (hostStart) await hostStart.catch(() => {});
      if (ready) {
        try {
          if (reservation) await reservation.release();
          await control({ kind: 'retire' });
        } catch {
          // This external host owner can recover its exact service after its
          // control producer fails. Preserve the failed SDK-cleanup evidence.
          externalIntervention ??= 'host_cleanup_recovery';
        }
      }
      // systemd is the sole writer of the service root. Stop joins that owner;
      // this host never writes or removes systemd's managed cgroup itself.
      if (serviceStartEntered) {
        const state = await systemctl('show', '--value', '-p', 'LoadState', unit);
        if (state.stdout.trim() !== 'not-found') await systemctl('stop', unit);
        const terminal = await systemctl('show', '--value', '-p', 'ActiveState', unit);
        if (!['inactive', 'failed', ''].includes(terminal.stdout.trim())) throw new Error('The trusted supervisor did not stop.');
      }
      if (serviceRoot) {
        try { await stat(serviceRoot); throw new Error('The owned service cgroup remains after stop.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      hostQuiesced = true;
      // A retained SDK cleanup handle can now join the original start/streams
      // on retry. Its later success cannot erase externalIntervention.
      if (reservation) await reservation.release();
      if (operationRoot) await rm(operationRoot, { recursive: true, force: true });
      disposed = true;
      ready = false;
    })().catch((error) => { disposeWork = undefined; throw error; });
    return disposeWork;
  };
  return Object.freeze({ start, dispose, executionBoundary: Object.freeze({ reserve }),
    observation: async () => {
      if (!operationRoot) throw new Error('No workload observation exists before startup.');
      return Object.freeze(JSON.parse(await readFile(join(operationRoot, 'observation.json'), 'utf8')));
    },
    hostIdentity: () => Object.freeze({ unit, epoch, operationRoot: operationRoot ?? null, network: configuration.network, limits, externalIntervention,
      networkInputs: networkInputs.map(({ destination, sha256 }) => ({ destination, sha256: sha256 ?? null })) }),
  });
}
