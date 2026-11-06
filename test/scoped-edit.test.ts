import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ScopedEditor, digest } from "../src/scoped-edit.js";
import { createRestApp } from "../src/rest-facade.js";
import { VaultConflict, VaultPathError, VaultStore } from "../src/vault.js";
const ITEM = "hermes and chatgpt plugin and build lucaOSS";
const TOKEN = "test-token-that-is-at-least-thirty-two-characters";
async function fixture(text = "---\ntags: [personal]\n---\n# Revisit\n\nExisting content\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "scoped-edit-"));
  await mkdir(path.join(root, "Personal"));
  const policy = { notePath: "Personal/revisit.md", basePath: "Personal/top.base" };
  await writeFile(path.join(root, policy.notePath), text);
  await writeFile(path.join(root, policy.basePath), "views:\n  - type: table\n    name: Top revisit list\n    sort:\n      - property: revisit_rank\n        direction: ASC\n");
  const editor = new ScopedEditor(root, policy);
  const before = await editor.inspect();
  const input = { expectedSha256: before.sha256, expectedBaseSha256: before.baseSha256, item: ITEM };
  return { root, editor, policy, before, input, text };
}
test("conditional prepend preserves all old bytes, backs up, reads back and is idempotent", async () => {
  const f = await fixture(); const r = await f.editor.prepend(f.input);
  const text = await readFile(path.join(f.root, f.policy.notePath), "utf8");
  assert.equal(text, f.text.replace("# Revisit\n", `# Revisit\n\n- ${ITEM}\n`));
  assert.equal(r.sha256, digest(text)); assert.equal(r.unchanged, false);
  assert.equal(await readFile(path.join(f.root, r.backup!), "utf8"), f.text);
  assert.deepEqual(await f.editor.prepend(f.input), { sha256: r.sha256, unchanged: true });
  assert.equal((await readdir(path.join(f.root, "Personal"))).filter(n => n.endsWith(".bak")).length, 1);
});
test("stale note or Base hash cannot mutate or create backup", async () => {
  const f = await fixture();
  await assert.rejects(f.editor.prepend({ ...f.input, expectedSha256: "0".repeat(64) }), VaultConflict);
  await assert.rejects(f.editor.prepend({ ...f.input, expectedBaseSha256: "0".repeat(64) }), VaultConflict);
  assert.equal(await readFile(path.join(f.root, f.policy.notePath), "utf8"), f.text);
  assert.equal((await readdir(path.join(f.root, "Personal"))).length, 2);
});
test("CRLF, no trailing newline, malformed titles and multiline items", async () => {
  const f = await fixture("# Revisit\r\n\r\nold\r\n");
  await f.editor.prepend(f.input);
  assert.equal(await readFile(path.join(f.root, f.policy.notePath), "utf8"), `# Revisit\r\n\r\n- ${ITEM}\r\n\r\nold\r\n`);
  const g = await fixture("# Revisit"); await g.editor.prepend(g.input);
  assert.equal(await readFile(path.join(g.root, g.policy.notePath), "utf8"), `# Revisit\n\n- ${ITEM}\n`);
  assert.equal((await g.editor.prepend(g.input)).unchanged, true);
  const bad = await fixture("No title"); await assert.rejects(bad.editor.prepend(bad.input), VaultPathError);
  await assert.rejects(f.editor.prepend({ ...f.input, item: "one\ntwo" }), VaultPathError);
});
test("rejects traversal, symlinks and invalid encoding", async () => {
  const f = await fixture();
  await assert.rejects(new ScopedEditor(f.root, { ...f.policy, notePath: "../outside.md" }).inspect(), VaultPathError);
  await symlink(path.join(f.root, f.policy.notePath), path.join(f.root, "linked.md"));
  await assert.rejects(new ScopedEditor(f.root, { ...f.policy, notePath: "linked.md" }).inspect(), VaultPathError);
  await writeFile(path.join(f.root, f.policy.notePath), Buffer.from([255]));
  await assert.rejects(f.editor.prepend(f.input), VaultPathError);
});
test("concurrent prepend is idempotent; create remains non-overwriting", async () => {
  const f = await fixture();
  const results = await Promise.all([f.editor.prepend(f.input), f.editor.prepend(f.input)]);
  assert.equal(results.filter(r => !r.unchanged).length, 1);
  const vault = await VaultStore.open(f.root);
  await assert.rejects(vault.createNote(f.policy.notePath, "replacement"), VaultConflict);
});
test("REST defaults disabled; configured scope rejects arbitrary path and serializes append", async () => {
  for (const enabled of [false, true]) {
    const f = await fixture(); const app = await createRestApp({ boardPath: path.join(f.root, "board.md"), vaultPath: f.root, token: TOKEN, scopedEdit: enabled ? f.policy : undefined });
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const addr = server.address(); if (!addr || typeof addr === "string") throw Error();
    const base = `http://127.0.0.1:${addr.port}`; const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    try {
      assert.equal((await fetch(base + "/v1/vault/scoped-revisit")).status, 401);
      const inspect = await fetch(base + "/v1/vault/scoped-revisit", { headers });
      assert.equal(inspect.status, enabled ? 200 : 404);
      if (!enabled) continue;
      assert.equal((await fetch(base + "/v1/vault/scoped-revisit/prepend", { method: "POST", headers, body: JSON.stringify({ ...f.input, path: "other.md" }) })).status, 400);
      const responses = await Promise.all([
        fetch(base + "/v1/vault/scoped-revisit/prepend", { method: "POST", headers, body: JSON.stringify(f.input) }),
        fetch(base + "/v1/vault/note/append", { method: "POST", headers, body: JSON.stringify({ path: f.policy.notePath, markdown: "\nconcurrent append" }) }),
      ]);
      assert.equal(responses[1].status, 200);
      assert.ok([200, 409].includes(responses[0].status));
      const actual = await readFile(path.join(f.root, f.policy.notePath), "utf8"); assert.ok(actual.endsWith("\nconcurrent append"));
      if (responses[0].status === 200) { const result = await responses[0].json() as any; assert.equal(result.baseOrderVerified, false); assert.ok(actual.includes(ITEM)); }
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
});
