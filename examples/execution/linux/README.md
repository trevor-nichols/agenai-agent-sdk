# Linux owned execution reference

This maintained host implementation supplies the public `NodeAcpExecutionBoundary`
port from `@agen-ai/provider-acp/node`. It is an example, outside the published
package. Core imports and ordinary Node consumers acquire no Linux dependency.
The reference follows descendants across POSIX sessions and process groups;
its qualification uses real credential-free local processes.

Use this only on an explicitly supported Linux host with unified cgroup v2, an
active user systemd manager, writable delegated subgroups, Bubblewrap, Python 3,
Node 22 or later, a merged `/usr` layout and available `/dev/shm`. The recorded
controlled tuple is Linux x64, Node 24.18.0, systemd 259.5 and Bubblewrap 0.11.1.
The caller must have permission to create transient user services with
`Delegate=yes` and `DelegateSubgroup=manager`. Namespace restrictions, missing
delegation and missing executables fail the operation. There is no process-group
fallback or automatic privilege escalation.

`createLinuxExecutionHost(options)` synchronously creates an inert host owner.
Import, construction and unused disposal need no Linux identity or OS tooling;
an explicit unsupported `start()` rejects before acquiring resources.
Retain it before calling `await host.start()`. Startup creates one private
mode-0700 `/dev/shm/agenai-exec-*` directory and one bounded transient user
service. The service's trusted supervisor lives in its `manager` subgroup;
systemd exclusively manages the service root, and the supervisor exclusively
manages one `workload` subgroup. Startup verifies the actual manager properties
and the supervisor's physical cgroup identity. Each host accepts one reservation.

`host.executionBoundary.reserve(input)` is synchronous and inert. It copies the
validated immutable public launch input. Only the reservation's once-only
`start(context)` creates the workload cgroup and launches its process. A trusted
bootstrap writes its own PID into that cgroup **before** executing Bubblewrap or
the exact target executable and literal arguments. There is no attachment of a
running target PID. Bubblewrap gives the target private user, PID, IPC, UTS,
mount and cgroup namespaces, drops capabilities, hides host `/proc`, cgroupfs,
`/run` and the supervisor's sockets, and forwards only the ACP and stderr
streams. Explicit environment values travel through private IPC and a
NUL-delimited argument descriptor, so they neither enter supervisor command
lines nor affect the trusted Bubblewrap loader. The target receives no control
capability or recipe descriptor.

Reservation `release()` fences admission immediately, requests cgroup-wide kill
before joining startup, joins the actual child/stdio and all workload processes,
and reads `populated 0`. Concurrent calls coalesce, success is retained, and a
failed call remains retryable on the same reservation. A late startup result
cannot reopen admission. The supervisor and empty cgroup remain owned by the
external host, allowing an independent observer to check the same device/inode
at the consumer's close checkpoint. They contain no native producer after
successful release. `host.dispose()` retires the empty identity and uses
systemd to stop/join the trusted supervisor before deleting its private files.
Retain and retry the exact host or SDK cleanup owner after a rejected cleanup;
never treat a timed-out wait as proof that its operation stopped.

If the trusted supervisor itself fails, `host.dispose()` retains its separate
systemd unit authority and recovers by stopping/joining that exact service.
It records `hostIdentity().externalIntervention === 'host_cleanup_recovery'`
irreversibly. Once that owner proves actual quiescence and joins entered
startup/streams, an explicit retry of the retained SDK cleanup can complete.
The original SDK qualification stays failed: later cleanup success cannot
erase the intervention or restore the missing independent checkpoint.

The host has explicit limits of **64 tasks, 512 MiB memory and 180 seconds** for
the entire service, including the trusted supervisor. These are qualification
limits rather than general provider sizing advice. The independent observer
checks the kernel PID/memory limits and OOM-kill counters. Expiry of the service
runtime bound is external intervention; it must not be credited as SDK cleanup.
The missing supervisor/control socket or retired identity also prevents a
successful close-checkpoint qualification.

Create the host before the driver and retain it through any independent
checkpoint:

```ts
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { createLinuxExecutionHost } from './execution/linux/boundary.mjs';

const host = createLinuxExecutionHost({
  network: 'isolated',
  mounts: [
    { path: '/absolute/physical/provider-installation', writable: false },
    { path: '/absolute/physical/owned-workspace', writable: true },
    { path: '/absolute/physical/isolated-profile', writable: true },
  ],
});
await host.start(); // Keep host callable if this rejects.
const driver = createNodeAcpProviderDriver({
  providerKey: 'explicit-owned-provider',
  executionBoundary: host.executionBoundary,
  launch: {
    executable: '/absolute/physical/provider-installation/agent',
    args: ['--acp'],
    cwd: '/absolute/physical/owned-workspace',
    env: { HOME: '/absolute/physical/isolated-profile' },
    shutdownTimeoutMs: 2_000,
  },
});
// Materialize and use driver through the public registry/session API.
// Await session.close(), observe the retained empty boundary if qualifying,
// and await registry.dispose(), then await host.dispose().
```

Mounts use the same absolute physical path inside and outside the target. They
are explicit host authority: provide only the installation, workspace and
isolated profile needed for that operation. The reference rejects control-path
overlap and cannot certify arbitrary extra host mounts. `/usr` is read-only and
available by default; owned `/dev/shm/<name>` roots are allowed for controlled
fixtures. Mounting the entire `/dev/shm`, `/proc`, `/sys`, `/run` or root tree is
rejected.

Networking defaults to `isolated`. Explicit `network: 'host'` shares the host
network namespace and requires explicit configuration inputs:

```ts
const host = createLinuxExecutionHost({
  network: 'host',
  networkInputs: {
    resolver: '/etc/resolv.conf',
    hosts: '/etc/hosts',
    certificates: '/etc/ssl/certs',
  },
  mounts: [/* explicit physical installation/workspace/profile mounts */],
});
```

Resolver and hosts inputs are copied as bounded regular-file snapshots and
mounted read-only at `/etc/resolv.conf` and `/etc/hosts`. This also supports a
resolver symlink whose source lives under hidden host `/run`. The explicit
certificate directory is mounted read-only at `/etc/ssl/certs`; no host `/run`
or whole `/etc` mount is added. Controlled proof verifies snapshot digests,
localhost name resolution and certificate loading. It makes no outbound DNS,
TLS, model or account request and does not qualify a vendor's network behavior.

Host networking also shares Linux abstract Unix sockets. The current controlled
proof denies the known pathname systemd/D-Bus/supervisor sockets and direct
cgroup control paths. It does not claim protection from arbitrary host services
reachable over the shared network or abstract sockets. A host exposing a
command-execution or cgroup-management service there does not satisfy this
reference's ownership prerequisites. This is a qualified execution mechanism
under its declared host authority, not a universal security sandbox.

`boundary.d.mts` exposes the typed host composition using only the public SDK
port. The monorepo's separately versioned controlled qualification lives under
`scripts/development/agent-session-execution-qualification/`; it imports this
implementation rather than copying it. Public projection retains this complete
directory, including its Python bootstrap and declarations.
