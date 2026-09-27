import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Response } from "express";
import { SingleUserOAuthProvider } from "../src/oauth.js";

const resource = new URL("https://mcp.example.test:10000/mcp");
const ownerToken = "a".repeat(64);

function providerAt(stateDir: string): SingleUserOAuthProvider {
  return new SingleUserOAuthProvider({
    ownerToken,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86_400,
    scopes: ["mcp"],
    allowedRedirectHosts: ["chatgpt.com"],
  }, resource, stateDir);
}

async function register(provider: SingleUserOAuthProvider, redirectUri = "https://chatgpt.com/connector/oauth/test") {
  assert.ok(provider.clientsStore.registerClient);
  return provider.clientsStore.registerClient({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Test client",
  });
}

function consentResponse(owner_token: string): { response: Response; redirect: () => string | undefined } {
  let location: string | undefined;
  const response = {
    req: { method: "POST", body: { owner_token } },
    redirect: (_status: number, value: string) => { location = value; },
    status: () => response,
    type: () => response,
    send: () => response,
  };
  return { response: response as unknown as Response, redirect: () => location };
}

test("rejects insecure and unapproved dynamic-client redirects", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-oauth-"));
  const provider = providerAt(dir);
  await assert.rejects(register(provider, "http://chatgpt.com/callback"), /redirect_uri is not allowed/);
  await assert.rejects(register(provider, "https://evil.example/callback"), /redirect_uri is not allowed/);
  await register(provider, "http://127.0.0.1:4567/callback");
});

test("issues resource-bound hashed tokens and rotates refresh tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-oauth-"));
  const provider = providerAt(dir);
  const client = await register(provider);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = consentResponse(ownerToken);

  await provider.authorize(client, {
    codeChallenge: challenge,
    redirectUri: client.redirect_uris[0],
    scopes: ["mcp"],
    resource,
    state: "state-1",
  }, consent.response);
  const redirect = new URL(consent.redirect() ?? "");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  assert.equal(redirect.searchParams.get("state"), "state-1");

  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resource);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resource), /Invalid authorization code/);
  const auth = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(auth.resource?.href, resource.href);
  assert.deepEqual(auth.scopes, ["mcp"]);

  const stateText = await readFile(path.join(dir, "oauth-state.json"), "utf8");
  assert.equal(stateText.includes(tokens.access_token), false);
  assert.equal(stateText.includes(tokens.refresh_token ?? "missing"), false);

  assert.ok(tokens.refresh_token);
  const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token, undefined, resource);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token, undefined, resource), /Invalid refresh token/);
  assert.ok(rotated.refresh_token);
});

test("does not let one public client revoke another client's token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-oauth-"));
  const provider = providerAt(dir);
  const client = await register(provider);
  const otherClient = await register(provider, "http://127.0.0.1:4568/callback");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = consentResponse(ownerToken);
  await provider.authorize(client, {
    codeChallenge: challenge,
    redirectUri: client.redirect_uris[0],
    scopes: ["mcp"],
    resource,
  }, consent.response);
  const code = new URL(consent.redirect() ?? "").searchParams.get("code");
  assert.ok(code);
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resource);

  await provider.revokeToken(otherClient, { token: tokens.access_token });
  await provider.verifyAccessToken(tokens.access_token);
  await provider.revokeToken(client, { token: tokens.access_token });
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid or expired access token/);
});

test("requires the exact configured resource", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-oauth-"));
  const provider = providerAt(dir);
  const client = await register(provider);
  const consent = consentResponse(ownerToken);
  await assert.rejects(provider.authorize(client, {
    codeChallenge: "challenge",
    redirectUri: client.redirect_uris[0],
    scopes: ["mcp"],
    resource: new URL("https://mcp.example.test:10000/mcp/other"),
  }, consent.response), /Invalid or missing OAuth resource/);
});
