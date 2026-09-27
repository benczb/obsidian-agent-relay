import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaimConflict, KanbanBoard } from "../src/board.js";

test("two adapters race to claim, only one succeeds; completion preserves routing", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "handover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "board.md");
  const mcp = new KanbanBoard(file), rest = new KanbanBoard(file);
  const card = await rest.add({ title: "Handover", from: "muse", to: "hermes", thread: "test-thread" });
  const claims = await Promise.allSettled([mcp.claim(card.id, "hermes"), rest.claim(card.id, "hermes")]);
  assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(claims.filter(r => r.status === "rejected").length, 1);
  const before = await readFile(file, "utf8");
  await assert.rejects(rest.complete(card.id, "wrong worker", "instinct"), ClaimConflict);
  assert.equal(await readFile(file, "utf8"), before);
  await mcp.complete(card.id, "Evidence recorded", "hermes");
  const done = await rest.get(card.id);
  assert.equal(done.column, "Done");
  assert.equal(done.result, "Evidence recorded");
  assert.equal(done.thread, "test-thread");
  assert.equal(done.from, "muse");
  assert.equal(done.assignee, "hermes");
  await assert.rejects(mcp.claim(card.id, "hermes"), ClaimConflict);
});

test("wrong recipient and unaddressed legacy tasks cannot be claimed", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "handover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const board = new KanbanBoard(path.join(dir, "board.md"));
  const card = await board.add({ title: "For Muse", to: "muse" });
  await assert.rejects(board.claim(card.id, "hermes"), ClaimConflict);
  const legacy = await board.add({ title: "Old task" });
  await assert.rejects(board.claim(legacy.id, "hermes"), ClaimConflict);
  await assert.rejects(board.complete(card.id, " ", "muse"), /empty/);
  assert.equal((await board.get(card.id)).column, "Inbox");
});
