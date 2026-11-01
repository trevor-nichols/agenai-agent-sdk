# Desktop exclusion research (MS001)

This is a bounded Darwin mechanism experiment for EP-20261029-001. It is not
production SDK code, an exported coordinator API, a Docker recovery controller,
or installed SDK qualification. No file imports this area from production.

Run explicitly from the repository root after existing package outputs are
available:

```sh
node scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/exclusion/run.mjs 7ea1aaea-951c-4129-a920-8f003143c27b
```

The argument is an already observed daemon ID, supplied only to derive one
contention key. This program never connects to Docker. Physical endpoint/daemon
identity and socket-alias bracketing require separate native evidence.

The separate, explicit follow-up reads the actual selected Engine through its two
existing admitted aliases:

```sh
node scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/exclusion/run-endpoint-binding.mjs /Volumes/AGENAI/Qualification/sdk-concurrency/EP-20261029-001/ms001/reproduction-input-r3.json
```

It permits only `GET /v1.52/info` and `GET /version`. It brackets native lock
acquisition with physical socket and daemon observations, then proves contention
through both actual aliases and both prepared helper architectures. Replacement
negative controls use isolated local HTTP Unix listeners beneath the attempt
directory; actual Docker aliases and listener files are never changed. Its raw
identity/report receipts are retained separately in `evidence/`, preserving the
earlier native-only evidence.

`prepare.mjs` creates a unique `/private/tmp/agenai-ms001-exclusion-*` attempt,
compiles fixed C offline with the existing compiler, and embeds that attempt's
research authority root in both copied helper binaries. It also compiles an
x86_64 helper and requires already installed Rosetta; it never installs or
downloads anything. The canonical production namespace is untouched. The native
profile and Rosetta workload profile both use arm64 controllers in the current
SDK; translated-helper contention proves additional OS interoperability, not
admission of an x86_64 SDK controller.

`lock-holder.c` independently opens a fixed Engine-keyed file, uses nonblocking
Darwin `flock`, and holds the descriptor for its lifetime. Root traversal is
descriptor relative and no-follow. The private root must be owned by the current
UID with mode 0700; the journal must be a mode-0600 regular file with one hard
link. Every operation rechecks the root and journal inode/device binding. The
locked file itself holds the bounded journal and is never atomically replaced.
Close-on-exec descriptors and stdin EOF establish helper/parent ownership.

`controller.mjs` is deliberately a research client, not a hardened state machine.
It requires durable dirty registration before effect authorization, retains
returned identities in memory on acknowledgement-persistence failure, and
refuses live activation while a previous generation is dirty. The complete
canonical journal is independent of caller namespace, profile and journal-root
metadata. Its hash chain detects accidental/torn edits; hashes provide no
same-user tamper resistance. Cleanup-only binding is tested against the existing
built v3 parser, without changing that format. Tests are sequential owner-boundary
experiments; production member/transition serialization and all numeric public
bounds still need their implementation proof.

`run.mjs` and `worker.mjs` exercise real process, kernel-lock and filesystem
boundaries. Assertions protect competing opens, process lifetime, durable
obligations, failure-before-dispatch ordering, returned identities, path
replacement, and immutable recovery bindings. No production test seam was
added. Synthetic filesystem effects establish ordering only. A delayed local
subprocess effect demonstrates why an empty current census and lock release
cannot certify previously entered work has settled; Docker requires its own
independent proof.

Each attempt retains `report.json`, its prepared manifest, copied assets and
original canonical journals, including failed attempts. Children and helpers
are joined or terminated by the runner. Files remain as research evidence and
must never be passed to a production cleanup or activation API.

The prototype can detect live root/inode replacement and rejects symbolic roots,
symbolic journals, hard links and damaged records. A fresh same-user process
cannot discover that the entire trusted namespace was deleted and forged clean
without an external trust anchor. Production must use one fixed durable root,
no caller root override, explicit preparation, no automatic authority-inode
replacement or stale-file deletion, and fail closed on known missing/corrupt
state. Host administrators and same-user hostile authority edits are outside
the cooperation contract. Power-loss durability is not claimed.
