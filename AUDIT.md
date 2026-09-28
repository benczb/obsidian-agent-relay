# Obsidian Agent Relay audit and fixes

## Scope and verdict

Reviewed repository `benczb/obsidian-agent-relay` at baseline `d4d858a20393f8db2c7cb8dc4763d19949b3fe9b`. Changes are on the local `audit-fixes` branch. No remote push, deployment, live vault access or live credential testing was performed.

Verdict: useful for a trusted single-owner relay, but not a multi-tenant security boundary. Nine reproducible defects or hardening gaps were fixed. No critical remote-code-execution or unauthenticated vault-access exploit was demonstrated. This is a source and fixture-based audit, not a penetration-test certification.

Hamburger took over directly after Ben requested no delegation. Partial source changes and tests left by the stopped worker were read, checked against the baseline and retained only after direct verification. Hamburger added metadata-integrity checks, the missing Docker build-context protection, an isolated container smoke test and documentation clarification. No independent QA pass is claimed.

## Fixed findings

### 1. Medium: access tokens survived a resource URL change

- Location: `src/oauth.ts`, `SingleUserOAuthProvider.verifyAccessToken` (around line 308).
- Original behaviour: a token loaded from the same persisted state directory was accepted after changing the configured resource origin. Expiry was checked but its stored resource was not compared with the current resource.
- Impact: reusing OAuth state during a resource migration preserved access which should have been audience-bound.
- Fix: reject access tokens whose stored resource differs from the configured URL.
- Regression: `persisted access tokens cannot cross a configured resource change`.
- Boundary: changing the underlying board while keeping the same resource URL still requires deliberate token/state revocation.

### 2. Medium: duplicate task IDs could overwrite the wrong card

- Location: `src/board.ts`, `parse` (around line 89).
- Original behaviour: task lookup selected the first duplicate while the range map selected the last. Updating one could overwrite another card.
- Fix: fail closed on duplicate IDs before any write.
- Regression verifies rejection and byte-for-byte board preservation.

### 3. Medium: malformed metadata silently discarded routing and results

- Location: `src/board.ts`, `decode` and metadata parsing (around lines 28 and 90).
- Original behaviour: invalid JSON was silently treated as missing metadata, while JSON primitives and incorrect field types were accepted. A later edit could erase routing, ownership or result data.
- Fix: validate metadata shape, embedded ID and required/optional field types. Reject malformed adjacent metadata markers instead of silently replacing them. Legacy cards with no metadata remain supported.
- Regression exercises invalid JSON, invalid base64-marker syntax, a JSON primitive and incorrect metadata types; verifies the board stays unchanged.

### 4. Medium: concurrent first board requests failed

- Location: `src/board.ts`, `ensureFile`, `withLock` and `list` (around lines 66-126).
- Original behaviour: initial file creation happened before locking. Simultaneous requests raced on exclusive creation and returned EEXIST.
- Fix: acquire the shared pathname lock before initialisation. Only handle ENOENT as a missing file; create the board with mode 0600.
- Regression: eight simultaneous first writes all succeed and leave eight cards.

### 5. Medium: cards entered the Obsidian settings footer

- Location: `src/board.ts`, `parse`, `add` and `transition`.
- Original behaviour: adding or moving a card to the last column appended it after `%% kanban:settings`, outside the normal board section.
- Fix: stop board parsing and insertion at the settings footer and preserve its contents.
- Regression checks both direct addition and movement to the last column.

### 6. Medium: concurrent note creation failed on shared parent folders

- Location: `src/vault.ts`, `resolveSafe` (around lines 46-54).
- Original behaviour: two requests creating the same missing parent raced on mkdir; all but one could fail with EEXIST.
- Fix: tolerate concurrent directory creation, then lstat and reject a symlink or non-directory.
- Regression: eight notes in the same new nested directory all succeed.

### 7. Low: unauthenticated REST requests reached the large JSON parser

- Location: `src/rest-facade.ts`, middleware ordering (around lines 68-75).
- Original behaviour: unauthenticated callers could invoke the 12 MB JSON parser, receive parsing errors and generate parser stack traces before authentication.
- Fix: authenticate `/v1` before parsing its body.
- Regression: malformed JSON without credentials returns 401 JSON rather than a parser error.
- This is resource-exhaustion/error-exposure hardening, not an authentication bypass.

### 8. Low: OAuth consent lacked anti-framing and privacy headers

- Location: `src/oauth.ts`, `authorize` (around lines 252-259).
- Fix: add CSP frame-ancestors denial, X-Frame-Options, no-referrer, no-store and nosniff headers.
- Regression uses real HTTP requests through the SDK auth router and checks headers and escaped client names.
- Additional HTTP coverage verifies wrong owner-token rejection, PKCE, one-use authorisation codes, scope-escalation rejection and refresh-token rotation.

### 9. Medium: no Docker build-context exclusion

- Location: new `.dockerignore`.
- Original behaviour: ignored Git files, local env files, runtime data and other checkout contents could be sent to a Docker builder. Dockerfile COPY statements did not themselves copy all of those files into the final image, so image disclosure is not claimed.
- Fix: allowlist only Dockerfile, package manifests, TypeScript configuration and source inputs.
- Regression asserts the explicit allowlist. Actual Docker build context was approximately 130 kB.

## Additional documentation correction

The quick start now explicitly states that container UID 1000 needs write access to the OAuth state directory and read access to the owner-token file, not just access to the board and notes directories. It warns against making credentials world-readable.

## Verification

- Original baseline: TypeScript build and all 17 existing tests passed; original adapter smoke passed.
- Expanded regression suite against unchanged baseline source: 27 tests, 18 passed and 9 failed as expected.
- Fixed source: TypeScript build passed; all 27 tests passed, with no skipped tests.
- Python adapter smoke: passed real local MCP/REST handover, claim conflict, completion, credential separation and note writing using temporary fixtures.
- HTTP OAuth tests: passed owner-consent, PKCE, code reuse, refresh rotation, scope and consent-header checks.
- `npm audit --json`: zero reported dependency advisories at audit time. This is not proof that dependencies are vulnerability-free.
- `git diff --check`: passed.
- Docker image: built successfully using Node 22 Alpine.
- Docker runtime smoke: passed as UID 1000 with read-only root filesystem, no external network, no host mounts and no published ports. Both services shared a temporary board; MCP claim/completion, REST read-back, note round trip, OAuth startup/discovery and private-token rejection on the public listener passed.
- All four Compose YAML files parsed and their declared host bindings were loopback-only. Full `docker compose config` could not run because this environment has Docker but lacks the Compose plugin. Static YAML checks and a real isolated image run were used instead; production Compose deployment is not verified.
- The host test runtime emitted an existing tsx/Node `module.register()` deprecation warning. The Docker CLI emitted its legacy-builder deprecation warning. Neither was hidden or counted as a test failure.

## Remaining design risks and limits

1. **Shared credentials are broad authority.** Agent names in `from`, `to` and `agent` are self-asserted. A credential holder can impersonate another agent. Administrative move/update and legacy completion without an agent remain available by design. Use only mutually trusted clients; per-agent authorisation requires a separately agreed API/security change.
2. **REST grants whole-vault access.** The REST credential can read/create/append Markdown and upload attachments in the configured vault. It is not a board-only credential. Hidden note paths can be addressed directly even though recursive listing skips hidden entries. Use a dedicated vault without secrets, not a personal or company-wide vault by default.
3. **Local writers remain trusted.** Filesystem path checks reject existing symlinks but are not a race-proof sandbox against hostile local processes replacing path components between checks and use. Direct Obsidian edits and sync writers also bypass the board lock and can cause lost updates. Do not grant untrusted local processes write access to the vault.
4. **OAuth state is single-process state.** JSON persistence has no multi-process transaction coordination. Do not run multiple OAuth writers against the same state directory. Revocation removes the submitted token only, not an entire token family; revoke/clear state deliberately when disconnecting a client or changing what a resource represents.
5. **Public exposure needs operational controls.** Add reverse-proxy limits, monitoring, backups and credential rotation appropriate to the deployment. This audit did not stress-test denial-of-service resistance or exhaustively scan Git history for secrets.
6. **Real clients and production are unverified.** ChatGPT, Muse, Instinct, Claude and WorkBuddy client acceptance tests, HTTPS proxy configuration and live-vault behaviour are outside this isolated audit. A working local service does not prove those integrations are connected.
7. **QA remains open.** No delegated reviewer was started after Ben's instruction. The fixes are locally verified but not independently reviewed; do not treat the Kanban parent as independently QA-approved.

## Artefacts and next action

- Checkout: `/opt/data/audits/obsidian-agent-relay-review`
- Branch: `audit-fixes`
- Evidence logs: `/opt/data/audits/relay-audit-evidence`
- Reproduction runner: `/opt/data/audits/verify-relay.py`
- Baseline comparison checkout: `/opt/data/audits/obsidian-agent-relay-baseline`
- Container smoke test: `test/container-smoke.mjs`

Next action: review the local patch and residual access model. Publication and live rollout are separate steps and have not been performed. Preserve the baseline commit as the rollback point; live rollback is unnecessary because no live service changed.
