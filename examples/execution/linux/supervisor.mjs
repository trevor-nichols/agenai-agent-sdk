import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir, stat, rmdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { receiveMessage } from './ipc.mjs';

const operationRoot = process.argv[2];
const config = JSON.parse(await readFile(join(operationRoot, 'host.json'), 'utf8'));
const membership = (await readFile('/proc/self/cgroup', 'utf8')).trim();
if (!membership.startsWith('0::/') || !membership.endsWith('/manager')) {
  throw new Error('The supervisor requires its delegated manager subgroup.');
}
const root = dirname(`/sys/fs/cgroup${membership.slice(3)}`);
const workload = join(root, 'workload');
let reservationId;
let fenced = false;
let startup;
let startupSettled = false;
let child;
let childClosed = true;
let releaseWork;
let released = false;
let identity;
const dataServers = [];
const dataSockets = new Set();

async function streamServer(name, attach) {
  const server = createServer((socket) => {
    if (fenced) { socket.destroy(); return; }
    dataSockets.add(socket);
    socket.once('close', () => dataSockets.delete(socket));
    socket.on('error', () => {});
    attach(socket);
    server.close();
  });
  dataServers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(operationRoot, name), resolve);
  });
  await chmod(join(operationRoot, name), 0o600);
}

function claim(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) throw new Error('Invalid reservation identity.');
  if (reservationId && reservationId !== id) throw new Error('This host owns one reservation only.');
  reservationId = id;
}

async function launch(message) {
  claim(message.id);
  if (fenced || startup) throw new Error('Execution admission is closed or already used.');
  startup = (async () => {
    await mkdir(workload);
    const entry = await stat(workload);
    identity = { path: workload, device: entry.dev, inode: entry.ino, epoch: config.epoch, reservationId,
      limits: config.limits, network: config.network ? 'host' : 'isolated' };
    await writeFile(join(operationRoot, 'observation.json'), JSON.stringify(identity), { mode: 0o600 });
    await streamServer('acp.sock', (socket) => {
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    });
    await streamServer('stderr.sock', (socket) => child.stderr.pipe(socket));
    if (fenced) throw new Error('Execution admission closed during startup.');
    childClosed = false;
    child = spawn('/usr/bin/python3', [join(dirname(fileURLToPath(import.meta.url)), 'enroll.py')], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => {});
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', () => { for (const socket of dataSockets) socket.destroy(); });
    }
    child.once('close', () => { childClosed = true; });
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(JSON.stringify({ cgroup: workload, recipe: message.recipe, mounts: config.mounts,
      network: config.network, networkInputs: config.networkInputs }));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (fenced) throw new Error('Execution admission closed during process startup.');
    return identity;
  })().finally(() => { startupSettled = true; });
  startup.catch(() => {});
  return startup;
}

function release(id, timeoutMs) {
  claim(id);
  fenced = true;
  if (released) return Promise.resolve();
  if (releaseWork) return releaseWork;
  releaseWork = (async () => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      // Kill before joining startup. Repeating also catches a trusted bootstrap
      // that was spawned immediately before admission was fenced.
      if (identity) await writeFile(join(workload, 'cgroup.kill'), '1');
      if (child && !childClosed) child.kill('SIGKILL');
      const empty = !identity || /(?:^|\n)populated 0(?:\n|$)/u.test(await readFile(join(workload, 'cgroup.events'), 'utf8'));
      if ((!startup || startupSettled) && childClosed && empty) break;
      if (performance.now() >= deadline) throw new Error('Native workload did not join within its shutdown bound.');
      await delay(10);
    }
    for (const socket of dataSockets) socket.destroy();
    for (const server of dataServers) if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (startup) await startup.catch(() => {});
    released = true;
  })().catch((error) => { releaseWork = undefined; throw error; });
  return releaseWork;
}

const control = createServer((socket) => {
  socket.on('error', () => {});
  receiveMessage(socket, (message) => {
    Promise.resolve().then(async () => {
      if (message.capability !== config.capability) throw new Error('Execution control authority denied.');
      if (message.kind === 'launch') return launch(message);
      if (message.kind === 'release') {
        if (!Number.isSafeInteger(message.timeoutMs) || message.timeoutMs < 10 || message.timeoutMs > 30_000) throw new Error('Invalid cleanup bound.');
        await release(message.id, message.timeoutMs);
        return { joined: true };
      }
      if (message.kind === 'retire') {
        if (reservationId) await release(reservationId, 10_000);
        if (identity) await rmdir(workload);
        return { retired: true };
      }
      throw new Error('Unsupported execution control command.');
    }).then((value) => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
      () => socket.end(`${JSON.stringify({ ok: false, error: 'Owned execution operation failed; cleanup remains callable.' })}\n`));
  });
});
await new Promise((resolve, reject) => { control.once('error', reject); control.listen(join(operationRoot, 'control.sock'), resolve); });
await chmod(join(operationRoot, 'control.sock'), 0o600);
await writeFile(join(operationRoot, 'ready.json'), JSON.stringify({ root, epoch: config.epoch }), { mode: 0o600 });
