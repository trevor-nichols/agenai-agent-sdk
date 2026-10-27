# Captured live file and directory observations

These examples borrow an explicitly enabled `sandbox.files` handle. The caller
owns the sandbox, its grants and final stop/destroy sequence. The helpers below
own only fresh host scratch directories selected by the caller; they never map a
guest filename to a host path. Keep those host parents stable and exclusively
owned for the observation's lifetime.

`captureSandboxFile` streams a guest file into a private draft and hashes the
bytes. It returns a handle only after the SDK read and its callback settle as
`completed`, the counts agree, and publication is verified. A changed, cancelled
or rejected read throws `IncompleteFileCaptureError` with its actual observation.
Failure cleans the draft, while failed cleanup retains a
`LiveObservationCleanupError.retryCleanup()` owner. Publication is not an atomic
snapshot of the guest source and makes no power-loss durability claim.

```ts
import { captureSandboxFile } from "./live/index.js";

if (sandbox.files.kind === "disabled") throw new Error("Live read access is required.");
const captured = await captureSandboxFile(
  sandbox.files,
  "reports/result.bin",
  "/absolute/caller-owned/new-preview",
  { signal },
);
try {
  const length = captured.byteLength > 65536n ? 65536 : Number(captured.byteLength);
  const firstRange = await captured.readRange(0, length);
  // Retain captured.sha256 and captured.byteLength with this observation.
  // Later ranges read this captured copy even if the guest changes the source.
} finally {
  await captured.close();
}
```

The captured copy has a new identity independent of the guest path. Range reads
verify its inode and observed content metadata, admit one request at a time and
use at most 64 KiB of working output. This working bound does not limit the
captured file's total size. A closed observation rejects reads; the caller owns
authorization, expiry, media handling and any durable copy it chooses to retain.

`captureSandboxListing` streams direct-child metadata into an explicitly selected
SQLite file, then serves pages ordered by the recorded path bytes. This example
requires **Node >=22.13** for `node:sqlite`; the SDK package itself retains Node
>=22. SQLite uses bounded page-cache memory and disk ordering, so directory size
does not require a whole-directory JavaScript array.

```ts
import { captureSandboxListing } from "./live/index.js";

if (sandbox.files.kind === "disabled") throw new Error("Live read access is required.");
const listing = await captureSandboxListing(
  sandbox.files,
  ".",
  "/absolute/caller-owned/new-listing",
  { signal },
);
try {
  const first = await listing.readPage(undefined, 100);
  if (first.nextToken) {
    const next = await listing.readPage(first.nextToken, 100);
  }
} finally {
  await listing.close();
}
```

Each page has at most 256 records; the selected limit bounds a page's working
memory, not the directory's total entries. Tokens bind to one captured generation
and reject another generation or a closed owner. Refresh means creating a fresh
observation, not mutating the old page store. A changed or otherwise incomplete
SDK listing throws `IncompleteDirectoryObservationError` and publishes no usable
listing handle. Even a completed live enumeration is an observation over an
interval, not proof that the guest namespace was immutable or that transient
entries were observed.

File bytes and cumulative listing entries have no example-imposed total quota.
Callers may pass the SDK's `quotas`, `deadlineAt` and `signal` options. The SDK
retains callback/source cleanup ownership after an interrupted observation;
the host example's scratch owner is separate. Neither a preview nor a listing
replaces stopped-workload final export. UI filters, account selection, renderer
access, comparison and artifact publication remain consumer responsibilities.

The installed `live_files` qualification row exercises these examples against
real SDK file handles. Qualification applies only to the source, package, native
helper and platform identities in its retained report; compilation alone is not
native or Mac evidence.
