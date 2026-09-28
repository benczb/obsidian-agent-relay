import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VaultConflict, VaultPathError, VaultStore } from "../src/vault.js";

async function fixture(): Promise<{ root: string; vault: VaultStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-"));
  return { root, vault: await VaultStore.open(root) };
}

test("creates, appends, reads, lists and searches notes", async () => {
  const { vault } = await fixture();
  assert.equal(await vault.createNote("News/Jev.md", "# Jev\nAvailable now"), "News/Jev.md");
  await vault.appendNote("News/Jev.md", "\nNo waitlist");
  assert.equal(await vault.readNote("News/Jev.md"), "# Jev\nAvailable now\nNo waitlist");
  assert.deepEqual(await vault.list(), [
    { path: "News", type: "folder" },
    { path: "News/Jev.md", type: "note" },
  ]);
  assert.deepEqual(await vault.search("waitLIST"), [{ path: "News/Jev.md", line: 3, excerpt: "No waitlist" }]);
});

test("uploads base64 attachments without overwriting", async () => {
  const { root, vault } = await fixture();
  assert.equal(await vault.uploadAttachment("image.png", Buffer.from("png").toString("base64")), "Attachments/image.png");
  assert.equal(await readFile(path.join(root, "Attachments/image.png"), "utf8"), "png");
  await assert.rejects(vault.uploadAttachment("image.png", "cG5n"), VaultConflict);
  await assert.rejects(vault.uploadAttachment("nested/image.png", "cG5n"), VaultPathError);
});

test("rejects traversal, absolute paths and symlink escape", async () => {
  const { root, vault } = await fixture();
  await assert.rejects(vault.createNote("../escape.md", "bad"), VaultPathError);
  await assert.rejects(vault.readNote("/etc/passwd"), VaultPathError);
  const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
  await symlink(outside, path.join(root, "linked"));
  await assert.rejects(vault.createNote("linked/escape.md", "bad"), VaultPathError);
});

test("concurrent notes safely share newly created parent directories", async () => {
  const { vault } = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => vault.createNote(`New/Folder/${i}.md`, `Note ${i}`)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 8, JSON.stringify(results));
  assert.equal((await vault.list()).filter(e => e.type === "note").length, 8);
});

test("create note is create-only while append can create a missing note", async () => {
  const { vault } = await fixture();
  await vault.createNote("existing.md", "one");
  await assert.rejects(vault.createNote("existing.md", "two"), VaultConflict);
  await vault.appendNote("new/fresh.md", "created by append");
  assert.equal(await vault.readNote("new/fresh.md"), "created by append");
});
