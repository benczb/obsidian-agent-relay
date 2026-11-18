import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KanbanBoard } from "../src/board.js";

test("duplicate IDs fail closed instead of overwriting the other card", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "board-duplicate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "board.md");
  const board = new KanbanBoard(file);
  const card = await board.add({ title: "Original" });
  const before = `${await readFile(file, "utf8")}\n- [ ] Other <!-- hermes-task:${card.id} -->\n`;
  await writeFile(file, before);
  await assert.rejects(board.update(card.id, { title: "Updated" }), /Duplicate task ID/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("invalid metadata fails closed without discarding routing or result", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "board-invalid-meta-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "board.md");
  const board = new KanbanBoard(file);
  const card = await board.add({ title: "Preserve me", to: "hermes" });
  const original = await readFile(file, "utf8");
  for (const encoded of ["invalid", "%%%", Buffer.from("42").toString("base64url"), Buffer.from(JSON.stringify({ id: card.id, description: 123 })).toString("base64url")]) {
    const broken = original.replace(/(<!-- hermes-meta:[^ ]+ )[^ ]+/, `$1${encoded}`);
    await writeFile(file, broken);
    await assert.rejects(board.update(card.id, { title: "Changed" }), /Invalid task metadata/);
    assert.equal(await readFile(file, "utf8"), broken);
  }
});

test("last-column add and move stay before Obsidian settings", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "board-markdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "board.md");
  const footer = '%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%\n';
  await writeFile(file, `---\nkanban-plugin: basic\n---\n\n## Inbox\n\n## Done\n\n${footer}`);
  const board = new KanbanBoard(file);
  const direct = await board.add({ title: "Direct done", column: "Done" });
  const moved = await board.add({ title: "Move me" });
  await board.move(moved.id, "Done");
  const text = await readFile(file, "utf8");
  assert.ok(text.indexOf(direct.id) < text.indexOf("%% kanban:settings"));
  assert.ok(text.indexOf(moved.id) < text.indexOf("%% kanban:settings"));
  assert.ok(text.endsWith(footer));
  assert.equal((await board.list("Done")).length, 2);
});
