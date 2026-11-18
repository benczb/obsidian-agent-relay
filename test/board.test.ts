import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KanbanBoard } from "../src/board.js";

test("add, update, move, and preserve unrelated markdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-"));
  const file = path.join(dir, "Hermes Board.md");
  const board = new KanbanBoard(file);
  const added = await board.add({ title: "Research flights", description: "SIN to Tokyo", assignee: "Hermes" });
  assert.equal(added.column, "Inbox");
  await board.update(added.id, { result: "Started" });
  const moved = await board.move(added.id, "In Progress");
  assert.equal(moved.column, "In Progress");
  assert.equal((await board.get(added.id)).description, "SIN to Tokyo");
  const text = await readFile(file, "utf8");
  assert.match(text, /kanban-plugin: board/);
  assert.match(text, /## Done/);
});

test("rejects an unknown column without changing the task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-"));
  const board = new KanbanBoard(path.join(dir, "board.md"));
  const task = await board.add({ title: "Safe task" });
  await assert.rejects(board.move(task.id, "Missing"), /does not exist/);
  assert.equal((await board.get(task.id)).column, "Inbox");
});

test("messaging fields survive add, update, and move", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-"));
  const board = new KanbanBoard(path.join(dir, "board.md"));
  const added = await board.add({ title: "Ping Hermes", from: "muse", to: "hermes", thread: "t-123" });
  assert.equal(added.from, "muse");
  assert.equal(added.thread, "t-123");
  const updated = await board.update(added.id, { description: "follow-up" });
  assert.equal(updated.to, "hermes");
  const moved = await board.move(added.id, "Done");
  assert.equal(moved.thread, "t-123");
  const fetched = await board.get(added.id);
  assert.equal(fetched.from, "muse");
  assert.equal(fetched.to, "hermes");
});

test("cards without messaging fields keep parsing as before", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-"));
  const board = new KanbanBoard(path.join(dir, "board.md"));
  const added = await board.add({ title: "Plain legacy card" });
  assert.equal(added.from, undefined);
  assert.equal((await board.get(added.id)).thread, undefined);
});

test("concurrent first writers initialise a board without losing cards", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-race-"));
  const file = path.join(dir, "board.md");
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => new KanbanBoard(file).add({ title: `Card ${i}` })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 8, JSON.stringify(results));
  assert.equal((await new KanbanBoard(file).list()).length, 8);
});

test("oversized messaging fields are rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanban-"));
  const board = new KanbanBoard(path.join(dir, "board.md"));
  await assert.rejects(board.add({ title: "x", from: "y".repeat(201) }), /too long/);
});
