import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { SingleUserOAuthProvider } from "../src/oauth.js";

const resource = new URL("https://oauth.example.test/mcp");
const owner = "fixture-owner-token-".repeat(4);
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oauth-http-"));
  const provider = new SingleUserOAuthProvider({ ownerToken: owner, accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400, scopes: ["mcp"], allowedRedirectHosts: ["client.example.test"] }, resource, dir);
  const app = express();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(resource.origin), resourceServerUrl: resource, scopesSupported: ["mcp"] }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await rm(dir, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example.test/callback"], token_endpoint_auth_method: "none", client_name: '<script>alert("fixture")</script>' }) });
  assert.equal(registered.status, 201);
  const client = await registered.json() as { client_id: string };
  const verifier = "v".repeat(43);
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://client.example.test/callback", response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: resource.href, scope: "mcp", state: "fixture-state" });
  const post = (route: string, values: URLSearchParams) => fetch(`${base}${route}`, { method: "POST", body: values, redirect: "manual" });
  return { base, params, verifier, client, post };
}

test("consent is not frameable and does not leak referrers", async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/authorize?${f.params}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.ok(!html.includes('<script>alert("fixture")</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test("HTTP OAuth enforces owner consent, PKCE, one-use codes and refresh rotation", async t => {
  const f = await fixture(t);
  const consent = new URLSearchParams(f.params);
  consent.set("owner_token", "wrong");
  assert.equal((await f.post("/authorize", consent)).status, 401);
  consent.set("owner_token", owner);
  const approved = await f.post("/authorize", consent);
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get("location")!);
  assert.equal(location.searchParams.get("state"), "fixture-state");
  const exchange = new URLSearchParams({ grant_type: "authorization_code", client_id: f.client.client_id, code: location.searchParams.get("code")!, code_verifier: "incorrect", redirect_uri: f.params.get("redirect_uri")!, resource: resource.href });
  assert.equal((await f.post("/token", exchange)).status, 400);
  exchange.set("code_verifier", f.verifier);
  const issued = await f.post("/token", exchange);
  assert.equal(issued.status, 200);
  const tokens = await issued.json() as { refresh_token: string };
  assert.equal((await f.post("/token", exchange)).status, 400);
  const refresh = new URLSearchParams({ grant_type: "refresh_token", client_id: f.client.client_id, refresh_token: tokens.refresh_token, resource: resource.href, scope: "admin" });
  assert.equal((await f.post("/token", refresh)).status, 400);
  refresh.set("scope", "mcp");
  assert.equal((await f.post("/token", refresh)).status, 200);
  assert.equal((await f.post("/token", refresh)).status, 400);
});
