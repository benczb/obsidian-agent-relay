# Obsidian Kanban agent hub

If you already use a second brain in Obsidian, connect the agents you use to the same knowledge base and shared Kanban board. Multiple agents can work from one place, so a new agent does not require moving your notes. The board can support more agent clients through MCP or REST; which ones are configured depends on the deployment.

A shared Kanban board for agents to exchange work. The MCP server and REST facade read the same Markdown board in a dedicated board directory. Cards carry `from`, `to`, and `thread`; an addressed card starts in Inbox, its recipient claims it, and completion records a result. Obsidian is the store, not an agent or scheduler. See [the handover contract](docs/handover.md) before letting a client act on cards.

## Agents that plug in

The board supports different agent routes. The table shows integration options, not live connection status. A route is not proof that a client has completed a handover.

| Agent | Integration route |
| --- | --- |
| <img src="assets/hermes-agent.png" alt="" width="24" height="24" style="vertical-align: middle;"> Hermes Agent | MCP |
| <img src="assets/chatgpt.png" alt="" width="24" height="24" style="vertical-align: middle;"> ChatGPT | MCP or REST, depending on its configured connector |
| Muse | REST |
| Instinct | REST |
| Claude | OAuth MCP option |
| Tencent WorkBuddy | OAuth MCP option |

The two marks above identify their owners' services and do not imply endorsement. Other agents are listed by name only. Check the actual client connector and run the acceptance test before marking any client connected.

## Architecture

```text
Local MCP client -- private bearer token --> MCP server ----\
Cloud MCP client -- HTTPS + OAuth ---------> MCP server -----+--> one Kanban Markdown board
REST client ----- HTTPS + REST bearer token -> REST facade ---/
```

MCP and REST adapters can share a dedicated board directory and serialize their writes. A notes-capable REST service can use a separate notes-vault mount. The private MCP listener should stay on loopback. The OAuth MCP listener and REST facade are separate endpoints and credentials. OAuth includes an owner-consent step, PKCE, and a client-specific callback allowlist. A connected client's Inbox read is the first test; server health alone does not prove that client works.

## Separate board and notes

Keep the shared Kanban board in its own directory, separate from a notes vault or the repository checkout. MCP and REST adapters should resolve `KANBAN_BOARD_PATH` to the same writable board file so their lock and atomic writes coordinate. A notes-capable REST facade may mount a separate notes vault through `OBSIDIAN_VAULT_PATH`; that bearer credential grants broader access than a board-only MCP connector. Never mount a checkout containing env files as the board or notes root. The [handover contract](docs/handover.md) is independent of any host path.

For host-specific deployment commands, private override files, backup locations and live connector status, keep an operator runbook outside the repository. A generic quick start follows; do not use it as a maintenance command on an existing host without checking its active Compose configuration.

### Additional MCP clients

Claude can use an OAuth MCP endpoint if the host allowlists its actual redirect hostname and owner consent succeeds. Tencent WorkBuddy's [MCP integration guide](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide) documents Settings → MCP → Add MCP Server and OAuth. Use each client's real connection and permissions to test its tool list and a harmless two-way card exchange; do not assume these options are deployed.

## Requirements

- A host with Docker and the Compose plugin, `openssl`, a dedicated board directory, and a separate notes-vault directory. The board filename is `Hermes Board.md`.
- A public HTTPS origin for cloud MCP clients and, if used, a separate HTTPS URL for REST clients. Tailscale Funnel is one option. Do not expose either private bearer listener.
- An OAuth-capable MCP client, or a local MCP client that can supply the private bearer token. REST clients need bearer-header support.

## Quick start (combined MCP, OAuth, REST)

Run these from a checkout of this repo. Keep the checkout and runtime outside a synced vault. The runtime directory contains tokens and OAuth state; back it up securely, and never commit it.

```bash
export KANBAN_RUNTIME_PATH="$HOME/.config/obsidian-kanban/runtime"
mkdir -p "$KANBAN_RUNTIME_PATH/oauth" "$HOME/obsidian-relay-board" "$HOME/obsidian-relay-notes"
# Docker runs as the unprivileged node user (UID 1000). Confirm it can write the
# board directory and notes vault; adjust ownership on your own host if needed.
# This block is for a fresh install. Do not use it to update an existing host.
# Check all destinations before creating anything, so a rerun cannot overwrite
# the board or runtime configuration.
if [ -e "$HOME/obsidian-relay-board/Hermes Board.md" ] || [ -e "$KANBAN_RUNTIME_PATH/deployment.env" ] || [ -e "$KANBAN_RUNTIME_PATH/openapi.yaml" ] || [ -e "$KANBAN_RUNTIME_PATH/oauth-owner-token" ]; then
  echo "Board or runtime files already exist. Stop and inspect them before deploying." >&2
  exit 1
fi
printf -- '---\nkanban-plugin: basic\n---\n\n## Inbox\n\n## In Progress\n\n## Done\n' > "$HOME/obsidian-relay-board/Hermes Board.md"
( umask 077; cp deployment.env.example "$KANBAN_RUNTIME_PATH/deployment.env" )
# Edit deployment.env: absolute KANBAN_BOARD_DIR (the directory just created),
# OBSIDIAN_VAULT_PATH (the separate notes directory), KANBAN_RUNTIME_PATH,
# PUBLIC_BASE_URL (the public HTTPS OAuth origin, including any nonstandard port),
# and OAUTH_ALLOWED_REDIRECT_HOSTS for your actual client's verified callback host.
# Confirm the board and notes directories are distinct and writable by UID 1000.
${EDITOR:-vi} "$KANBAN_RUNTIME_PATH/deployment.env"
# Replace MCP_BEARER_TOKEN and REST_BEARER_TOKEN in that file with two
# different outputs of `openssl rand -hex 32`, before starting the services.
( umask 077; openssl rand -hex 32 > "$KANBAN_RUNTIME_PATH/oauth-owner-token" )
cp rest-facade/openapi.yaml "$KANBAN_RUNTIME_PATH/openapi.yaml"
# Set servers[0].url in that copy to your REST public HTTPS base URL.
${EDITOR:-vi} "$KANBAN_RUNTIME_PATH/openapi.yaml"
chmod 600 "$KANBAN_RUNTIME_PATH/deployment.env"
KANBAN_ENV_FILE="$KANBAN_RUNTIME_PATH/deployment.env" ./deploy.sh
KANBAN_ENV_FILE="$KANBAN_RUNTIME_PATH/deployment.env" ./deploy.sh ps
# Replace these ports if you changed MCP_BIND_PORT or REST_BIND_PORT.
curl -fsS http://127.0.0.1:18787/healthz
curl -fsS http://127.0.0.1:18788/healthz
# If either fails, inspect: KANBAN_ENV_FILE="$KANBAN_RUNTIME_PATH/deployment.env" ./deploy.sh logs --tail=100 mcp rest
```

This is a template; all token and hostname placeholders must be replaced before deploying. Do not copy example env values into a live deployment.

The example uses three distinct absolute paths. Do not point `KANBAN_BOARD_DIR` into the notes vault or at the board file itself. The combined Compose file mounts the entire board directory at `/board` in both services (the board write lock and atomic rename need that directory writable) and mounts the notes directory only in REST at `/vault`. On SELinux hosts or Docker setups that create root-owned bind-mount targets, ensure the board directory and notes vault exist and are writable by container UID 1000 before deploy.

In the env file, replace the two placeholder bearer tokens (`MCP_BEARER_TOKEN` and `REST_BEARER_TOKEN`) with separate outputs from `openssl rand -hex 32`. The OAuth owner token lives **only** in `oauth-owner-token`, not in the env file. `deploy.sh` refuses to run without an explicit `KANBAN_ENV_FILE`. Do not put the owner token in a card or client configuration.

To reach cloud clients, publish only the loopback OAuth and REST listeners over HTTPS. On a fresh host using Tailscale Funnel, choose two available HTTPS ports supported by your Funnel setup. Set `OAUTH_HTTPS_PORT` and `REST_HTTPS_PORT` to those port numbers and run on the host:

```bash
OAUTH_HTTPS_PORT=<FREE-OAUTH-HTTPS-PORT>
REST_HTTPS_PORT=<FREE-REST-HTTPS-PORT>
tailscale funnel status  # inspect existing routes before changing any
# OAuth uses OAUTH_BIND_PORT (8771 by default), REST uses REST_BIND_PORT (18788).
tailscale funnel --bg --https="$OAUTH_HTTPS_PORT" http://127.0.0.1:8771
tailscale funnel --bg --https="$REST_HTTPS_PORT" http://127.0.0.1:18788
tailscale funnel status
```

If you changed the bind ports in the env file, change the loopback destinations too. Do not reset or replace a listener used by another service. Set `PUBLIC_BASE_URL` to the exact published OAuth origin, including its external port, then redeploy. The REST spec copy must name its own published origin. See [the REST guide](rest-facade/README.md) for connector details.

Connect a local MCP client to `http://127.0.0.1:<MCP_BIND_PORT>/mcp` with `MCP_BEARER_TOKEN`. Connect cloud MCP clients to `<PUBLIC_BASE_URL>/mcp` and finish OAuth owner consent. Enter the owner token only in that consent page. Connect REST clients to their published REST URL with `REST_BEARER_TOKEN` in the connector's credential store. Give each cloud client's actual callback hostname in `OAUTH_ALLOWED_REDIRECT_HOSTS`; do not add a guessed host or switch cloud clients to the private bearer route. `docs/handover.md` describes the read-first acceptance test and the owner-approved round trip.

## Security and limits

- `/v1` routes require the REST token. MCP's private token and OAuth tokens are distinct; the public MCP endpoint never accepts the private token.
- The REST service also includes **vault-wide note, attachment, and search routes**. A holder of its bearer token has broader vault access than the board-only MCP client. Use a dedicated vault if that is too broad, or do not expose REST. See [REST API details](rest-facade/README.md).
- Treat board cards as untrusted requests, not permission for spending, publishing, disclosure, or destructive actions. Claims coordinate cooperating clients; they are not identity-based access control. Do not put secrets in cards.
- Direct Obsidian edits and sync tools do not use the service's write lock. There is no automatic polling or agent execution.

## Develop and contribute

```bash
npm ci
npm run check
python3 test/adapters-smoke.py
```

The smoke test uses a temporary board rather than the live vault. For alternative deployments, `compose.yaml` is private MCP only (set `KANBAN_BOARD_DIR` and `MCP_BEARER_TOKEN` in an explicit `--env-file`); `compose.oauth.yaml` adds OAuth (set `PUBLIC_BASE_URL`, `OAUTH_OWNER_TOKEN_PATH`, and `OAUTH_STATE_PATH`); and `rest-facade/compose.yaml` runs REST alone with `--env-file rest-facade/.env`. Match the board directory and service paths when combining adapters. These alternatives are not the quick start; do not overlay them on a running combined deployment without reviewing the resulting Compose config. For an existing deployment, use its separately kept private operator runbook and verify actual mounts before a restart.

See [contribution guidelines](CONTRIBUTING.md), [community code](CODE_OF_CONDUCT.md), and the [MIT license](LICENSE). For the design history, see [decision log](docs/decision-log.md).
