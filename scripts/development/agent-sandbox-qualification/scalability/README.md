# Large-workspace qualification

This separate credential-free lane qualifies completed streaming work through an
explicitly selected local Linux Docker Engine and a freshly installed coordinated
ten-package SDK candidate. It runs no models and makes no throughput claim. Build
and install the current candidate before running it; normal unit tests never
generate the large fixture.

From the repository root, select the exact already-local Node source image ID
whose RepoDigests include the pinned `node:24.18.0-bookworm-slim` reference in
`../ci-profile.mjs`:

```sh
pnpm test:agent-sdk-sandbox-scalability \
  --engine unix:///var/run/docker.sock \
  --consumer /absolute/current-packed/consumer \
  --output /var/tmp/new-sandbox-scale-run \
  --prepare-source-image sha256:<exact-local-source-image-ID> \
  --rss-budget-mib 1024 \
  --external-budget-mib 256 \
  --retain-source-fixture
```

The launcher creates a clean trusted image using the existing explicit fixture
preparer. It removes only that image after checking the original daemon identity,
preparation labels, exact image ID and command settlement. The selected source
image remains borrowed. Alternatively select `--image sha256:<exact-trusted-ID>`
to borrow a previously prepared compatible image. This lane never pulls an image,
uses an ambient Docker context, changes a daemon or prunes resources. The output
directory must be absent, its parent must be a physical canonical directory, and
it must be separate from the source repository and installed consumer.

The fixture contains 25,001 mixed-size `dataset/*.bin` files and the stable
`artifacts/nested/result.bin` 4 MiB artifact: 25,002 data files in total. Twenty-four
files are 512 MiB and sixteen are 17–32 MiB; the remaining dataset files vary from
1 KiB to below 64 KiB. The exact payload exceeds 12 GiB. AES-CTR generates varying
bytes from the recorded per-run seed in 64 KiB chunks. Every byte is explicitly
written and hashed. No truncate, sparse allocation, whole archive, eager tree
listing or complete hash census is used. Allocation counters must cover the real
payload. Read-only `statfs` preflight requires at least 64 GiB available on both
the host output and Engine storage filesystems, accounting for concurrent source,
workspace and exported copies when these share one filesystem. Memory filesystems
are rejected. Unrelated concurrent disk allocation remains outside this lane.

Two control files accompany the import: an incremental source manifest and the
independent guest reader. The guest reads and hashes every data byte and writes a
third control file containing its complete per-file observations. It also walks
the real workspace incrementally to reject extra files, directories or special
entries. The controller stops compute, independently observes its exact absence,
and calls `exportSandboxDirectory` for the entire workspace. It uses the helper's
returned published directory. A separate sink pass reads and hashes every data
and control byte, compares source/guest/sink records, checks the real destination
census and verifies the SDK wire/payload summaries. Manifest order is established
by the generator; verification opens the corresponding path rather than assuming
directory or native archive ordering. Only bounded records and one file's hash
state are retained in memory.

The no-quota baseline omits every logical transfer quota. A separate owned sandbox
selects `maxTotalBytes: 1024`, must receive `input_limit`, and must fence process
reservation and import replay. Both runs destroy their exact resources and retain
recovery records plus independent HTTP 404 observations. Cleanup errors remain
separate from the original error. Existing resources are preserved.

The launcher samples the controller from another process every 250 ms. Linux
`/proc/PID/status` supplies RSS and retained RSS high water. One bounded IPC request
at a time asks the controller for Node's external, array-buffer and heap counters.
The evidence records controller PID and Linux start identity. External memory is a
Node self-report, not an OS measurement; periodic samples can miss short external
peaks and the final unsampled interval before process exit. The two memory budgets
are qualification assertions chosen by this consumer;
omission selects the recorded 1024 MiB RSS and 256 MiB external defaults. They
impose no SDK workload limit and establish no universal memory
bound for arbitrary caller code. Sampling failure or budget excess cancels the
controller cooperatively and joins its actual cleanup; a noncooperative owner can
keep the launcher pending rather than fabricate quiescence.

Inspect `launcher-report.json`, `report.json`, `memory-samples.jsonl`, the three
incremental manifests and each run's `recovery.json`. Import/export summaries
report logical files/directories/payload and complete archive wire bytes; generated
tar parent headers and control files are accounted separately from dataset bytes.
The reports identify the largest tested file, exact completed byte/file counts,
real allocation and the complete Node/Engine/image/installed-package tuple.

SDK resources, the published export namespace and any image prepared by this lane
are cleaned. Without `--retain-source-fixture`, the owned host source is removed
too. The explicitly authorized retention option keeps only the owned host source
and evidence for MS004; it does not claim selective-export efficiency. Retained
fixture ownership is recorded by exact directory device/inode. An interrupted or
failed run can retain recovery evidence and unresolved owners; inspect its errors
before any exact cleanup retry. This lane is neither a durability proof nor a
throughput benchmark, and does not qualify other platforms or image/harness pairs.

Hermetic tooling checks:

```sh
pnpm test:agent-sdk-sandbox-scalability-tooling
```

In the standalone exported SDK repository the equivalent commands are
`pnpm test:sandbox-scalability` and `pnpm test:sandbox-scalability:tooling`.
