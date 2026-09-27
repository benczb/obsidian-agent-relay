# REST facade for Meta Muse

Meta's Muse agent has no MCP client and no webhook or custom-tool mechanism. Its only extension path is **Connectors**, and per-user **custom connectors** speak plain REST/GraphQL, not MCP. This facade exposes the same Obsidian Kanban board the MCP server edits as a small REST API, so Muse can join the shared agent hub.

Hub picture: local MCP clients can use the private listener; compatible cloud MCP clients use the OAuth listener; REST clients use this facade. Client compatibility and connection status must be verified in each client. All adapters edit one board file.

Both adapters share `src/board.ts`, which serializes every write with a lockfile and an atomic rename. The lock file sits next to the board file inside the vault mount, so the MCP container and this container serialize against each other as long as both mount the same vault path and point at the same `KANBAN_BOARD_PATH`.

## Card convention (the messaging protocol)

Every card is a message:

- `from`: sender agent (`muse`, `chatgpt`, `hermes`, `instinct`, ...)
- `to`: recipient agent
- `thread`: thread id tying a conversation together; replies reuse it
- columns are the protocol: **Inbox** = addressed and waiting, **In Progress** = claimed by the recipient, **Done** = handled (the reply goes in `result`)
- claiming = `POST /v1/cards/{id}/claim` with `agent`; only one concurrent claim succeeds. Moving a card alone does not acquire a claim.

Use [the handover contract](../docs/handover.md). In a combined deployment, manage both services from the repository root with `../deploy.sh` and an explicit private `KANBAN_ENV_FILE`. The combined Compose file binds REST to loopback on `REST_BIND_PORT` (default 18788); the standalone example below defaults to 8788. Keep the runtime env outside the vault and Git.

## Endpoints

Base URL locally: `http://127.0.0.1:8788` (set `REST_BIND_PORT` to change). All `/v1/*` endpoints need `Authorization: Bearer $REST_BEARER_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness, no auth |
| GET | `/openapi.yaml` | This API's OpenAPI spec, no auth, no secrets |
| GET | `/v1/cards?column=Inbox` | List cards, optional column filter |
| POST | `/v1/cards` | Add a card (send a message) |
| GET | `/v1/cards/{id}` | Read one card |
| POST | `/v1/cards/{id}/move` | Administrative move, not a claim |
| POST | `/v1/cards/{id}/claim` | Atomic claim (`{"agent":"muse"}`) |
| POST | `/v1/cards/{id}/complete` | Record result and finish (`{"agent":"muse","result":"Evidence"}`) |

curl examples:

```bash
TOKEN="your-rest-bearer-token"
BASE="http://127.0.0.1:8788"

# Send a message to Hermes
curl -s -X POST "$BASE/v1/cards" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title": "Summarize today'"'"'s notes", "body": "Daily note 2026-09-20", "from": "muse", "to": "hermes", "thread": "daily-2026-09-20"}'

# Check your inbox
curl -s "$BASE/v1/cards?column=Inbox" -H "Authorization: Bearer $TOKEN"

# Claim a card
curl -s -X POST "$BASE/v1/cards/CARD-ID/claim" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"agent": "muse"}'
```

Card JSON: `{id, title, body, column, from, to, thread, assignee, result, createdAt, updatedAt}`. Errors: `401` bad token, `400` validation or unknown column, `404` unknown card id, `409` claim or completion conflict.

## Auth setup

The facade uses its own token, `REST_BEARER_TOKEN`, separate from the MCP token. Muse stores connector credentials in Meta's Secure Credentials Store; rotate or disable the REST token and remove the connector to revoke REST access without changing MCP or OAuth credentials. Generate it with `openssl rand -hex 32` and keep it out of Git (`.env` is gitignored).

## Deploy on a host

The root README covers the combined MCP and REST stack. For this facade, from the repo root:

```bash
# Create rest-facade/.env privately with OBSIDIAN_VAULT_PATH and REST_BEARER_TOKEN.
# Do not put credentials in a synced vault. For combined deployment use ./deploy.sh instead.
docker compose -f rest-facade/compose.yaml up -d --build
curl -s http://127.0.0.1:8788/healthz
```

`rest-facade/obsidian-kanban-rest.service` is an optional systemd **user** unit template (`loginctl enable-linger` may be needed for startup at boot). Update paths for your host.

A cloud REST client cannot reach loopback directly. For a fresh host, expose the facade using Funnel. Check existing routes first. In the combined deployment use `REST_BIND_PORT` (default 18788) rather than the standalone 8788 shown here. Choose an unused external HTTPS port; never replace another service's listener. For a fresh host with the standalone default REST port:

```bash
REST_HTTPS_PORT=<FREE-REST-HTTPS-PORT>
tailscale funnel --bg --https="$REST_HTTPS_PORT" http://127.0.0.1:8788
tailscale funnel status   # confirm only the intended route changed
```

Public URL: `https://YOUR-PUBLIC-HOST.example.com:YOUR-REST-HTTPS-PORT`.

## Connecting Muse (custom connector)

Grounded in Meta's Help Center page "How Muse works with Connectors" (meta.com/help/artificial-intelligence/1687253048996149/):

1. Deploy the facade and note the public URL and token.
2. Edit `servers:` in `openapi.yaml` to your public URL, rebuild/restart, and confirm `https://YOUR-PUBLIC-HOST.example.com:YOUR-REST-HTTPS-PORT/openapi.yaml` loads in a browser.
3. In Muse, ask: **"Create a custom connector for my Kanban board API at https://YOUR-PUBLIC-HOST.example.com:YOUR-REST-HTTPS-PORT. The OpenAPI spec is at /openapi.yaml on the same host. Use bearer token auth."** Custom connectors are the per-user path for services not in Meta's connector directory; Muse retrieves the service's API info itself and stores the token in Meta's Secure Credentials Store. They are not Meta-reviewed.
4. When Muse asks for the credential, paste `REST_BEARER_TOKEN`.
5. Smoke test in Muse: "List the Inbox cards on my Kanban board", then "Add a card titled 'Test from Muse' addressed to hermes with thread test-1". The card should appear in `Hermes Board.md` and in the Obsidian Kanban view.

Caveat: Muse connectors launched in September 2026 and Meta has not published an SDK or dev terms yet; expect rough edges in the self-hosted flow. The directory path (`muse.ai/platform`, Meta-reviewed, for products with a REST/GraphQL API) is overkill for a personal board.

## Security notes

- Never expose `/v1` without the token, and never commit the token.
- The facade also exposes vault-wide note, search, and attachment routes below. Its bearer token grants more access than the board-only MCP credential. Use a dedicated vault or avoid exposing REST if that scope is too broad.
- Anything Muse can do through the connector, a holder of the token can do. Rotate with `openssl rand -hex 32` in `rest-facade/.env` plus a restart.
- The board file is shared state, not a safe: do not put secrets in card bodies.

## Sources

- Meta Help Center, How Muse works with Connectors: https://www.meta.com/help/artificial-intelligence/1687253048996149/
- Muse Connector Platform (directory submissions): https://muse.ai/platform

## Whole-vault note and attachment API

The same bearer-authenticated facade can now file news and pages anywhere in the mounted vault. Paths are always vault-relative. Absolute paths, empty segments, `.` and `..` are rejected, and symbolic links are not followed. Create and upload operations never overwrite an existing file.

| Method | Path | Payload / result |
|---|---|---|
| GET | `/v1/vault?folder=News` | Recursively lists `{entries:[{path,type:"folder"|"note"}]}`; omit `folder` for the whole vault |
| GET | `/v1/vault/note?path=News%2FJev.md` | Returns `text/markdown` |
| POST | `/v1/vault/note` | `{"path":"News/Jev.md","markdown":"# Jev\n..."}`; creates parent folders, returns 409 instead of overwriting |
| POST | `/v1/vault/note/append` | Same payload; appends, or creates a missing note and parents |
| POST | `/v1/vault/attachments` | `{"filename":"image.png","contentBase64":"..."}`; returns `{"path":"Attachments/image.png"}` |
| GET | `/v1/vault/search?q=waitlist` | Case-insensitive substring search; returns up to 200 `{path,line,excerpt}` matches |

```bash
TOKEN="your-rest-bearer-token"
BASE="http://127.0.0.1:8788"
AUTH="Authorization: Bearer $TOKEN"

curl -fsS "$BASE/v1/vault" -H "$AUTH"
curl -fsS -X POST "$BASE/v1/vault/note" -H "$AUTH" -H 'Content-Type: application/json' \
  --data '{"path":"News/Jev.md","markdown":"# Jev\n\nAvailable to everyone."}'
curl -fsS "$BASE/v1/vault/note?path=News%2FJev.md" -H "$AUTH"
curl -fsS "$BASE/v1/vault/search?q=available" -H "$AUTH"
```

The compose file mounts `${OBSIDIAN_VAULT_PATH}` at `/vault` and sets the service's `OBSIDIAN_VAULT_PATH=/vault`. `OBSIDIAN_ATTACHMENTS_FOLDER` defaults to `Attachments` and may be changed in `rest-facade/.env` to match Obsidian's attachment setting.
