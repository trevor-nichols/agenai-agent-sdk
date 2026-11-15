# Upgrading to 0.4.14

Coordinated `0.4.14` adds explicit approval policies, owned provider compositions and scoped token
usage across fourteen packages. It advances Agent Protocol from V13 to **V14**, despite the patch
version increment. Upgrade all installed `@agen-ai/*` SDK packages together; the live V14 parser
rejects V13. Preserve stored V13 history with its original decoder and bytes.

## Package family

The existing validation, protocol, runtime, orchestration, ACP transport/provider/registry, history
and sandbox packages remain coordinated. Four optional packages are new:

- `@agen-ai/provider-grok`: explicit controlled Grok Build 1.0.77 Docker composition.
- `@agen-ai/provider-tools`: owned serial file/search/command tools and prepared Linux workspace.
- `@agen-ai/provider-claude`: owned Claude Agent SDK 0.3.322 / Code 2.1.322 driver.
- `@agen-ai/provider-opencode`: owned OpenCode V2 2.2.7 driver, with Anthropic/OpenAI API-key routes.

Package roots are inert. Effects require their explicit `/docker` or `/node` entrypoints, prepared
caller-owned infrastructure and original lifecycle/cleanup owners. Publication does not install
native agents, build helper images, migrate consumers or deploy private services.

## Permission policies

Discover support per configured instance and opening operation through
`instance.adapter.approvalPolicy`. An explicit opening `approvalPolicy` must be supported and
confirmed by `session.approvalPolicy`; omission preserves existing provider behavior. Update
exhaustive `AgentApprovalPolicy.kind` handling for `provider_accept_edits`.

- Controlled Grok supports its separately configured `host`, `provider_auto_review` or
  `provider_bypass` policy for one fresh session. Each is a fixed, qualified composition.
- Owned Claude and OpenCode support `host` and `provider_accept_edits`. The latter allows eligible
  structured workspace edits automatically. Explicit denies, protected paths and explicit asks
  retain their restrictions; **every shell command requires exact once-only approval**.
- Generic ACP rejects explicit normalized policies. No public Codex or Cursor execution driver
  ships; their history readers remain independent.

See the [approval-policy example](examples/approval-policy/README.md),
[accept-edits example](examples/accept-edits/README.md) and their original handoffs for exact Linux
x64/native-arm64 Docker Desktop tuples, authentication, containment and cleanup limits. Native
Darwin execution and unqualified native versions are not admitted by publication.

## Token usage and V14 migration

Follow [UPGRADING-TO-AGENT14.md](UPGRADING-TO-AGENT14.md) for the complete migration and
[usage example](examples/usage/README.md) for credential-free installed-entrypoint behavior.

- Add `usage.observed` to exhaustive event handling and the required `tokenUsage` capability to
  custom drivers. Unsupported mappings declare `{ kind: 'unsupported' }` explicitly.
- Read consumption through `@agen-ai/agent-protocol/usage` and the optional pure ledger at
  `@agen-ai/agent-runtime/usage`. Context occupancy no longer carries cumulative counters.
- Replace collaboration `reported` counters with `reference`/`unavailable` handling and account
  for the six new `usage_*` provider contract error codes.
- Preserve exact, lower-bound and unavailable precision, measured scope, origin, comparison
  identity and finality. Never convert missing measurements to zero or add overlapping views.
- Owned Claude, owned OpenCode and controlled Grok report qualified scoped usage. Generic ACP
  declares it unsupported; the raw sandbox CLI recipes expose native output without normalized
  token telemetry.

The original permission-policy handoffs predate V14 and retain their historical protocol/source
identities. The current V14 migration guide and provider READMEs describe the combined release.
Neutral sandbox recovery v3, backend identities and caller-owned cleanup obligations remain.
