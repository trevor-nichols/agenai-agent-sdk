# Controlled Grok approval-policy handoff

Status: qualified unreleased source, 2026-11-11. The source contains eleven packages at development
version `0.4.13`; npm's published `0.4.13` is the earlier ten-package release and does not contain
this feature. No release number, npm publication, trusted-publisher change, deployment or consumer
adoption is performed by this handoff. Agent Protocol V13, private Host V26 and Sandbox recovery v3
are unchanged.

Use the [example guide](README.md) for preparation and execution and the
[provider contract](../../packages/provider-grok/README.md) for admission and ownership. Ordinary
usage needs the public checkout, explicit caller-owned inputs and the documented public
entrypoints; it does not need private qualification controllers, host paths or plan artifacts.

## Contract and qualified tuple

`AgentApprovalPolicy` is `{ kind: 'host' | 'provider_auto_review' | 'provider_bypass' }` from
`@agen-ai/agent-runtime`. Discover operation-specific support through
`instance.adapter.approvalPolicy`; an explicit selection must match
`session.approvalPolicy.policy`. Its `verification` is `native_observation` or
`controlled_configuration`, according to the mapping's actual basis. Omission preserves the
behavior of existing providers without fabricating an effective result. Generic ACP rejects
explicit normalized selections.

`prepareGrokDockerApprovalProfile` and `prepareGrokDockerProvider` from
`@agen-ai/provider-grok/docker` own this particular controlled configuration. Each immutable
constructor admits exactly its one policy, bound instance and fresh native UUID, with cwd
`/workspace/work`. Its support descriptor lists that policy for `create` only; opening requires an
explicit matching `approvalPolicy`, including when the policy is `host`. Resume/branch, policy or
model mutation, structured output, execution input, host tool bindings and native Task are excluded.
One materialization and one admitted create are spent even on failure. Import closes at
materialization entry; export follows settled native stop; outer disposal joins all entered owners
before destruction. Recovery and retries retain original cleanup owners and never replay a prompt.

The mapping is `grok-build-1.0.77-controlled-shell-v1`, native Grok Build `1.0.77` /
`50ca579fa996`, client `agenai-sdk-grok`, model `grok-4.6`. Foreground reasoning is fixed high;
the native reviewer uses that model with low reasoning and a 60-second classification timeout.
Authentication is an explicitly selected existing personal first-party OIDC `auth_json` route,
access-token-only in the workload, with future expiry. It has no API-key, issuer/login/refresh,
model or native API endpoint fallback. The SDK preserves admitted personal billing/privacy
metadata without asserting server-side identity. The guest can read its copied access credential.

| Qualified platform | Native ELF bytes / SHA-256 | Recorded environment |
| --- | --- | --- |
| `linux-x64` | 201,655,392 / `b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a` | Ubuntu 26.04 x86_64, kernel 7.0.0-38-generic, Engine 29.1.3/API 1.52, Node 24.18.0; `fs.suid_dumpable=2`. |
| `desktop-apple-virtualization-native-arm64` | 171,935,112 / `b30eee14a656124ef3c9da8577b5e783ef2cffabeb2b679c5c49633e77eed574` | Native-arm64 macOS host, Docker Desktop 4.98.0 (245422), Engine 29.9.2/API 1.56, kernel 7.0.14-linuxkit, Node 24.22.2; `fs.suid_dumpable=0`. |

Desktop uses Apple Virtualization and the admitted IPv4-only deployment with host networking,
kernel UDP, enhanced isolation and manual proxy disabled. Rosetta is enabled in that deployment
but is not used for the workload; this does not qualify a Rosetta profile. Keep the prepared host/VM
observers, source/executable pins and caller-owned quiescence/interception assumptions from the
[restricted-network contract](../sandbox/README.md#restricted-network-composition).

Set Desktop `backend.egress.routeAuthority.commandTimeoutMs` to **5000** with the recorded 1000 ms
poll interval and 20000 ms helper lease. The original 1000 ms deadline failed before native entry
because acquisition needs stable observations and endpoint settlement; it is retained as a failure.
On the qualified Linux host the pinned `ipExecutable.path` is physical **`/usr/bin/ip`**. The
`/usr/sbin/ip` symlink failed with `ELOOP` under `O_NOFOLLOW`. Pin the actual physical executable's
hash on your host; do not copy that path or hash without preparation. These corrections changed
observer timing/path inputs, not the filesystem/network grants or SDK runtime.

## Observed behavioral matrix

All seven rows satisfy their independent behavioral criteria on **both** qualified platforms.
Each uses fresh bound identities and the same outer grants. Bypass executes the actual documented
installed `native.js run --config` command; the other six rows use the same installed public SDK
through a separately reviewed qualification controller with one reader and original lifecycle owners.

| Row on each platform | Independent observation |
| --- | --- |
| Host allow | One genuine request held while canaries were absent; its exact once-only approval delivered, then the effect appeared once. |
| Host deny | One exact once-only denial after absent-effect observation; no effect. Raw `failed / turn_not_completed` remains an expected-negative result. |
| Native Auto Allow | One actual classifier Allow event, no host callback, then the effect. |
| Native Auto Block | One actual classifier Block event, residual once-only host denial, no effect; raw failed/canceled turn retained. |
| Public CLI bypass | Effect with no permission callback, compared with the host baseline; independent observation occurs during the CLI, not before its prompt. |
| Native hard deny under bypass | Immutable Bash `['*']` rule produced native policy denial without classifier/callback or effect. |
| Entered cancellation | Stable marker/report witnessed before interruption; actual `canceled` receipt and reader outcome, then original cleanup. |

The earlier Desktop preparation timeout, refused UUID reuse, private-controller normalized-kind
error and first Linux CLI preparation failure remain failed/refused records, with consumed
reservations where entered. Classifier prompts were not retried to obtain agreement. Supplemental
negative assessments do not rewrite the raw reports.

Each successful row settled original readers, requests, observers and cleanup. Independent checks
found fourteen owned resource identities absent on Desktop and twelve on Linux, three empty
filtered censuses per row and empty spill. Both canary listeners were stopped/absent; all eight Linux
access-only copies and their private directories were removed. Twelve created Desktop images and
eight created Linux images were removed without force; borrowed helper/base images and caches were
preserved.

## Limits of this qualification

Positive-effect rows observed root-owned mode-0111 native ELFs, zero capabilities,
no-new-privileges, the recorded sysctl, protected-write denial and excluded-network denial against a
healthy owned positive control. Direct zero-I/O opens of the original native process's memory, fd0
and fd1 returned `EACCES`. Under the accepted **Option A** scope, accessible-descriptor sampling is
explicitly incomplete: there is **no complete original ACP pipe-inode alias-exclusion claim** and no
privileged observer. The immutable launcher/direct-exec and trusted host/daemon assumptions remain.

Auto-review means native review of eligible actions. Native preapprovals, configured denials and
mandatory/residual questions still apply. A Block is not an automatic host denial, and these modes
do not authorize host tools, answer forms or widen filesystem/network access. Native logs are
bounded mutable diagnostics, not per-action attestation; the observed log events do not prove every
action was classified or that a classifier is correct. Native `auth_method` log events were absent;
no native auth-method readback or independent account/billing attestation is claimed. Generic
normalized ACP `dynamic_tool_call` does not identify the native tool class.

The live hard-deny control qualifies **`['*']`**. The documented `git reset --hard*` example uses
inspected native prefix/glob semantics but was not an executed git-prefix qualification row.
Ordinary Bash subprocesses remain possible; Grok approval policy does not recursively police
arbitrary child programs. Native Task exclusion rests on the fixed terminal-only profile,
subagent/no-leader controls, exact ELF catalogs for both architectures and historical Mac
adversarial tool-not-found controls. No direct adversarial Linux Task-dispatch claim is made.
Unavailable/malformed/timed-out review combines historical exact Mac native failure observations
with current installed fail-closed dialect tests; it is not a new live Linux backend-outage test.
Configuration/unsupported-operation refusal and credentialless process/connection fault tests have
their own admission/lifecycle scope, not additional paid model rows.

The campaign reserved 100 cents per new attempt and retained failures plus prior MS001 accounting:
**1100 cents Desktop, 800 cents Linux, 1900 cents combined**, within 1100/900/2000-cent authorization.
Actual provider charges are unobserved. Reservations are authorization accounting, not a hard
billing or total-reasoning cap. One SDK turn can issue multiple foreground/reviewer requests.
Rows used a 300-second deadline and an observed eight-tool stop criterion; visible-output bounds
apply only where the API can enforce them. Observational cancellation is not a native hard action
quota, and the qualification does not establish a hard 4096-token total or reasoning limit.

## Exact retained candidates and artifacts

Native execution uses the **R5** eleven archives below, from input snapshot
`743c1b0e18245920624612790fafda13ee33577a` and 1904-file census
`743097424e03a90d3cc9d81281996bae6a671dc97593af0cfef56ab779e6e5ef`. The completed qualification
checkpoint is `26dc7eff9a12a8135f2b2e39de75229f9c136f69`. These are retained source identities,
not a new npm release or public tag.

| R5 archive | SHA-256 |
| --- | --- |
| `agen-ai-validation-0.4.13.tgz` | `73c1e4863ec9a7a69ef69ba41c149b35944bf290344e1b3edd4941c5e1ede6dc` |
| `agen-ai-agent-protocol-0.4.13.tgz` | `5d82d0bdc082e352663f47673bcac843a3695028a346acaaf3dfd59a4ef8130b` |
| `agen-ai-agent-runtime-0.4.13.tgz` | `76697a81d8510e48d3974b0823ebd4b21dbf71d573c57442988d0f8208ec4197` |
| `agen-ai-agent-orchestration-0.4.13.tgz` | `01462535290bff1dc7abe75be43eea12293efcf6f6624e225f6cfcd9df9a20e5` |
| `agen-ai-acp-transport-0.4.13.tgz` | `09569754986099a424bbed38c592c17d108088862d20a68a166817cc3978a991` |
| `agen-ai-provider-acp-0.4.13.tgz` | `b98f264c924ed8bec544deb2ec73dd47c5f06bea3e440be7e0aabf992b4e9b9e` |
| `agen-ai-acp-registry-0.4.13.tgz` | `a02c240d5ac793aa1f2d7a2447c3fc9b51c4d00de9510f739d81ea4ba6b7fc5d` |
| `agen-ai-agent-history-0.4.13.tgz` | `b0d63b9195ff2d1d5665b437a5c75d117faadc5e303cbe32af0aba98da206133` |
| `agen-ai-sandbox-0.4.13.tgz` | `49e70f34320b3fa44d7dcf44a24d36773384a37118ba0c3500a3fe3558b45aee` |
| `agen-ai-sandbox-docker-0.4.13.tgz` | `894799d16adf333ee6529a69ad9bdf907b80a6ff4ed0b710a4b15e040f5c0c94` |
| `agen-ai-provider-grok-0.4.13.tgz` | `17d1d784c0d3d029f9c6a66342c41e1fd69d033cf9caab05ec07ea1711f1207c` |

**R6 MS006 offline validation** uses snapshot `aabc97179266134ae780cb7660dd25d482e79285`, census
`80938fc72703e0db14b0c887831a86895245c6ae283a901105f93b0e5e607b42`, and frozen standalone-lock
SHA-256 `e7f068314eed304a26aafb9c0c0d66c3c66670e641a7a57a99bec886ab7d123c`. Its only public-input
deltas from R5 are the generic ACP tool-kind README correction and the named-import test-fixture
repair. All runtime/declaration/asset members, thirteen native runtime/config artifacts and actual
SDK dependency graphs match. Eight SDK archives are identical; three differ only in manifest object
key order: `/dependencies` in orchestration/Grok and `/devDependencies` in sandbox-docker. All other
key order, scalar/array values and export condition order match. Strict raw archive equality failed
and remains failed; parsed/member/ordered-manifest parity is a separate result.

Both fresh R5 and R6 standalone/installed checks pass. R6 reports 3675 passes, zero failures and 31
stock skips across 35 summary blocks, including repeated source/installed runs; this is not a unique
test count or native matrix count. Each installed tuple matches its own eleven tarballs across 1569
member records and 41 observed SDK resolution edges. Later documentation updates do not rewrite
these original archives or make a prospective release byte-identical.

MS007 documentation and later test-only fixture corrections belong to a separate **R7 final-source
validation** record. R6 is the completed MS006 validation, not a claim that later public input bytes
are unchanged. The final release handoff must retain that later source/test/doc identity and actual
check result while preserving the exact R5 native runtime basis.

The following retained artifacts identify the evidence. They are maintainer provenance inputs,
not files required to run the public example:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `ms006-r5-packed-inputs.tar.gz` | 5,643,996 | `a2f3b1f9a829d57c6f44981208ec191d9fb3f665f5de36b5f4716e6907a59ddd` |
| `ms006-r5-linux-evidence.tar.gz` | 662,099 | `0d70960bcd7490f399527f9f1cc2dba99bc1dcfee34e71dac6bb9e2c68575c8b` |
| `ms006-native-evidence.tar.gz` | 17,349,713 | `e150f4dca57c30c2c7ff43470adb6970c645af26bf7299854a02a97e3360a3e3` |
| `ms006-r6-linux-evidence.tar.gz` | 4,214,956 | `517619ed40f61a6c0d1cd72fc2003fe82ba1559ddcf6ad3bd5aadeb2dbdf2f02` |
| `ms006-r6-manifest-order-supplement.tar.gz` | 6,468 | `9ce935a765e64309e6507a353adaea26d79960f0d22afee9b54d95c515dfb49e` |

The native envelope has 4414 safe unique regular members and 4413 verified inner hashes/modes/sizes;
its manifest SHA-256 is `91f181c2b39e5d056632e78a68caec5c935a619d3014d9d5aee2a0bab71496bc`.
It preserves successful/failed attempts, before-dispatch manifests, exact reviewed controllers,
original recovery, assessments, exported effects and cleanup receipts. Native binaries are omitted
with fourteen explicit path/size/hash records; credentials are excluded. Independent review passed
MS006 with no actionable findings. This handoff summarizes those records without making the private
qualification observers a production SDK feature.

## Release and provider follow-up

A separately authorized release owner must choose one coordinated version for all eleven source
packages, update/review release metadata, build and pack that exact revision, and run the current
[release process](../../RELEASING.md). Keep all installed SDK packages on that coordinated version.
Current source manifests retaining `0.4.13` do not make the new feature available from npm.

`@agen-ai/provider-grok` needs separately authorized package ownership/bootstrap and npm trusted
publisher verification for the reviewed repository and `release.yml` workflow. The existing ten
trusted relationships do not cover a new name. Verify the intended publication/staging permissions,
provenance and registry readback through the release process; do not recreate existing trust or
claim source checks configured it. Publication/dist-tag changes, private deployment and application
adoption remain separate actions. Rebind any prospective package artifacts to this evidence by exact
runtime/configuration/member comparison; renew affected qualification if those behaviors change.

| Follow-up provider | Required separate work |
| --- | --- |
| Claude | Qualify model/status observation and bypass admission on an owned native constructor; no public Claude execution provider is added here. |
| Codex | Separate reviewer selection, approval-prompt behavior and filesystem/network access controls; do not collapse them into one bypass switch. |
| Cursor | Establish an enforceable review-availability/no-fallback path before claiming native auto-review support. |
| OpenCode | Keep custom review an explicitly application-owned plugin with its own admission and qualification; do not relabel it as native provider review. |
| Private Hostd | Design its broker/product authorization and persistence integration separately; this process-local SDK feature changes no private Host V26 or deployment. |
