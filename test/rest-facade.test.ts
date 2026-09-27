import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { createRestApp } from "../src/rest-facade.js";

const TOKEN = "test-token-that-is-at-least-thirty-two-characters";

async function fixture(): Promise<{ base: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rest-vault-"));
  const board = path.join(root, "Hermes Board.md");
  await writeFile(board, "---\nkanban-plugin: basic\n---\n\n## Inbox\n\n## In Progress\n\n## Done\n");
  const app = await createRestApp({ boardPath: board, vaultPath: root, token: TOKEN });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

test("vault REST note round-trip, listing, append and search", async () => {
  const f = await fixture();
  try {
    let response = await fetch(`${f.base}/v1/vault/note`, { method: "POST", headers: auth, body: JSON.stringify({ path: "News/Jev.md", markdown: "# Jev\nAvailable" }) });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { path: "News/Jev.md" });
    response = await fetch(`${f.base}/v1/vault/note/append`, { method: "POST", headers: auth, body: JSON.stringify({ path: "News/Jev.md", markdown: "\nNo waitlist" }) });
    assert.equal(response.status, 200);
    response = await fetch(`${f.base}/v1/vault/note?path=News%2FJev.md`, { headers: auth });
    assert.equal(await response.text(), "# Jev\nAvailable\nNo waitlist");
    response = await fetch(`${f.base}/v1/vault`, { headers: auth });
    const listed = await response.json() as any;
    assert.ok(listed.entries.some((entry: any) => entry.path === "News/Jev.md" && entry.type === "note"));
    response = await fetch(`${f.base}/v1/vault/search?q=WAITLIST`, { headers: auth });
    assert.deepEqual(await response.json(), { matches: [{ path: "News/Jev.md", line: 3, excerpt: "No waitlist" }] });
  } finally { await f.close(); }
});

test("vault REST attachment upload and path safety", async () => {
  const f = await fixture();
  try {
    let response = await fetch(`${f.base}/v1/vault/attachments`, { method: "POST", headers: auth, body: JSON.stringify({ filename: "clip.txt", contentBase64: "aGVsbG8=" }) });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { path: "Attachments/clip.txt" });
    response = await fetch(`${f.base}/v1/vault/note`, { method: "POST", headers: auth, body: JSON.stringify({ path: "../escape.md", markdown: "bad" }) });
    assert.equal(response.status, 400);
    response = await fetch(`${f.base}/v1/vault`, {});
    assert.equal(response.status, 401);
  } finally { await f.close(); }
});
