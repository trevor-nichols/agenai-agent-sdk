# Selected-export qualification

This separate credential-free lane compares the same exact 4 MiB artifact at the
same depth in small and large private workspaces. The large borrowed host fixture
contains at least 12 GiB of unrelated regular data and 25,000 unrelated files. The
lane uses the installed public SDK, creates fresh private sandbox resources, and
requires compute absence before selected reads. It never deletes the retained host
fixture. The campaign owner removes that fixture by its recorded identity only
after all MS004 gates pass.

```sh
pnpm test:agent-sdk-sandbox-selective \
  --engine unix:///var/run/docker.sock \
  --consumer /absolute/current-packed/consumer \
  --output /var/tmp/new-selected-run \
  --prepare-source-image sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 \
  --fixture /absolute/retained/source-fixture \
  --fixture-device 66306 \
  --fixture-inode 5153979 \
  --fixture-manifest-sha256 e060147d247e4fa951e8dc56ca39e9899012db3f966aedfbe7f4fedb068a3191 \
  --source-proof /absolute/retained/ms004-selected-traversal-proof.md \
  --source-manifest /absolute/retained/ms004-selected-traversal-source.json
```

Device, inode and manifest digest above identify the retained MS003 campaign
fixture; replace them with the independently recorded identity of another
authorized fixture. Input paths must be explicit physical/canonical directories
or bounded regular evidence files as appropriate. Output must be absent and
separate from the installed consumer and source repository. The source Node image
is already local. The lane never pulls images, selects an ambient Docker context,
changes a daemon or prunes resources. Its prepared clean image is removed by exact
identity after owned commands and SDK resources settle.

The launcher verifies the complete ten-package installed candidate before and
after execution, copies its controller under that consumer and imports the actual
public package entrypoints. It admits the independently source-qualified Linux
Engine 29.1.3 / Ubuntu `29.1.3-0ubuntu4.1`, Go `go1.24.13`, Node 24.18.0 tuple.
The installed `/usr/bin/dockerd` SHA-256 must match the supplied source evidence;
the recorded campaign binary is
`8f1c19d27e182ce6c82ddfd900d596195b0fd9d6740a9ff1ccac584e04355cb0`.
This checks the selected installed file and daemon-reported version; it is not
process-memory attestation or a reproducible-build proof. Other daemon builds need
their own source/native qualification and are rejected by this campaign lane.

`engine-requests.jsonl` records method, exact route, decoded archive target, status,
upload/body counters and any deliberately armed fault. A private Unix HTTP proxy
streams request and response bytes with backpressure and forwards Docker attach
upgrades. It retains no archive body. Trace records are bounded and written to
disk before completing ordinary responses; at most sixteen live forwarding
connections bound the trace writer queue. Row reports retain counts rather than
an eager list of requests. The proxy is qualification tooling and grants no new
production backend or host authority.

Each artifact row requires exactly five ancestor/final HEADs without trailing
slashes and one GET of `/workspace/work/artifacts/nested/result.bin`. Both rows
must hash the complete 4 MiB file, agree on its digest and archive byte count, and
receive at most 8 MiB of archive body. This allowance is a controlled-fixture
qualification budget, not an SDK limit. Workspace-root GETs fail every selected
row. A subtree row publishes the `artifacts` root at its workspace-relative path;
513 small file selections are supplied lazily and verified against per-file
digest markers on disk. Duplicate paths and file-prefix overlaps must reject
before any archive HEAD/GET.

The guest first reads and hashes every data byte, then creates owned ancestor,
final and subtree-root symlinks and selected subtrees containing a symlink or
FIFO. Root links must reject before GET; selected poison entries must reject
without accepting a complete output. Additional rows fail an entered subtree
sink, append a malformed byte after otherwise valid framing, cancel a response
stalled after its headers, and deliberately lose one exact owned cleanup
acknowledgement before explicit retry. Primary failures and cleanup observations
are retained separately. Existing neutral/Docker suites cover the broader strict
archive, traversal, duplicate-ledger and uncertain-operation campaign.

Wire observations alone do not establish daemon filesystem reads. The companion
proof traces Moby commit `fbf3ed25f893e6ce21336f1101590e40a13934f4`:

- [containerFSView.Stat](https://github.com/moby/moby/blob/fbf3ed25f893e6ce21336f1101590e40a13934f4/daemon/containerfs_linux.go#L226-L253)
  lstats the final component. Every ancestor must separately be checked under
  stable private ownership; a trailing slash could resolve past a link.
- [containerArchivePath](https://github.com/moby/moby/blob/fbf3ed25f893e6ce21336f1101590e40a13934f4/daemon/archive_unix.go#L39-L91)
  chooses the requested file's parent/basename or requested directory plus `.`.
- [TarResourceRebaseOpts](https://github.com/moby/moby/blob/fbf3ed25f893e6ce21336f1101590e40a13934f4/vendor/github.com/moby/go-archive/copy.go#L126-L136)
  supplies one include; [Tarballer.Do](https://github.com/moby/moby/blob/fbf3ed25f893e6ce21336f1101590e40a13934f4/vendor/github.com/moby/go-archive/archive.go#L698-L845)
  walks that selected root. A selected file does not enumerate its siblings; a
  subtree walks only that directory and its descendants.
- [Ubuntu's exact package record](https://packages.ubuntu.com/source/resolute-updates/docker.io-app)
  identifies the inspected distribution source. Its relevant files match those
  pinned upstream bytes, and its active patches do not change this call path.

The campaign's companion source manifest records primary source URLs, file and
distribution archive hashes, patch identities and correspondence limits. The
launcher hashes and copies both supplied evidence documents into its output.
They are retained campaign inputs, not implicitly discovered private repository
files. No complete external source tree is copied into the public SDK.

This argument covers the selected traversal path, not every daemon syscall,
mount/cache operation or physical block read. It relies on exact owned private
storage, complete compute shutdown, an owned never-started read-only accessor and
trusted host/daemon administrators. Hardlink aliases can appear as ordinary file
bytes; archive link entries still reject. The result establishes no generic
mutable-volume snapshot, daemon-wide memory bound, Mac/Windows qualification,
durability guarantee or throughput improvement. Independent controller memory
sampling retains the same periodic/self-report caveats as the large-workspace
lane; its recorded 1 GiB RSS / 256 MiB external budgets are consumer assertions.

Inspect `launcher-report.json`, `report.json`, `engine-requests.jsonl`, memory
samples and each workspace's persisted recovery record. Successful completion
requires exact SDK resource absence, removal of the prepared image, trace socket,
small comparison fixture and published subtree, plus preservation of the borrowed
source fixture and selected original image. The trace and digest metadata remain
as evidence. Routine tooling checks use
`pnpm test:agent-sdk-sandbox-selective-tooling`; standalone equivalents are
`pnpm test:sandbox-selective` and `pnpm test:sandbox-selective:tooling`.
