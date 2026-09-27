import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import express from "express";
import { z } from "zod";
import { ClaimConflict, KanbanBoard, type Task } from "./board.js";
import { VaultConflict, VaultPathError, VaultStore } from "./vault.js";

// Plain REST facade over the same board file the MCP server edits.
// Meta's Muse agent has no MCP client; its per-user "custom connectors"
// speak REST/GraphQL, so this service exposes exactly the board operations
// as JSON over HTTPS. Both servers share KanbanBoard, whose writes are
// serialized with a lockfile + atomic rename, so MCP and REST can run side
// by side against the same vault without corrupting the board.

type Card = {
  id: string; title: string; body: string; column: string;
  from: string | null; to: string | null; thread: string | null;
  assignee: string | null; result: string | null;
  createdAt: string; updatedAt: string;
};
function toCard(t: Task): Card {
  return {
    id: t.id, title: t.title, body: t.description, column: t.column,
    from: t.from ?? null, to: t.to ?? null, thread: t.thread ?? null,
    assignee: t.assignee ?? null, result: t.result ?? null,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

const addCardSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(20_000).optional(),
  column: z.string().min(1).max(200).optional(),
  from: z.string().min(1).max(200).optional(),
  to: z.string().min(1).max(200).optional(),
  thread: z.string().min(1).max(200).optional(),
  assignee: z.string().max(200).optional(),
}).strict();
const moveCardSchema = z.object({ column: z.string().min(1).max(200) }).strict();
const claimCardSchema = z.object({ agent: z.string().min(1).max(200) }).strict();
const completeCardSchema = claimCardSchema.extend({ result: z.string().trim().min(1).max(50_000) }).strict();
const idSchema = z.uuid();

function sendBoardError(res: express.Response, e: unknown): void {
  const message = e instanceof Error ? e.message : "Unknown error";
  if (e instanceof ClaimConflict) res.status(409).json({ error: "conflict", detail: message });
  else if (/not found/i.test(message)) res.status(404).json({ error: "not_found", detail: message });
  else res.status(400).json({ error: "bad_request", detail: message });
}

export async function createRestApp(config: { boardPath: string; token: string; vaultPath: string; specPath?: string; attachmentFolder?: string }): Promise<express.Express> {
  if (!config.token || config.token.length < 32) throw new Error("REST_BEARER_TOKEN is required and must be at least 32 characters");
  const board = new KanbanBoard(config.boardPath);
  const vault = await VaultStore.open(config.vaultPath, config.attachmentFolder);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "12mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  if (config.specPath) {
    app.get("/openapi.yaml", async (_req, res, next) => {
      try { res.type("application/yaml").send(await readFile(config.specPath!, "utf8")); }
      catch (e) { next(e); }
    });
  }

  app.use("/v1", (req, res, next) => {
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const a = Buffer.from(supplied), b = Buffer.from(config.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    next();
  });

  const notePathSchema = z.string().min(1).max(1000);
  const createNoteSchema = z.object({ path: notePathSchema, markdown: z.string().max(5_000_000) }).strict();
  const attachmentSchema = z.object({ filename: z.string().min(1).max(255), contentBase64: z.string().max(14_000_000) }).strict();
  const sendVaultError = (res: express.Response, error: unknown): void => {
    const detail = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof VaultConflict) res.status(409).json({ error: "conflict", detail });
    else if (error instanceof VaultPathError) res.status(400).json({ error: "invalid_path", detail });
    else if ((error as any)?.code === "ENOENT") res.status(404).json({ error: "not_found", detail });
    else res.status(400).json({ error: "bad_request", detail });
  };

  app.get("/v1/vault", async (req, res) => {
    try { res.json({ entries: await vault.list(typeof req.query.folder === "string" ? req.query.folder : "") }); }
    catch (e) { sendVaultError(res, e); }
  });
  app.get("/v1/vault/note", async (req, res) => {
    const parsed = notePathSchema.safeParse(req.query.path);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request", detail: "path is required" });
    try { res.type("text/markdown").send(await vault.readNote(parsed.data)); }
    catch (e) { sendVaultError(res, e); }
  });
  app.post("/v1/vault/note", async (req, res) => {
    const parsed = createNoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request", detail: parsed.error.message });
    try { res.status(201).json({ path: await vault.createNote(parsed.data.path, parsed.data.markdown) }); }
    catch (e) { sendVaultError(res, e); }
  });
  app.post("/v1/vault/note/append", async (req, res) => {
    const parsed = createNoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request", detail: parsed.error.message });
    try { res.json({ path: await vault.appendNote(parsed.data.path, parsed.data.markdown) }); }
    catch (e) { sendVaultError(res, e); }
  });
  app.post("/v1/vault/attachments", async (req, res) => {
    const parsed = attachmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request", detail: parsed.error.message });
    try { res.status(201).json({ path: await vault.uploadAttachment(parsed.data.filename, parsed.data.contentBase64) }); }
    catch (e) { sendVaultError(res, e); }
  });
  app.get("/v1/vault/search", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!query || query.length > 500) return void res.status(400).json({ error: "invalid_request", detail: "q is required and must be at most 500 characters" });
    try { res.json({ matches: await vault.search(query) }); }
    catch (e) { sendVaultError(res, e); }
  });

app.get("/v1/cards", async (req, res) => {
  try {
    const column = typeof req.query.column === "string" ? req.query.column : undefined;
    res.json({ cards: (await board.list(column)).map(toCard) });
  } catch (e) { sendBoardError(res, e); }
});

app.post("/v1/cards", async (req, res) => {
  const parsed = addCardSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return;
  }
  const { body, ...rest } = parsed.data;
  try { res.status(201).json({ card: toCard(await board.add({ ...rest, description: body })) }); }
  catch (e) { sendBoardError(res, e); }
});

app.get("/v1/cards/:id", async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "invalid_request", detail: "id must be a UUID" }); return; }
  try { res.json({ card: toCard(await board.get(id.data)) }); }
  catch (e) { sendBoardError(res, e); }
});

app.post("/v1/cards/:id/move", async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "invalid_request", detail: "id must be a UUID" }); return; }
  const parsed = moveCardSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "invalid_request", detail: "column (an existing board column name) is required" }); return; }
  try { res.json({ card: toCard(await board.move(id.data, parsed.data.column)) }); }
  catch (e) { sendBoardError(res, e); }
});

app.post("/v1/cards/:id/claim", async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  const input = claimCardSchema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "invalid_request", detail: "UUID id and agent are required" }); return; }
  try { res.json({ card: toCard(await board.claim(id.data, input.data.agent)) }); }
  catch (e) { sendBoardError(res, e); }
});

app.post("/v1/cards/:id/complete", async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  const input = completeCardSchema.safeParse(req.body);
  if (!id.success || !input.success) { res.status(400).json({ error: "invalid_request", detail: "UUID id, agent and nonempty result are required" }); return; }
  try { res.json({ card: toCard(await board.complete(id.data, input.data.result, input.data.agent)) }); }
  catch (e) { sendBoardError(res, e); }
});

  return app;
}

async function main(): Promise<void> {
  const boardPath = process.env.KANBAN_BOARD_PATH;
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const token = process.env.REST_BEARER_TOKEN;
  if (!boardPath) throw new Error("KANBAN_BOARD_PATH is required");
  if (!vaultPath) throw new Error("OBSIDIAN_VAULT_PATH is required");
  if (!token) throw new Error("REST_BEARER_TOKEN is required");
  const app = await createRestApp({ boardPath, vaultPath, token, specPath: process.env.OPENAPI_SPEC_PATH, attachmentFolder: process.env.OBSIDIAN_ATTACHMENTS_FOLDER });
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(port, host, () => console.log(`obsidian-kanban-rest listening on http://${host}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
