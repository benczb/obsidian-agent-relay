# Design decisions

This is a public-facing summary of architectural choices, not a transcript or record of private infrastructure. Historical revisions of this file may still exist in Git history; review and scan history before making the repository public.

## Shared board and protocol

Use one Obsidian Kanban Markdown file as a shared instruction queue instead of exposing an agent or the whole vault through MCP. Clients write addressed cards; recipients list, claim, and complete them. Card fields `from`, `to`, and `thread` carry routing and conversation context. The board file stays legible in Obsidian.

## MCP and OAuth

Offer Streamable HTTP MCP for local clients. Keep its bearer-token listener private. Cloud MCP clients use a separate public HTTPS OAuth endpoint with owner consent, resource binding, and a redirect-host allowlist. The gateway and private MCP route share board logic, not tokens.

## REST adapter

Provide a REST facade for clients without an MCP transport. It shares the board implementation and lockfile with MCP and has its own revocable bearer token plus an OpenAPI spec. Claim and completion endpoints make handover explicit; moving a card is not a claim.

## Vault operations

The REST facade also supports vault-relative note and attachment operations. Paths reject traversal and symbolic links, and creates do not overwrite files. This is deliberately broader access than the board-scoped MCP server: the REST credential should be treated as a vault credential, not just a board credential.

## Commit history

Commit messages for this project follow the commit-with-prompts format, with sensitive information masked. This file documents decisions without retaining personal prompts, account links, hostnames, private paths, or full conversations.

## Planned agent rows (2026-09-28)

Prompt (verbatim): "Add Claude, WorkBuddy here". The accompanying image shows the README's "Agents that plug in" table.

Added Claude as a planned MCP route and Tencent WorkBuddy with route to be decided. Both are explicitly not connected, matching the intro's existing planned status. Names are text only: no third-party logo was added. The existing verification claims for other agents are unchanged.

## Separate board and notes (2026-09-28)

The board directory and notes vault were separated. The public-facing README now describes the architecture and leaves host-specific paths, private runtime overrides, backups and client test evidence to an operator runbook kept outside Git. Card identities and routes remain part of the handover contract, but names in a table do not assert live connections. These current-file edits do not remove earlier prompt logs or operational details from Git history; review and, if needed, rewrite history before making the repository public.

## Fix the public quick start (2026-09-28)

Prompt (verbatim): "asked claude to eval it to see what my obsidian setup can use.. just sharing one point it flagged fyi

Setup: it's broken as shipped. A file the instructions tell you to copy isn't in the repo, and the vault service crashes on startup (I tested it)."

Prompt (verbatim): "Feedback for the public repo"

Prompt (verbatim): "Fix it"

Decision: add sanitized, tracked deployment templates and correct the combined and standalone Compose wiring. MCP and REST now mount the same board directory, whose lockfile and atomic rename require a writable directory mount; REST alone mounts a separate notes vault and receives its required `OBSIDIAN_VAULT_PATH`. The README creates a fresh board without overwriting an existing file and includes health checks. The Python adapter smoke test now supplies a separate notes root and proves REST note writes as well as the board round trip. No host-specific values or runtime tokens are committed. Docker was unavailable in the test workspace: Node entry-point health, REST/MCP round trip, Compose static wiring and unit tests passed, but container startup remains for a Docker host to verify.
