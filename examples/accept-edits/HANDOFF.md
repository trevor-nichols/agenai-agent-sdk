# Auto-accept edits: qualification and release handoff

Recorded 2026-11-12. The source delivery supports `provider_accept_edits` through the owned Claude
and OpenCode drivers on the exact compositions below. The installed candidate passed the complete
real API-key matrix, source/installed checks and independent milestone review. This is a handoff
for a separately authorized release: the published ten-package `0.4.13` release is unchanged, the
fourteen source manifests still carry development version `0.4.13`, and no next version, npm
publication, private Hostd/Battle Bots adoption or deployment is selected.

Use the [example](README.md) for the executable workflow, the
[runtime contract](../../packages/agent-runtime/README.md#select-an-approval-policy) for selection,
and the [owned-tool contract](../../packages/provider-tools/README.md) for confinement and cleanup.
This document is the portable evidence index; qualification records are identified by immutable
artifact name and digest rather than links into an unavailable private plan tree.

## Policy and provider boundary

`provider_accept_edits` is an immutable session-opening policy. The configured provider must
advertise it for the requested operation and confirm it on the returned session. An unsupported
selection fails before opening, and a missing/mismatched confirmation preserves original cleanup
ownership. No fallback or automatic host responder is installed.

Ordinary structured file creates, exact-text updates and patches of up to sixteen eligible files
can run automatically. Every target must be inside the prepared workspace and preserve explicit
read/edit restrictions and protected paths. Deny wins over ask; metadata, credentials and agent
configuration still ask. The descriptor-safe helper refuses links, special files and mount
crossings even after host approval. Multi-file publication is sequential, not atomic: confirmed
changes survive a later failure, which fences further effects rather than replaying or rolling back.

Every command requires its complete exact text to be approved once, including `pwd`, shell
redirects and shell-based edits. There are no remembered grants. File tools expose no mkdir,
delete, rename, notebook-structure, link or permission operation; a contained command can perform
operations within its existing authority after approval. Native reads/searches check restrictions
per entry. Application-owned tools, network grants and external integrations receive no authority
from this selection.

| Provider surface | Fourth policy | Qualified scope or decision |
| --- | --- | --- |
| `@agen-ai/provider-claude/node` | Supported for `create` | SDK 0.3.322 / Code 2.1.322, explicit Anthropic API key, owned tools |
| `@agen-ai/provider-opencode/node` | Supported for `create` | OpenCode V2 client/runtime 2.2.7, explicit Anthropic/OpenAI API key, owned tools |
| Controlled `@agen-ai/provider-grok/docker` | Unsupported | Retains its independently qualified host/auto-review/bypass composition |
| Generic `@agen-ai/provider-acp` | Unsupported | A borrowed ACP connection cannot establish this owned policy |
| Codex execution | No public constructor delivered | Evaluated app-server 0.167.1 loses command origin when an isolated `apply_patch` heredoc becomes a file-change request |
| Original Cursor execution | No public constructor delivered | Evaluated `@cursor/sdk` 1.3.1 does not locally enforce exclusive custom-tool dispatch |

The Codex and Cursor decisions are version-scoped scripted-native findings, not claims about all
future compositions or real backend behavior. Codex's experimental raw-event correlation and a
Cursor protocol-filtering gateway remain unqualified; neither was substituted. Their independent
history readers and private adapters are unchanged. Later vendor versions need qualification.

Both delivered drivers support `host` and `provider_accept_edits` only, one live fresh session per
instance and one active text turn, with sequential turns and new sessions after successful close.
They report `controlled_configuration` from the owned composition rather than using native
`acceptEdits` or a broad permission allow rule. Resume, branch, native delegation, arbitrary MCP,
execution input/steering, structured output and non-text input remain unsupported. Invalidating
configuration/model/mode drift fences the session. Keep the sole output reader and original
cleanup handles until settlement; an unsettled cleanup is not successful disposal.

Adding the fourth `AgentApprovalPolicy.kind` member can require updating downstream exhaustive
TypeScript switches. Existing input behavior, serialized Agent Protocol V13, private Host V26 and
sandbox recovery v3 remain unchanged. Discovery is per configured instance and opening operation,
not a provider-name lookup.

## Qualified runtime tuples

Both workloads used exactly Node `24.18.0` as non-root uid/gid 1000. Linux x64 used host Bubblewrap
0.11.1. The macOS path is a Darwin arm64 controller with the entire SDK caller, provider and broker
inside the recorded Linux arm64 Docker Desktop image, using Bubblewrap 0.8.0. The recorded Docker
Engine is 29.9.2. Native Darwin, Windows, Rosetta and arbitrary arm64 hosts are not qualified.

The provider process is trusted and runs outside the command sandbox. Every approved command
gets private user/PID/mount/IPC/UTS/network namespaces, a cleared environment and only the workspace
as a writable host path. Commands cannot reach provider credentials, control channels or network.
The inner namespace is joined before the next tool effect. This requires the actual pinned
executables and successful namespace preflight, not merely matching version strings.

| Executable tuple | SHA-256 |
| --- | --- |
| linux-x64 / Claude Code | `bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478` |
| linux-x64 / OpenCode | `589253d36810f21217edd51545cd435b328cdc3cf4f451fbe0cce6f88afcf5e1` |
| linux-x64 / Bubblewrap | `523da3e7399044be5163aee6f57a77a6bef7454376e28f0a0627920bae1b76b6` |
| linux-x64 / filesystem helper | `467e80d77d52cecb4dcd4072db9f27fa4630eb0087b14f5a05dfd21da70c7e6f` |
| desktop-linux-arm64 / Claude Code | `f220ca50ea4f3222043ff83cc224a1262e0196e9897acc0871efa94235b0c1fd` |
| desktop-linux-arm64 / OpenCode | `c577783eacf7d1e66661fc7fd904b7646761497b687ff8f8f82ebe4f2f3ea425` |
| desktop-linux-arm64 / Bubblewrap | `ff5add553bea12a45c18ebe6c67d3ed637052b869a1ca2fc5d74a6a2e8c5cce6` |
| desktop-linux-arm64 / filesystem helper | `df898d30c471b082639166e567d800049e077668f9ee40f03ee9b0b5b4ac030e` |

Desktop candidate image: `f23e7500f5d1bdc525768a8c3e7209805b5ac56bdd7fe85814d9eaa9388edb4b`.
Seccomp profile: `a050ab482dbaf8232d983b836dc769666926b3fecf9b97e84e978885d644d0a9`.
Each container was inspected before start: uid 1000, all capabilities dropped, no-new-privileges,
read-only root, init reaper, 2 GiB memory, 256 PIDs, 64 MiB private `/tmp`, one private volume and no
host mounts or Docker socket. The recorded masked paths are `/sys/firmware` and
`/sys/devices/virtual/powercap`; readonly system paths are empty to permit the nested sandbox.
The custom default-deny seccomp profile is required; no unconfined setting is qualified.
Real inference uses outer bridge networking; inner command namespaces remain networkless.

The constructor does not build or acquire this environment. Preparation, trusted executable
acquisition, helper compilation and container ownership remain explicit caller responsibilities.
A different image, helper, kernel or containment setup requires affected qualification rather than
copying this result. See the example's requirements before invoking a real provider.

## Installed candidate and correspondence

The implementation checkpoint is `ce01229be62c42ab3024801d528c42437640702b` (MS008). Qualification
used its frozen source candidate before the commit was created; its 85-file source archive was
independently compared with the checkout. Exact candidate identities:

| Input | SHA-256 |
| --- | --- |
| `candidate.json` | `c459138f107100ea1fb5083dcb674bbd02c01623d217205ebb02d5c3c3690b9a` |
| Candidate tar | `8c96ee074623db1a8364e67c69b2e9e493c1788b4e55094601b4aec37d72ab44` |
| Installed module tree, 10,520 files | `9bc083ad84e1e9e2e5eb73eec02d602830758c763b6a24a80b2cc4d014b746bd` |
| Installed example tree, 17 files | `58b93d655e87160981b72dbc2bf2f4848c1dc679e013b99262ac223c0bfe3dc0` |
| Installed qualification tree, 10 files | `61c08bd3fb31e24c182022c199b8e44170c13b9319f64977fe56110a365b8724` |

All fourteen archives were retained and covered by the full packed-consumer gate. The real-run
candidate installed the eight-package dependency closure of its runtime and owned drivers from
these archives; no real run repacked them:

| Package archive at development 0.4.13 | SHA-256 |
| --- | --- |
| `@agen-ai/acp-registry` | `a02c240d5ac793aa1f2d7a2447c3fc9b51c4d00de9510f739d81ea4ba6b7fc5d` |
| `@agen-ai/acp-transport` | `09569754986099a424bbed38c592c17d108088862d20a68a166817cc3978a991` |
| `@agen-ai/agent-history` | `b0d63b9195ff2d1d5665b437a5c75d117faadc5e303cbe32af0aba98da206133` |
| `@agen-ai/agent-orchestration` | `6359be80c31d6932eee6029cbaa1fad797f2611df57582e96db7c7a86a2c008a` |
| `@agen-ai/agent-protocol` | `5d82d0bdc082e352663f47673bcac843a3695028a346acaaf3dfd59a4ef8130b` |
| `@agen-ai/agent-runtime` | `73d1b0e7cd7e8f1a788d46ec9a87b39541e3d1ba033063bdf956fbf90075a2d7` |
| `@agen-ai/provider-acp` | `bb15b4a7e962a63a0dc191f534a8d10f689922268487622edc830a08c06e15a8` |
| `@agen-ai/provider-claude` | `ab843d1ddc336690369954693306123403ec680fc416991531e15004017cbafd` |
| `@agen-ai/provider-grok` | `64dffc2276f3d859c360f387c4287b2fd6284e275c5a8fafee6f7f072a04f3c8` |
| `@agen-ai/provider-opencode` | `9e872eb7da2675661b1c6408b610e58efd70da2b343274d254f50d8a0eee95cb` |
| `@agen-ai/provider-tools` | `4557c4a3fc890d9a46eedcf6de8072459392834746fbdf4de897b7d44082fa70` |
| `@agen-ai/sandbox` | `9521e39ef7b03f14d5f1dcffdf8be20b7b00bda15d776da22c19a554d1d6c36a` |
| `@agen-ai/sandbox-docker` | `67f69fbe0ddf5dbc3bb946b6745b285d7bd3856d04da9cd6284884973cc6e5b9` |
| `@agen-ai/validation` | `73c1e4863ec9a7a69ef69ba41c149b35944bf290344e1b3edd4941c5e1ede6dc` |

MS009 updates documentation after this campaign, including this handoff and package READMEs. Those
new words are not in these frozen archives. After the README edits, all four touched packages were
rebuilt: every shipped `dist` file matched both before/after builds and the retained installed
candidate (runtime 136, tools 40, Claude 32 and OpenCode 38 files). Local-only declaration maps and
`.tsbuildinfo` are excluded from the published archives and from that comparison. Comparing the
85 archived source members with current files finds six documentation changes: five READMEs
(tools, Claude, OpenCode, public root and this example) plus `scripts/SNAPSHOT.md`.
Executable members are unchanged. Runtime source, declarations,
native bytes and evidence retain their own identities; a later release archive needs fresh
package/content correspondence.
The final current execution-input prose correction also rebuilt provider-acp; all 136 shipped
`dist` files match its retained archive above. It does not add an execution-input mapping.
Packing identical source can reorder dependency keys and change tar hashes, so never assume a
repack reproduces these bytes or relabel a new archive with an old digest.

## Qualification results

The real campaign used explicit API-key files and exact full model identifiers:

| Route | Model | Linux x64 final cases | Desktop arm64 final cases |
| --- | --- | --- | --- |
| Claude / Anthropic | `claude-sonnet-5-5` | 6/6 | 6/6 |
| OpenCode / Anthropic | `claude-sonnet-5-5` | 6/6 | 6/6 |
| OpenCode / OpenAI Responses | `gpt-5.5-2026-04-23` | 6/6 | 6/6 |

The six fresh cases are eligible create/update/multi-file edits; a command held then approved;
a denied shell edit; explicit ask/deny/protected/outside paths; cancellation after a command's
start marker; and hostile project configuration that cannot bypass approval. Exact file bytes,
approval receipts, attributable refusal categories and absence of denied/late effects were checked.
Three additional Linux command-approval feasibility rows passed, one per route. All 39 real rows
passed with no failed, aborted, inconclusive or repeated row. This is a bounded behavioral matrix,
not a general model success-rate estimate, production/fleet admission or a pricing measurement.

The parent controller admitted one sealed row at a time across both platforms, using immutable
read-only ledger snapshots. Every result/claim matched its manifest and admitted row, and admission
intervals did not overlap. The ledger is complete with $39 of the $60 reservation ceiling consumed;
all 39 actual-charge fields remain `null`. A row may issue multiple provider model requests.
Limits were 300 s wall time, 60 s settlement, eight observed tool items, 4,000 events, 8 MiB output,
60 s per command and two automatic cleanup attempts. Failed/uncertain rows would still consume
reservations; inference was never automatically retried.

Claude's sealed `maxBudgetUsdPerSession: 1` limits its estimated session cost, checked after model
responses. OpenCode's `maxOutputTokensPerRequest: 4096` and `maxModelStepsPerTurn: 12` bound output
and logical steps; length continuations can occur within a step. None caps an invoice. Scripted
native usage controls proved Claude's budget stop and OpenCode's step bound; title/compaction
output clamps have unit coverage only. The observed tool-item count is a lower bound. No saved
login, refreshable token route or billing attestation follows from this API-key campaign.

The installed source/fixture gates also passed:

- Provider tools 32, Claude 39 and OpenCode 69 tests, with all three typechecks.
- Final runner 47 tests on Linux Node 24.18.0; example 11 tests.
- Full fourteen-package packed-consumer gate and fresh standalone install/build/repository checks,
  example typecheck/tests and CLI `--help`.
- Final credentialless native Linux: 18 final cases, 15 controls and three usage controls;
  Desktop: 36 final cases across outer `none`/`bridge`, 15 controls and three usage controls.
- Original-owner unresolved-cleanup retry on all routes/platforms, native Linux receipt-storage
  failure followed by original-owner recovery, and independently checked resource absence.
- Explicit seven-rule tooling lint, boundary/governance checks, scripts/docs/registry/whitespace
  checks and independent source/qualification reviews.

Repository execution used `pnpm test:agent-sdk-external-consumer`, package-specific build/test/
typecheck commands and the manifest-driven `run.mjs`/`desktop.mjs` tools. The standalone workflow
uses `pnpm build`, `pnpm check:repository`, `pnpm typecheck:examples`,
`pnpm test:examples:accept-edits` and `pnpm examples:accept-edits --help`. Real dispatch is separate
from every hermetic command.

MS009 also passed the full Linux `pnpm test` aggregate and architecture guardrails at the clean
MS008 checkpoint. The aggregate used normal Turbo cache reuse: 131 workspace tasks succeeded,
130 were cached from the same checkout's preceding builds and passing tests, and Hostd reran with
3,387 passing tests, zero failures and one existing skip. The script and later root lanes also
passed. Earlier attempts exposed a full host `/tmp`, missing fresh-checkout build prerequisites
and an overlong owned socket path; these environment issues were corrected without changing source
or test assertions. The successful run used direct host execution with a short owned TMPDIR, not
the abandoned private-`/tmp` wrappers. `ms009-linux-validation.json` retains the exact command,
environment, source identity and log digests; `ms009-validation.md` preserves every failed attempt.
The final documentation changes leave executable source and the qualified installed bytes unchanged.
Publication and deployment still require a separate release decision.

## Evidence index, corrections and cleanup

The retained qualification bundle for EP-20261111-001 includes these immutable records:

| Artifact | Scope | SHA-256 |
| --- | --- | --- |
| `ms008-parent-corrected-source.tar.gz` | Final provider/example/harness source before real inference | `db0c620da5c3a51a43b6351aacea07cc2adc10a48cb8eaaa120d59e17e7914f0` |
| `ms008-final-harness-evidence.json` | Final credentialless native qualification | `13b9412df8fb4fd3552d23fa18734f6d4712d136e250f724d0332e2843c79281` |
| `ms008-real-campaign-evidence.json` | All 39 real rows, per-row manifests/results/cleanup hashes | `1a96bac25a55ec01bc9ed4dbd54d57b0a57c01113d69e3d666f26bca7b642098` |
| `ms008-campaign-ledger.json` | Completed reservations and admission accounting | `ec2589ee078cc7063bc79711fab75911b5d352311e72491f5582aaf586d0e4a5` |
| `ms008-real-parent-source.tar.gz` | Parent orchestration and evidence-export source | `d9003ef901cfaf8a3934c84b616dae5a24bbe56724c0d2141d4dceb4d3634e69` |

`ms008-preparation.md` and `ms008-parent-review.md` preserve the initial preparation and M1–M10
findings: preflight cleanup, late-owner loss, identity/admission/classification gaps, missing
refusal proof, unsafe Desktop cleanup and native usage controls. `ms008-corrections.md` preserves
the repairs and all failed attempts. `ms008-parent-rereview.md` records R1–R5: evidence persistence,
referenced owner lifetime, settlement proof, post-claim failures and nonzero-exit authority.
`ms008-final-harness-qualification.md` records the final changed-harness requalification, including
the invalid missing-profile setup and a lost host dispatcher recovered through its original owner.
`ms008-real-campaign.md` records the harmless pre-dispatch ledger-hash typo and the collector's
missing result-binding check; all affected identities were verified without rerunning models.
Older failures remain historical, not overwritten by later passing outcomes.

Every MS008 original session/process/state/lease owner settled. The runner's broader PID-namespace
survivor proof is distinct from the parent's supplementary command-line census. All 36 real Desktop
seal/dispatch inspections were independently checked, and a fresh query found zero MS008-labelled
containers or volumes. Temporary key copies were removed after scans found no credential in other
task-owned files; the user's source env file was untouched. This does not mean all historical plan
assets were deleted: earlier evidence images, scratch and the deliberately retained
`agenai-owned-tools-scratch-r1` volume remain data, with no task compute running.

Failed cleanup retains the original owner and retry handle. A stopped process or failed evidence
write is not settlement proof, and a new owner cannot replace the original. Desktop recovery
verifies recorded resource tokens and removes nothing by broad prefix or forced deletion. A later
consumer must preserve those ownership rules and independently settle its own resources.

## Release checklist

A later authorized release must choose one coordinated version for all fourteen source packages,
prepare npm package/trusted-publisher configuration for the four unreleased packages (Grok, tools,
Claude and OpenCode), and follow [RELEASING](../../RELEASING.md). Regenerate and verify the public
projection, build/pack/install the final source, retain exact archive/content correspondence and
run required release checks. Include the exact qualification bundle with the handoff; do not imply
that the package version alone reproduces a native binary, image or policy.

Keep existing consumers on their current published tuple until that release. Exhaustive policy
switches need the fourth member, and hosts need explicit approval handling plus preparation of the
qualified composition. Private adoption, credential-route expansion, new native versions/models,
new platforms and deployment are separate decisions. This handoff grants none of them.
