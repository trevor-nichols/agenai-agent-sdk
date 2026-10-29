# Preparing for 0.4.7

`0.4.7` is the unpublished coordinated ten-package candidate. Published npm `latest` and `beta`
remain `0.4.6`. Use matching reviewed source and local archives while evaluating this candidate;
publication requires a separate release. Agent Protocol V13, recovery v3 and backend recovery
identities are unchanged. Existing API-key calls remain compatible.

## Both authentication modes for every Docker harness

The public sandbox examples now offer API keys and existing native accounts for Claude Code,
Grok Build, OpenCode V2, Cursor CLI and Codex. Provider recipes remain example source, while the
neutral sandbox packages supply private credential delivery and lifecycle ownership. Rebuild the
matching credential bootstrap and stage the matching provider launcher assets during explicit image
preparation; the Claude native filename now includes `.credentials.json`.

| Harness | Existing-login selection |
| --- | --- |
| Claude | Explicit native OAuth access token; alternatively a selected native saved account file |
| Grok | Selected first-party native auth.json; `access_token_only` excludes refresh authority |
| OpenCode | Selected native OAuth export/provider/model; native OpenAI browser/headless methods support access-only ChatGPT imports |
| Cursor | Explicit native account token; alternatively a selected native file-store account |
| Codex | Selected ChatGPT auth.json; `access_token_only` projects native `chatgptAuthTokens` |

Supply the chosen credential explicitly. A caller can read its already logged-in native store or
obtain an official native export; the SDK does not silently search home directories or Keychain.
No new API key is required for the account routes. Guest credentials stay outside workspace exports,
and the recipes never write refreshed state back to the host or automatically fall back to a key.

For accounts still used on the host, select the explicit token/access-only route. Refreshable
`caller_quiescent` files require the caller to stop other refreshers and manage any resulting stale
host snapshot. Access-only credentials have finite native lifetimes. OpenCode 2.1.2 refreshes five
minutes early: an access-only expiry already in that window rejects before process reservation;
a delayed start or later credential resolution may fail early with refresh credentials `not_supplied`.
The recipe does not extend expiry, synchronize refresh or replay the task.

The [authentication parity record](examples/sandbox/HANDOFF.md#authentication-parity-native-campaigns-2026-10-28)
retains forty real key/account normal/cancellation positives on Linux x64 and native-arm64 Docker
Desktop, plus four configured OpenCode OpenAI-key positives. It identifies the original development
archives, later repair and corrective-candidate applicability separately. It does not qualify all
OAuth methods, refreshable-file renewal, every model entitlement or Rosetta. Keep original recovery
records and cleanup owners; this correction requires no recovery conversion.
