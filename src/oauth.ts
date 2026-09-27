import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Response } from "express";
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

const authorizationCodeTtlMs = 5 * 60 * 1000;

const tokenRecordSchema = z.object({
  clientId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number().int(),
  resource: z.string().url(),
});

const persistedStateSchema = z.object({
  clients: z.array(OAuthClientInformationFullSchema),
  accessTokens: z.record(z.string(), tokenRecordSchema),
  refreshTokens: z.record(z.string(), tokenRecordSchema),
});

type TokenRecord = z.infer<typeof tokenRecordSchema>;
type PersistedState = z.infer<typeof persistedStateSchema>;

type AuthorizationCodeRecord = {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
};

export type SingleUserOAuthConfig = {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
};

function emptyState(): PersistedState {
  return { clients: [], accessTokens: {}, refreshTokens: {} };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redirectAllowed(redirectUri: string, allowedHosts: Set<string>): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (loopback) return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:" && allowedHosts.has(url.hostname);
}

function exactResourceMatches(requested: URL | undefined, configured: URL): boolean {
  return requested?.href === configured.href;
}

class JsonOAuthStore {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly stateFile: string;
  private state: PersistedState;

  constructor(stateDir: string, allowedRedirectHosts: string[]) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    this.stateFile = path.join(stateDir, "oauth-state.json");
    this.state = this.load();
    this.deleteExpiredTokens();
    const allowedHosts = new Set(allowedRedirectHosts);

    this.clientsStore = {
      getClient: (clientId) => this.state.clients.find((client) => client.client_id === clientId),
      registerClient: (client) => {
        if (client.token_endpoint_auth_method !== undefined && client.token_endpoint_auth_method !== "none") {
          throw new InvalidClientMetadataError("Only public OAuth clients are supported");
        }
        if (client.grant_types?.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")) {
          throw new InvalidClientMetadataError("Only authorization_code and refresh_token grants are supported");
        }
        if (client.response_types?.some((responseType) => responseType !== "code")) {
          throw new InvalidClientMetadataError("Only the code response type is supported");
        }
        if (!client.redirect_uris.every((uri) => redirectAllowed(uri, allowedHosts))) {
          throw new InvalidClientMetadataError("A redirect_uri is not allowed");
        }
        const registered = OAuthClientInformationFullSchema.parse({
          ...client,
          client_id: `obsidian-kanban-${randomUUID()}`,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: "none",
          grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
          response_types: client.response_types ?? ["code"],
        });
        this.state.clients.push(registered);
        this.persist();
        return registered;
      },
    };
  }

  getAccessToken(hash: string): TokenRecord | undefined {
    return this.state.accessTokens[hash];
  }

  getRefreshToken(hash: string): TokenRecord | undefined {
    return this.state.refreshTokens[hash];
  }

  saveTokenPair(accessHash: string, access: TokenRecord, refreshHash: string, refresh: TokenRecord, consumedRefreshHash?: string): boolean {
    if (consumedRefreshHash && !this.state.refreshTokens[consumedRefreshHash]) return false;
    if (consumedRefreshHash) delete this.state.refreshTokens[consumedRefreshHash];
    this.state.accessTokens[accessHash] = access;
    this.state.refreshTokens[refreshHash] = refresh;
    this.persist();
    return true;
  }

  revoke(hash: string): void {
    delete this.state.accessTokens[hash];
    delete this.state.refreshTokens[hash];
    this.persist();
  }

  private load(): PersistedState {
    try {
      return persistedStateSchema.parse(JSON.parse(readFileSync(this.stateFile, "utf8")));
    } catch (error) {
      const fileMissing = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (fileMissing) return emptyState();
      throw new Error(`Cannot load OAuth state at ${this.stateFile}`, { cause: error });
    }
  }

  private deleteExpiredTokens(): void {
    const now = Math.floor(Date.now() / 1000);
    this.state.accessTokens = Object.fromEntries(Object.entries(this.state.accessTokens).filter(([, record]) => record.expiresAt >= now));
    this.state.refreshTokens = Object.fromEntries(Object.entries(this.state.refreshTokens).filter(([, record]) => record.expiresAt >= now));
    this.persist();
  }

  private persist(): void {
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }
}

function authorizationFields(client: OAuthClientInformationFull, params: AuthorizationParams): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function consentPage(client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): string {
  const fields = Object.entries(authorizationFields(client, params))
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`)
    .join("\n");
  const errorMarkup = error ? `<p class="error">${htmlEscape(error)}</p>` : "";
  const clientName = client.client_name ?? client.client_id;
  const scopes = params.scopes?.join(" ") || "mcp";
  const resource = params.resource?.href ?? "Unknown resource";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Obsidian Kanban</title>
<style>
:root{color-scheme:light;--ink:#17211b;--paper:#f4efe3;--line:#b7aa91;--accent:#b7472a;--panel:#fffaf0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 12%,#e6c98f55,transparent 32%),var(--paper);color:var(--ink);font-family:Georgia,serif}main{width:min(92vw,520px);margin:10vh auto;padding:38px;background:var(--panel);border:1px solid var(--line);box-shadow:10px 10px 0 #263a2d}h1{margin:0 0 12px;font-size:2rem}p{line-height:1.5}.warning{font-weight:700}.facts{padding:18px;border:1px solid var(--line);background:#f8f0dd}.facts b{display:block;margin-top:10px;font:700 .72rem sans-serif;letter-spacing:.08em;text-transform:uppercase}.facts span{display:block;margin-top:3px;overflow-wrap:anywhere}.error{padding:10px;background:#f7d8ce;color:#7c1f0b}label{display:block;margin:22px 0 7px;font-weight:700}input[type=password]{width:100%;padding:12px;border:1px solid var(--line);background:white;font:1rem monospace}button{width:100%;margin-top:14px;padding:13px;border:0;background:var(--accent);color:white;font-weight:700;cursor:pointer}</style>
</head>
<body><main><h1>Connect Obsidian Kanban</h1><p class="warning">Approve only your own ChatGPT connection. This grants read and write access to the configured board.</p>${errorMarkup}<div class="facts"><b>Client</b><span>${htmlEscape(clientName)}</span><b>Scope</b><span>${htmlEscape(scopes)}</span><b>Resource</b><span>${htmlEscape(resource)}</span></div><form method="post">${fields}<label for="owner_token">Owner token</label><input id="owner_token" name="owner_token" type="password" autocomplete="current-password" required autofocus><button type="submit">Authorize</button></form></main></body>
</html>`;
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly store: JsonOAuthStore;

  constructor(
    private readonly config: SingleUserOAuthConfig,
    private readonly resource: URL,
    stateDir: string,
  ) {
    this.store = new JsonOAuthStore(stateDir, config.allowedRedirectHosts);
    this.clientsStore = this.store.clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    if (!exactResourceMatches(params.resource, this.resource)) throw new InvalidRequestError("Invalid or missing OAuth resource");
    if (!(params.scopes ?? []).every((scope) => this.config.scopes.includes(scope))) throw new InvalidRequestError("Requested scope is not supported");
    const normalizedParams = {
      ...params,
      scopes: params.scopes?.length ? params.scopes : this.config.scopes,
    };

    if (response.req.method !== "POST") {
      response.status(200).type("html").send(consentPage(client, normalizedParams));
      return;
    }

    const parsed = z.object({ owner_token: z.string() }).safeParse(response.req.body);
    if (!parsed.success || !safeEquals(parsed.data.owner_token, this.config.ownerToken)) {
      response.status(401).type("html").send(consentPage(client, normalizedParams, "The owner token was not accepted."));
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, { clientId: client.client_id, params: normalizedParams, expiresAtMs: Date.now() + authorizationCodeTtlMs });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state !== undefined) redirect.searchParams.set("state", params.state);
    response.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.validCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const record = this.consumeCode(client, authorizationCode);
    if (redirectUri !== record.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (!resource || !exactResourceMatches(resource, this.resource) || resource.href !== record.params.resource?.href) throw new InvalidGrantError("Invalid resource");
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource ?? this.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const refreshHash = tokenHash(refreshToken);
    const record = this.store.getRefreshToken(refreshHash);
    const now = Math.floor(Date.now() / 1000);
    if (!record || record.clientId !== client.client_id || record.expiresAt < now) throw new InvalidGrantError("Invalid refresh token");
    if (!resource || !exactResourceMatches(resource, this.resource) || resource.href !== record.resource) throw new InvalidGrantError("Invalid resource");
    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    return this.issueTokens(client.client_id, requestedScopes, new URL(record.resource), refreshHash);
  }

  async verifyAccessToken(token: string) {
    const record = this.store.getAccessToken(tokenHash(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt, resource: new URL(record.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = tokenHash(request.token);
    const record = this.store.getAccessToken(hash) ?? this.store.getRefreshToken(hash);
    if (record?.clientId === client.client_id) this.store.revoke(hash);
  }

  private validCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) throw new InvalidGrantError("Invalid authorization code");
    return record;
  }

  private consumeCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCodeRecord {
    const record = this.validCode(client, authorizationCode);
    this.codes.delete(authorizationCode);
    return record;
  }

  private issueTokens(clientId: string, scopes: string[], resource: URL, consumedRefreshHash?: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const access: TokenRecord = { clientId, scopes, expiresAt: now + this.config.accessTokenTtlSeconds, resource: resource.href };
    const refresh: TokenRecord = { clientId, scopes, expiresAt: now + this.config.refreshTokenTtlSeconds, resource: resource.href };
    if (!this.store.saveTokenPair(tokenHash(accessToken), access, tokenHash(refreshToken), refresh, consumedRefreshHash)) throw new InvalidGrantError("Invalid refresh token");
    return { access_token: accessToken, token_type: "bearer", expires_in: this.config.accessTokenTtlSeconds, refresh_token: refreshToken, scope: scopes.join(" ") };
  }
}
