# Explicit Docker platform verification

This credential-free lane verifies one selected controller, daemon, image and profile. Current
source is the unpublished coordinated 0.4.6 candidate. The SDK has retained 0.4.4 Linux x64
evidence; it does not qualify changed candidate bytes. The 0.4.5 candidate, before publication, had separately
passed actual Apple Virtualization native-arm64 and Rosetta-amd64 baseline rows on the exact Mac
tuple below. Linux fixtures, synthetic admission and installed configuration checks alone do not
establish native Mac qualification.

Use native Node **24.18.0**, pnpm **11.7.0**, an existing local Engine exposing API 1.52 or later,
and exact already-present Linux Node 24.18.0 source image IDs. The guest source must match the
profile's image architecture. The observer source must match the **daemon's native** architecture:
on Apple Silicon it remains arm64 even when the selected guest image is amd64. Images are
prepared into separately owned clean fixture images and removed afterward. The selected source
images are borrowed and preserved. The runner never pulls an image or changes Docker settings.

Preparation permits two minutes each for the bounded filesystem export and image import, within
a five-minute owned preparation command. These setup limits are independent of sandbox operation
and failure-detection deadlines; each archive remains limited to one GiB.

Preparation invokes the selected existing `docker` CLI and `tar` through `PATH`. On a Mac,
put the explicitly selected Docker application's CLI directory first rather than depending on
an optional system symlink. Record that CLI path and `tar --version`; preparation lists and
appends the small fixed dataset fixture for every row. GNU tar is recorded on Linux; actual BSD tar preparation passed in the recorded Mac rows. The host spill proof also requires the existing
`/usr/sbin/lsof`; it is separate from the daemon-side kernel observer.

| Profile | Controller | Linux daemon | Guest image | Settings supplied explicitly |
| --- | --- | --- | --- | --- |
| `linux-x64` | Linux x64 | amd64 | amd64 | Existing rootful systemd/cgroup-v2/AppArmor profile |
| `desktop-apple-virtualization-native-arm64` | macOS arm64 | arm64 | arm64 | Apple Virtualization framework; ECI disabled |
| `desktop-apple-virtualization-rosetta-amd64` | macOS arm64 | arm64 | amd64 | Apple Virtualization framework; Rosetta enabled; ECI disabled |

Desktop's VMM, Rosetta and ECI fields are caller assertions, recorded separately from Engine
observations. The runner reads the version from the explicitly selected application plist with
`/usr/libexec/PlistBuddy`; it does not discover applications or settings. Docker VMM, Intel Macs,
native Windows, ECI and alternate emulators remain outside the admitted profiles. CPU, memory,
PID and native storage prerequisites must be available in the selected VM; do not weaken tests
when a prerequisite is missing.

This platform runbook covers the explicit baseline `core`, dataset, Grok initialization,
installed `live-files` and preserving-transfer qualification rows. Restricted HTTPS requires its separate prepared
helper image, opaque route authority, exact endpoint policy and complete recovery/enforcement
campaign. Desktop baseline selection does not enable or qualify restricted egress. Read the
matching Docker package README's restricted HTTPS section and `UPGRADING-TO-0.4.5.md`.
Within the standalone source export, those documents are
`packages/sandbox-docker/README.md` and `UPGRADING-TO-0.4.5.md`.

## Recorded Mac baseline

The 2026-10-26 campaign used Apple M3/macOS 26.5.1 (25F80), native arm64 Node 24.18.0,
pnpm 11.7.0, Docker Desktop 4.54.0, Engine 29.1.2/API 1.52 and Linux kernel
6.12.54-linuxkit. Actual settings were Apple Virtualization and Rosetta enabled, ECI disabled;
the native arm64 daemon/observer used cgroup v2/cgroupfs. Four VM CPUs and 6,144 MiB configured
memory were the chosen campaign budget. Source Node images were selected by exact local ID:

| Role | Exact source image ID |
| --- | --- |
| Native guest and both profiles' observer | `sha256:af01d58b748ec92b1d6e8e11429aad424fd1e68c848185399dca0596a1ab8f5c` |
| Rosetta guest | `sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6` |

Each core row passed 30/30 source checks with zero skips and the installed two-turn controlled
ACP example. Both full host suites passed 183/183 on separate internal/external APFS volumes,
including the 20,017-file case and actual Darwin descriptor/death evidence. APFS's native
3,999-byte raw-link `ENAMETOOLONG` and malformed-filename `EILSEQ` were independently proved;
matching SDK failure/cleanup and valid positive cases passed. No successful APFS publication
of that long target or SDK traversal of a natively unrepresentable filename is claimed.

The separately pinned Grok 1.0.62 (`1474f9cbdd91`) x86_64 artifact passed exact version and eager
ACP initialization under Rosetta, with no session, authentication or model turn. Source core,
installed examples, host filesystem results and Grok initialization retain distinct reports.
All workload/kernel/observer/prepared-image cleanup passed. Runtime freeze
`aa1a40ddba7b4854abc4c01cba04de41a6658f46` produced the ten retained archives; fixture-only
freeze `b35c4a4ea3a75cd040d54872f414dfc679eac84b` left their payloads unchanged. The standalone
`examples/sandbox/HANDOFF.md` records the complete archive census and qualification limits.
Later documentation changes do not create newly qualified archive identities. These baseline results
do not qualify current Desktop live-file or preserving-transfer admission; those use the separate
installed rows below. Restricted HTTPS has the separate MS005 N12/R2 record below; Mac datasets, large-workspace
scale, real provider accounts/tasks and consumer application behavior remain separate work.

## Installed live-file qualification

The `live-files` row uses the existing public SDK from a fresh ten-package consumer, with isolated
networking and an explicitly prepared filesystem helper. Its separate bounded capability manifest
uses `format: 'agenai.sandbox-platform-capabilities.v1'`, binds the exact platform-manifest SHA-256,
and selects the same `profile` and `row`. It supplies workload/helper resources, the fixed filesystem
protocol/layout/executable and image/source identities, and finite observation/cleanup budgets.
Unknown fields, mismatched identities and unsupported row sections reject before Engine effects.

```sh
pnpm test:agent-sdk-sandbox-platform --row live-files --manifest /absolute/native.json --capabilities-manifest /absolute/native-live-files.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/al-r1
```

Standalone exports use `pnpm test:sandbox-platform` with the same arguments. Select a separate
Rosetta manifest for its row. Helpers and the independent daemon observer stay native arm64 on
both Desktop profiles. The workload's actual Linux platform, architecture, Node version and
numeric user are recorded after it starts. Source closures copied into the consumer are hashed;
runtime imports resolve only the consumer's installed public SDK packages.

Eighteen serial scenarios cover default-disabled/read-only/read-write grants, exact binary and empty
files, executable permissions, create collisions and replacement, streaming/backpressure, no-follow
confinement, concurrent ancestor changes, cancellation, stop/join, helper loss, a withheld real
COMMIT acknowledgement and fresh-controller cleanup from the unchanged original checkpoint.
Healthy read and write-source backpressure each span the captured control lease plus two heartbeats,
with the same helper remaining ready and exact subsequent mutation confirmed. A separate owned
controller pauses with its attachment open until the native helper expires; the original controller
then resumes, refuses further mutation, joins cleanup and exports the confirmed bytes. The daemon
observer remains active throughout. The lease starts at the helper's last decoded command, so the
pause timestamp is not reported as the exact lease-start timestamp.
The withheld acknowledgement keeps native publication evidence separate from the public unknown
result and verifies that no mutation is replayed. The unprivileged mount attempt is disclosed as
an unsupported fixture; it does not qualify a successful mount-crossing mechanism.

The scenario admission budget includes two simultaneous workloads and filesystem helpers,
one 1-CPU/256-MiB diagnostic observer and one 0.25-CPU/64-MiB sentinel fixture, capped at
four CPUs/four GiB. The observer captures admitted compute/helpers and qualification sentinels
by exact role, image and run identity before forwarding their start acknowledgement, and checks
kernel emptiness before forwarding their deletion acknowledgement. The original compute-only
observer policy remains unchanged for baseline callers. Export accessors remain stopped and
receive independent Engine absence checks. Preserve all case reports, source/package identities,
fault traces and original recovery records, including failed attempts.
Short cleanup observation deadlines retain the same actual owner; bounded repeated observations
must settle before final export. The held-callback cases retain the initial expected timeout.

The `combined` row admits both Desktop profiles and Linux x64 through the installed public
example described below. The separate Linux `restricted-https` component row remains explicitly
`UNIMPLEMENTED` before runtime/output effects; its affected native network requirement is mapped
to the separately retained Linux restricted-network/recovery campaign. Desktop restricted HTTPS
has the installed qualification implementation and accepted MS005 N12/R2 component record below;
that record does not establish combined acceptance.

## Installed preserving-transfer qualification

The `preserve-internal` row executes the installed public transfer and Node-directory APIs with
isolated networking. The packed MS004 r2 candidate passed all 136 cases on each of native arm64
N2 and Rosetta amd64 R1, on the recorded M3/macOS 26.5.1, Node 24.18.0 and Docker Desktop 4.54.0 /
Engine 29.1.2 composition. Each row closed all 230 observed scopes and removed its observer and
prepared images. Original N1 remains failed at 124/136; the repaired candidate has separate Linux
source/unit validation, not a new Linux native transfer claim. The public sandbox handoff retains
the exact archive/helper/source identities and qualification limits. Its explicit
capability manifest requires both the existing `filesystem` descriptor and `transfers.hostRoots`;
`network` remains forbidden. This dated amendment applies to the previously unimplemented row.
An older preserving manifest without its helper descriptor rejects before effects. Other row
shapes, the private v1 format and public recovery records remain unchanged.

```sh
pnpm test:agent-sdk-sandbox-platform --row preserve-internal --manifest /absolute/native.json --capabilities-manifest /absolute/native-preserve.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/as-r1
```

Standalone exports use `pnpm test:sandbox-platform` with the same arguments. Run native and
Rosetta profiles separately. Desktop manifests supply exactly two ordered existing physical
writable host parents with roles `controller_internal` and `controller_external`, outside the
consumer/output and each other, on distinct filesystem devices. Record actual APFS mount and
volume identities before execution; the row captures and rechecks parent device/inode, permissions
and filesystem facts. Parents may contain caller data. Only fresh run-owned children are created
and removed; original parents and their contents remain borrowed.

The fixed cases cover both host roots and both workspace layouts. Baseline cases omit helper
configuration and request disabled live files. Private cases explicitly configure the supplied
helper and request read-write files. A fresh reservation precedes the initial preserving import;
the controlled guest program is imported afterward. Imported/exported bytes, raw readlink buffers,
executable intent, file/directory/symlink counters and native guest facts are checked independently.
The bounded 1,200-link fixture has raw path/target metadata exceeding the existing 64-KiB batch;
it is a graph merge case, not a large-workspace performance claim.

Confined dangling links and exactly detected inert cycles are positive preservation cases.
Escaping and unresolved over-bound graphs reject while withholding links and fencing execution;
entered regular import effects may remain. Subtree confinement uses the selected root, and exact
file/live operations retain no-follow behavior. Host-directory publication exposes its `files`
child only after complete validation. Case/Unicode alias controls, original long-target bytes,
native invalid-encoding outcomes, source changes, cancellation and exact-error cleanup retry retain
native facts separately from SDK observations. Unsupported native input creation is never reported
as successful SDK traversal of that input.

The maximum simultaneous topology is two private SDK workspaces/helpers, one independent volume
sentinel and the daemon observer, within four CPUs/four GiB. The current inputs total 2.25 CPUs
and 832 MiB. The full Desktop case census enters 152 SDK owners: 152 compute scopes, 76 filesystem
scopes and two qualification sentinel scopes, requiring 230 observer scopes. This row explicitly
selects the bounded 256-scope observer capacity; other rows retain the 128-scope default. Completed
scopes stay recorded until the final independent census.

`preserve/preserve-report.json` binds each complete `preserve/cNNN/case-report.json` by exact
byte length and SHA-256, keeping the aggregate bounded while retaining full case observations,
checkpoints and primary/cleanup failures separately. Original SDK owners and original directory
cleanup error instances retain retry authority; serialized reports are evidence, not reconstructed
cleanup handles. Local readers, callbacks, sentinels, SDK resources and host scratch must settle
before row success; the parent launcher independently joins the controller group and observes VM
kernel/resource absence. Preserve failed attempts and their original bytes.

## Prepare a fresh installed consumer

From the private monorepo:

```sh
pnpm test:agent-sdk-sandbox-platform-consumer --output /absolute/new-packed-root
```

From a governed standalone SDK export:

```sh
pnpm test:sandbox-platform-consumer --output /absolute/new-packed-root
```

This explicit portable lane builds and inspects the same ten-package candidate, performs a
fresh local installation, compiles the public examples and session helper, and runs neutral
filesystem plus inert platform checks. Its consumer is `/absolute/new-packed-root/consumer`.
The sandbox examples are emitted under `consumer/platform-dist/examples/sandbox`, with the
controlled peer copied beside them. Native qualification runs these artifacts with plain Node,
so a development-time TypeScript loader cannot leave a helper in the observed controller group.
The default full consumer retains all its existing Linux checks. Do not copy Linux
`node_modules` to a Mac or count portable preparation as native execution.

## Select and record the tuple

Create a bounded JSON manifest with the exact fields below. Replace every example identity
with the selected machine's actual values; `expected` values must match live observations.
Use a physical Unix socket, such as the explicit per-user Desktop socket, rather than relying
on an automatically selected context or optional default-socket symlink.

```json
{
  "format": "agenai.sandbox-platform-manifest.v1",
  "engine": "unix:///absolute/user/.docker/run/docker.sock",
  "profile": "desktop-apple-virtualization-native-arm64",
  "sourceImage": "sha256:<64 lowercase hex digits for arm64 Node source>",
  "observerImage": "sha256:<64 lowercase hex digits for native arm64 Node source>",
  "expected": {
    "controller": { "os": "darwin", "architecture": "arm64", "nodeVersion": "24.18.0" },
    "daemon": {
      "id": "<Engine info ID>",
      "version": "<Engine version>",
      "apiVersion": "<Engine maximum API version>",
      "architecture": "arm64",
      "kernelVersion": "<Engine info KernelVersion>",
      "operatingSystem": "Docker Desktop"
    }
  },
  "desktop": {
    "version": "<installed Desktop application version>",
    "applicationPlist": "/Applications/Docker.app/Contents/Info.plist",
    "vmm": "apple-virtualization",
    "rosetta": false,
    "enhancedContainerIsolation": false
  }
}
```

For Linux, use profile `linux-x64`, controller `linux`/`x64`, daemon `amd64`, exact native
amd64 source images, the observed operating-system string and `"desktop": null`. For the
Rosetta row, select its profile, an exact amd64 guest source and `"rosetta": true`; the daemon
and observer stay arm64. The optional `harness` field is required only for `grok-initialize`:

```json
{
  "path": "/absolute/selected/grok-1.0.62-linux-x86_64",
  "sha256": "2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa"
}
```

The selected artifact is a Linux x86_64 executable. This does not describe every Grok release
as amd64-only or qualify an advertised arm64 alternative. No credentials field is accepted.

## Run independent rows

Private monorepo commands:

```sh
pnpm test:agent-sdk-sandbox-platform --row core --test-concurrency 1 --manifest /absolute/native.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ac-r1
pnpm test:agent-sdk-sandbox-platform --row datasets --test-concurrency 1 --manifest /absolute/native.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ad-r1
pnpm test:agent-sdk-sandbox-platform --row grok-initialize --manifest /absolute/rosetta.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ag-r1
```

Standalone commands use `pnpm test:sandbox-platform` with the same arguments. Use new, short
absolute output roots with physical canonical parents; `/tmp` is normally an alias on macOS,
so these Mac commands use `/private/tmp`. Before running core, check both
`<output>/kernel.sock` (at most 100 UTF-8 bytes) and
`<output>/source-integration/uncertainty/cleanup-observation-timeout/engine.sock` (fewer than
104 UTF-8 bytes). The launcher checks the outer path; the source fault proxy separately
enforces the deeper path. `core` runs the unchanged
baseline native source scenarios (excluding the separate dataset suite) through the explicit kernel-observer port, then the installed two-turn
controlled ACP example. It covers containment/resource failures, binary streams, cancellation,
lost replies and fresh-controller cleanup recovery. `observer` runs just the installed example
and is a diagnostic subset, not a replacement for `core`. `grok-initialize` imports and hashes
the exact binary, observes its actual version and eagerly initializes the public ACP registry
in fresh isolated workloads. It opens no session, performs no authentication and enters no
model turn. Test command deadlines are qualification budgets, not SDK execution ceilings.

`--test-concurrency` accepts an integer from 1 through 8 for `core` and `datasets` only. It
selects Node's test-file concurrency; `1` serializes source test files while preserving each
file's internal sandbox scenarios. Omission preserves Node's default scheduling. Malformed,
repeated or unsupported-row selections fail before manifest reads, output creation or Engine
access. `launcher-report.json` records the selected source files and requested/effective
concurrency under `sourceTests`; `node-default` records an omitted selection. The matching
`commands` entry retains the actual Node executable and arguments.

The tooling-only observer container uses the daemon's PID/cgroup view with read-only kernel
mounts, no network, a read-only root, no added capabilities and no privileged flag. It observes
only exact SDK compute admitted through this run's private proxy, selected image and namespace
prefixes. Cgroup/PID/start identities are captured before start acknowledgment, then independently
checked after removal and before disposing the observer. Engine HTTP 404 is additional evidence,
not the kernel proof. No host-PID, host-bind or privilege option is added to the SDK API.

## Installed restricted-HTTPS qualification

The Desktop `restricted-https` row executes 26 fixed generic cases using named public SDK imports
from a fresh independent consumer. The separate MS005 N12/R2 campaigns each passed all 26
cases and 98 final-empty scopes on their exact IPv4-only caller-quiescent tuple; see the public
handoff's Desktop restricted-HTTPS record. Changed tuples require fresh qualification. It needs the closed network
manifest, fresh current public egress/host/VM preparations, an exact certificate-verified
`github.com:443/robots.txt` response identity and the captured caller-owned quiescence and
no-interception assertions. It has no account, credential or model prerequisite.

```sh
pnpm test:agent-sdk-sandbox-platform --row restricted-https --manifest /absolute/native.json --capabilities-manifest /absolute/native-network.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/an-r1
```

Each case reserves one SDK owner. Two baseline owners start compute only; 24 restricted owners
can start compute, broker, relay and `route_observer`. Three historical fixture identities cover
the VM marker, temporary foreign-member cut and public marker, giving at most 101 retained
kernel scopes within the existing 128 capacity. At most three fixtures run together. With workload
0.5 CPU/128 MiB, broker 0.25 CPU/128 MiB, relay 0.25 CPU/64 MiB and VM observer 0.25 CPU/128 MiB,
the complete VM budget is 3 CPUs/896 MiB including the diagnostic observer and fixtures.
Admission computes the actual captured aggregate and rejects over four CPUs/four GiB. Native
helpers/fixtures need bounded PID capacity for their entered diagnostic work; controls are serial.

The ordinary cohort proves exact TLS, isolation and all active-tunnel fault cases first. Its
verified-TLS case also captures the actual broker configuration, complete Engine IPAM, host
interfaces and explicit fixture DNS observations. That original owner is destroyed before public
fixture preparation. The preparation gap remains caller-quiescent and has no continuous SDK lease.
Changed fixture DNS, host interfaces or Engine topology aborts preparation without selecting a
new fixture address or baseline. GitHub's positive TLS connection resolves and pins its current
admitted peer independently; no address equality across DNS actors or time is required.

Fixture DNS amendment, 2026-10-27: both network-bearing manifest rows require explicit
`fixtures.publicHostname` and `fixtures.publicAddress`. The canonical lowercase ASCII hostname
must differ from the positive TLS hostname. Its observed DNS answer must be exactly the selected
canonical IPv4 address, with no AAAA answer. That address must be a non-network, non-gateway,
non-broadcast member of the selected public `/24`, with no observed-prefix overlap. An explicit
candidate is `11-199-231-12.nip.io` and `11.199.231.12`; [nip.io](https://nip.io/) documents this
embedded-address DNS mapping. This is a recorded DNS-only fixture dependency, not an additional
HTTP origin or a custom DNS server. Older network manifests without these two fields reject
before effects; the format and other row sections remain unchanged.

External fixture address initialization must finish before a new SDK baseline. The VM marker
reads only the fixed bounded `/proc/net/if_inet6` prerequisite, records raw bytes/hashes/times,
rejects DADFAILED and waits for TENTATIVE to clear. This diagnostic gate does not decode policy,
alter an existing owner or relax sealed observations. The temporary foreign marker is prepared
on the unchanged default bridge before its case owner, then its extra broker-bridge attachment
is the deliberate fault. Its exact cleanup is registered before SDK reservation.

Fixture mechanism clarification, 2026-10-27: the public marker has that exact address on a
separate exclusively owned bridge with fixed `gateway_mode_ipv4=nat-unprotected`. The container
omits `ExposedPorts` and `PortBindings`, with `PublishAllPorts: false`; actual inspection must
confirm no exposure, bindings or published ports before and after start. Pinned Moby 29.1.2
[permits direct access](https://github.com/moby/moby/blob/docker-v29.1.2/daemon/libnetwork/drivers/bridge/internal/iptabler/endpoint.go#L32-L49)
and [accepts forwarded traffic](https://github.com/moby/moby/blob/docker-v29.1.2/daemon/libnetwork/drivers/bridge/internal/iptabler/network.go#L224-L245)
for this mode without publication. The mode can still masquerade outbound traffic; the fixture
invariant is no published host ports. Native same-target TCP/UDP marker retrieval from the
identified broker namespace remains required before denial credit. This fixed fixture option
is not a manifest knob or SDK network-membership exception. No global host route, DNS, VPN,
proxy, daemon setting or firewall configuration is changed. The explicit allowed fixture
DNS name must subsequently receive broker 403 with the public-local route observed, the owner still ready,
and zero forbidden-listener counter deltas. Independent broker-namespace DNS observations before
and after the refusal must match the fixture address; they do not expose a correlated internal
broker DNS-reason receipt. A separate owner omits that same reachable name to prove
unlisted-destination rejection. The SDK broker bridge always retains only its exact broker,
apart from the deliberate foreign-member fault case that must fence the owner.

Darwin and VM host-network markers independently prove numeric host, `host.docker.internal`,
the observed VM-local address and the owned public bridge's `.1` gateway. The VM marker must
observe exactly one noninternal `eth0` IPv4 address inside the captured Docker subnet. Each
denial preserves the exact address/port/marker and monotonic connection/request/datagram census.
Unreachable controls are failed prerequisites. Docker [distinguishes the host's internal address
from the VM gateway](https://docs.docker.com/desktop/features/networking/networking-how-tos/).
`gateway.docker.internal` receives only a bounded DNS observation and an unlisted CONNECT 403;
it is omitted from the destination policy, so no broker dial is permitted. The row sends no
direct TCP or UDP attempt to that unowned address and explicitly leaves its direct transport
and reachable-service isolation unexercised.
Native IPv6 cases require CONNECT refusal for the listed address forms. Direct TCP establishment
and UDP submission to the two selected global IPv6 forms must fail with native `ENETUNREACH`,
with no active non-loopback IPv6 route observed before or after the attempts. A missing application
reply cannot establish transport denial. Direct loopback, mapped-loopback and unscoped link-local
transport remain unexercised; there is no independently reachable IPv6-listener isolation claim.
Controlled DNS alias/rebinding/mixed-answer, pinned-peer, redirect-target and healthy bidirectional
backpressure cases belong to the separate deterministic broker/relay proof. This row does not
claim a native HTTP 302 flow, bulk tunnel backpressure or IPv6 connectivity.

The public backend and each newly constructed authority handle bind the same exact task-owned
Unix proxy socket. Evidence retains the original manifest descriptor, derived descriptor bytes,
actual configuration digest/checkpoints, socket device/inode/mode and verified upstream Engine
mapping. Keep proxy and upstream quiescent through cleanup. `network/network-report.json` binds
every full case report by path/byte count/SHA-256; `fixtures.json` owns every fixture reservation,
entered create/start/exec/control/delete, bounded stdout/stderr and cleanup outcome. Paused and
killed controllers retain original PID/group controls, immutable checkpoint bytes and cleanup-only
reconciliation. All helpers and fixtures receive independent PID/start/cgroup capture and final
kernel emptiness checks; an Engine 404 alone is insufficient.

Permanent launcher diagnostics retain raw evidence in `route-observer-capture` and
`engine-network-capture`. VM capture selects the exact inspected original `route_observer`
identity and retains its first 16 complete observation NDJSON lines, including original newlines,
with sequence, byte count and SHA-256. Each line is bounded to four MiB. Its control witness
retains at most the first 128 commands; later command correlation is unobserved when that prefix
ends. The capture decodes transport framing without interpreting native route correctness.

Engine capture selects only exact-ID `GET /v1.52/networks/<id>` responses with status 200 and
matching current SDK ownership labels. It retains the first 16 complete inspection bodies per
network as original JSON bytes, preserving whitespace and binding each file to its trace ID.
Each candidate body is bounded to one MiB. Interrupted bodies retain only bounded byte/hash and
trace witnesses with `incomplete_unconfirmed` disposition; they establish neither parsed owner
identity nor a complete inspection. Partial VM buffers likewise do not establish a complete
observation. Planned transport interruption is distinct from a recorder failure.

Each collector permits at most 26 original identities, 416 raw files, 64 MiB of raw evidence and
a four-MiB index. These are finite prefixes, not continuous authority histories. The launcher
separately binds capture-module source identities and final index hashes. VM identities correlate
with the independent kernel registry; Engine trace/label bindings require independent correlation
with original controller checkpoints. Capture forwards original bytes unchanged, but awaited
diagnostic work can perturb timing. After proxy byte chains settle, both collectors join entered
reads/writes and close their files before diagnostic disposal. Recorder parsing, write or bound
failures fail qualification after cleanup; captured bytes alone never establish route correctness,
stability or native acceptance.

## Installed combined public workflow

Desktop MS006 native N2 and AVF/Rosetta R1 each passed all thirteen installed cases on
`packed-ms006-r3`, with complete row cleanup and 62 independently confirmed final-empty scopes.
Fresh real Linux x64 R1 passed eighteen live-files, 68 preserving-transfer and eleven combined
cases, with 43/115/41 final-empty scopes respectively. Exact report/archive/module identities are
in the public handoff: `examples/sandbox/HANDOFF.md` in the standalone export, or
`scripts/repository/agent-sdk-public/examples/sandbox/HANDOFF.md` in the monorepo, under
“Desktop and Linux combined native campaigns.”
Fresh MS006 Linux network R1 separately passed all 46 network/recovery cases and 378 independent
absence observations against the current installed candidate and controller sources.

The generic `combined` row imports the compiled public
`platform-dist/examples/sandbox/combined/index.js` from the independent installed consumer.
Its four compiled `index`, `workflow`, `program` and `session` modules are hash/length captured
by the launcher and verified again before import. The public example itself imports only public
SDK entrypoints; its fixed linked tree, controlled Node program, live roundtrip, verified TLS,
explicit forbidden target, cancellation, stopped preserving host export and destruction are
shipped example code. No provider, model, account or credential is selected. The native harness
adds independent marker reachability/counters, observer/census, original checkpoint persistence
and proxy/controller faults; it cannot replace the workload with a supplied success callback.

```sh
pnpm test:agent-sdk-sandbox-platform --row combined --manifest /absolute/native.json --capabilities-manifest /absolute/native-combined.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ac-r1
```

Standalone exports use `pnpm test:sandbox-platform` with the same arguments. The capability
manifest selects `row: 'combined'`, explicit filesystem/egress/authority inputs, exact HTTPS
response bytes/hash, controlled fixture identities and admitted physical transfer parents.
Desktop supplies ordered internal/external APFS parents; Linux supplies its admitted physical
parent. Each parent receives a normal and a cancellation case. Cancellation aborts an entered
provisional live write, keeps its unknown-effect/null-byte receipt without replay, fences further
mutation, then joins that source and the active process before export. Exact final names, bytes,
raw link target, permissions and summary counts are checked by the public example.

One sibling case fully starts an isolated live-file owner B before starting the restricted combined
owner A. Their namespaces, workspace/storage and helpers remain distinct; same-path live writes
and reads verify independent bytes and actual restricted-versus-isolated policies. B's network
membership stays stable throughout A's sealed authority lifetime, and B remains ready with its
bytes unchanged after A is destroyed. This does not qualify two simultaneously started restricted
owners or topology changes beneath an active restricted owner.
Seven controller-death cuts target resource-create acknowledgement, filesystem initialization,
network readiness, entered live write, process activity, entered stop and entered cleanup.
A separate cleanup-acknowledgement-loss case retains and explicitly retries the original owner.
Each crash uses complete original trusted checkpoints and a fresh cleanup-only controller,
performs repeated cleanup and rejects any create/start/program replay. That gives thirteen fixed
cases per Desktop profile and eleven on Linux; native acceptance remains pending until the exact
reports, source applicability and independent cleanup are reviewed.

Admission includes two simultaneous workloads and every filesystem/egress/VM helper, a separate
1-CPU/256-MiB diagnostic observer and two bounded marker fixtures, capped at four CPUs/four GiB.
The computed maximum retained kernel census is 86 scopes on Desktop and 62 on Linux, below the
128-scope observer capacity; actual captured identities remain the cleanup authority. Runs are
serial outside the deliberately simultaneous sibling case. `combined/combined-report.json`
binds each case, original recovery/checkpoint history, public audit observations, exported results,
original child identities, independent marker counters and final absence census. Fresh Linux
proof requires a real admitted Linux controller/daemon; a Desktop Linux container is not that row.

## Evidence, failures and remaining Mac checks

Retain `launcher-report.json`, command logs, `engine-requests.jsonl`, the observer record and
observation log, fixture preparation records, source-test evidence and installed-example or
Grok reports. Each launcher report retains exact installed package hashes. Successful cleanup
must establish guest quiescence, observer removal, prepared-image removal and borrowed-image
survival. A failed row remains failed after successful cleanup.

On failure, retain the exact SDK recovery records. Make the original controller quiescent,
reconcile with the same explicit backend/profile, namespace, image, user and dataset configuration,
and destroy its owned resources. Current candidate records use `agenai.sandbox-recovery.v3`, mandatory
`configurationDigest`, Desktop `engine-1.52-v6-*` revisions and unchanged Linux `engine-1.52-v5-linux-x64`.
Older Desktop v5 owners require their original controller and checkpoint; there is no translation. V1/v2 records reject before
effects; drain old v2 resources with their retained 0.4.4 controller before upgrade. Never rewrite
old records or mix an earlier candidate's package outputs with this source. Retain the original
trusted checkpoint: parsing/hashes do not authenticate a caller-edited inventory, and absence
covers only that exact inventory. Restricted cleanup uses the matching plain helper/observer
identity but does not require a valid route lease, a live observer executable or fresh image
preflight. Rollback cleans v3 with its retained 0.4.5 controller before starting new 0.4.4 baseline
work; it does not restore a runnable agent. The observer
retains diagnostic ownership when guest emptiness is unknown; after SDK cleanup, use the
exported tooling `cleanupDaemonObserver({ endpoint, recordPath })` from `observer/index.mjs`
with its exact persisted `observer/record.json`. Do not prune by label, delete borrowed images,
replay uncertain create requests or substitute a privileged observer. The record is a claim
validated against the original configuration and daemon; the returned reconciliation owner
supplies cleanup authority. It does not restore a runnable session.

Actual Mac verification must also run the neutral directory and spill tests on the selected
host filesystem. They check actual case/Unicode aliases, staged publication, cancellation and
local descriptor release/controller death. The daemon-side observer cannot prove Mac host
descriptor cleanup. Record filesystem type/case behavior, exact commands, pass/fail/skip and
retained evidence separately. A skipped or unavailable required native row remains pending.

The explicit `datasets` row independently runs the image-dataset cases, fresh-controller dataset recovery and compiled installed dataset example. Reuse the strict outer platform manifest above; the launcher creates the inner `datasets`/`datasetFixture` inputs from preparation rather than accepting those fields in the platform manifest. Retain `installed-datasets/packed-datasets/report.json` with proof `packed-sandbox-datasets-example` beside the source and observer evidence. The feature requires stable Engine 29.1.4 or newer, `Driver: overlayfs` and the admitted `DriverStatus` marker `['driver-type', 'io.containerd.snapshotter.v1']`; record both driver fields without changing Desktop settings. Engine 29.1.3 has an upstream filename-length bug for full-ID image mounts; baseline `core` does not acquire this dataset-only minimum. The prepared fixture supplies dedicated known bytes with writable Unix permissions, so guest `EROFS` observations establish mount enforcement. Dataset qualification is separate from baseline `core`: absence of image-mount support does not invalidate an independently passing baseline execution tuple. Neither row proves a hard workspace quota; an explicitly required quota must reject before reservation. Positive XFS/allocated-block enforcement remains a separately deferred optional capability, and actual Mac dataset execution remains pending.
