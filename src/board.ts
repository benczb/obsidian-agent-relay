import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

export type Task = {
  id: string;
  title: string;
  description: string;
  column: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  assignee?: string;
  from?: string;
  to?: string;
  thread?: string;
};

type Meta = Omit<Task, "title" | "column">;
const TASK_RE = /^- \[( |x|X)\] (.*?)\s*<!-- hermes-task:([0-9a-f-]{36}) -->\s*$/;
const META_RE = /^<!-- hermes-meta:([0-9a-f-]{36}) ([A-Za-z0-9_-]+) -->\s*$/;
const COLUMN_RE = /^##\s+(.+?)\s*$/;

function encode(meta: Meta): string {
  return Buffer.from(JSON.stringify(meta)).toString("base64url");
}
function decode(value: string): Meta | undefined {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Meta; }
  catch { return undefined; }
}
function cleanOneLine(value: string, label: string): string {
  const out = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!out) throw new Error(`${label} cannot be empty`);
  if (out.length > 300) throw new Error(`${label} is too long (max 300 characters)`);
  return out;
}
function cleanOptional(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const out = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!out) return undefined;
  if (out.length > 200) throw new Error(`${label} is too long (max 200 characters)`);
  return out;
}
function render(task: Task): string[] {
  const checked = task.column.toLowerCase() === "done" ? "x" : " ";
  const meta: Meta = { id: task.id, description: task.description, createdAt: task.createdAt, updatedAt: task.updatedAt };
  if (task.result) meta.result = task.result;
  if (task.assignee) meta.assignee = task.assignee;
  if (task.from) meta.from = task.from;
  if (task.to) meta.to = task.to;
  if (task.thread) meta.thread = task.thread;
  return [`- [${checked}] ${task.title} <!-- hermes-task:${task.id} -->`, `<!-- hermes-meta:${task.id} ${encode(meta)} -->`];
}

export class ClaimConflict extends Error {}

export class KanbanBoard {
  constructor(readonly file: string) {}

  private async ensureFile(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try { await stat(this.file); }
    catch { await writeFile(this.file, "---\nkanban-plugin: board\n---\n\n## Inbox\n\n## In Progress\n\n## Done\n\n", { flag: "wx" }); }
  }

  private parse(text: string): { lines: string[]; columns: Map<string, number>; tasks: Task[]; ranges: Map<string, [number, number]> } {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const columns = new Map<string, number>();
    const tasks: Task[] = [];
    const ranges = new Map<string, [number, number]>();
    let column = "";
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(COLUMN_RE);
      if (heading) { column = heading[1].trim(); columns.set(column.toLowerCase(), i); continue; }
      const card = lines[i].match(TASK_RE);
      if (!card || !column) continue;
      const id = card[3];
      const metaMatch = lines[i + 1]?.match(META_RE);
      const meta = metaMatch?.[1] === id ? decode(metaMatch[2]) : undefined;
      const now = new Date(0).toISOString();
      tasks.push({ id, title: card[2].trim(), column, description: meta?.description ?? "", createdAt: meta?.createdAt ?? now, updatedAt: meta?.updatedAt ?? now, result: meta?.result, assignee: meta?.assignee, from: meta?.from, to: meta?.to, thread: meta?.thread });
      ranges.set(id, [i, metaMatch?.[1] === id ? i + 1 : i]);
      if (metaMatch?.[1] === id) i++;
    }
    return { lines, columns, tasks, ranges };
  }

  private async withWrite<T>(fn: (text: string) => Promise<{ value: T; text: string }>): Promise<T> {
    await this.ensureFile();
    const release = await lockfile.lock(this.file, { retries: { retries: 8, minTimeout: 25, maxTimeout: 300 }, stale: 10_000 });
    try {
      const current = await readFile(this.file, "utf8");
      const { value, text } = await fn(current);
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
      return value;
    } finally { await release(); }
  }

  async list(column?: string): Promise<Task[]> {
    await this.ensureFile();
    const tasks = this.parse(await readFile(this.file, "utf8")).tasks;
    return column ? tasks.filter(t => t.column.toLowerCase() === column.toLowerCase()) : tasks;
  }
  async get(id: string): Promise<Task> {
    const found = (await this.list()).find(t => t.id === id);
    if (!found) throw new Error(`Task ${id} not found`);
    return found;
  }
  async add(input: { title: string; description?: string; column?: string; assignee?: string; from?: string; to?: string; thread?: string }): Promise<Task> {
    return this.withWrite(async text => {
      const parsed = this.parse(text);
      const wanted = (input.column ?? "Inbox").toLowerCase();
      const heading = parsed.columns.get(wanted);
      if (heading === undefined) throw new Error(`Column '${input.column ?? "Inbox"}' does not exist`);
      const column = parsed.lines[heading].match(COLUMN_RE)![1].trim();
      const now = new Date().toISOString();
      const task: Task = { id: randomUUID(), title: cleanOneLine(input.title, "title"), description: input.description?.trim() ?? "", column, createdAt: now, updatedAt: now, assignee: input.assignee?.trim() || undefined, from: cleanOptional(input.from, "from"), to: cleanOptional(input.to, "to"), thread: cleanOptional(input.thread, "thread") };
      let at = parsed.lines.length;
      for (let i = heading + 1; i < parsed.lines.length; i++) if (COLUMN_RE.test(parsed.lines[i])) { at = i; break; }
      parsed.lines.splice(at, 0, ...render(task), "");
      return { value: task, text: parsed.lines.join("\n") };
    });
  }
  async update(id: string, patch: { title?: string; description?: string; result?: string; assignee?: string; from?: string; to?: string; thread?: string }): Promise<Task> {
    return this.withWrite(async text => {
      const parsed = this.parse(text); const old = parsed.tasks.find(t => t.id === id); const range = parsed.ranges.get(id);
      if (!old || !range) throw new Error(`Task ${id} not found`);
      const task: Task = { ...old, title: patch.title === undefined ? old.title : cleanOneLine(patch.title, "title"), description: patch.description ?? old.description, result: patch.result ?? old.result, assignee: patch.assignee ?? old.assignee, from: patch.from === undefined ? old.from : cleanOptional(patch.from, "from"), to: patch.to === undefined ? old.to : cleanOptional(patch.to, "to"), thread: patch.thread === undefined ? old.thread : cleanOptional(patch.thread, "thread"), updatedAt: new Date().toISOString() };
      parsed.lines.splice(range[0], range[1] - range[0] + 1, ...render(task));
      return { value: task, text: parsed.lines.join("\n") };
    });
  }
  async claim(id: string, agent: string): Promise<Task> {
    return this.transition(id, "In Progress", { kind: "claim", agent: cleanOneLine(agent, "agent") });
  }
  async complete(id: string, result: string, agent?: string): Promise<Task> {
    if (!result.trim()) throw new Error("result cannot be empty");
    return this.transition(id, "Done", { kind: "complete", result, agent });
  }
  async move(id: string, column: string): Promise<Task> {
    return this.transition(id, column, { kind: "move" });
  }
  private async transition(id: string, column: string, operation:
    | { kind: "move" }
    | { kind: "claim"; agent: string }
    | { kind: "complete"; result: string; agent?: string }
  ): Promise<Task> {
    return this.withWrite(async text => {
      const parsed = this.parse(text); const old = parsed.tasks.find(t => t.id === id); const range = parsed.ranges.get(id);
      const targetHeading = parsed.columns.get(column.toLowerCase());
      if (!old || !range) throw new Error(`Task ${id} not found`);
      if (targetHeading === undefined) throw new Error(`Column '${column}' does not exist`);
      const target = parsed.lines[targetHeading].match(COLUMN_RE)![1].trim();
      if (operation.kind === "claim" && (
        old.column.toLowerCase() !== "inbox" || old.to !== operation.agent ||
        (old.assignee && old.assignee !== operation.agent)
      )) throw new ClaimConflict("Task is not an available Inbox card addressed to this agent");
      if (operation.kind === "complete" && operation.agent !== undefined && (
        old.column.toLowerCase() !== "in progress" || old.assignee !== operation.agent
      )) throw new ClaimConflict("Task is not claimed by this agent");
      const task: Task = { ...old, column: target, updatedAt: new Date().toISOString() };
      if (operation.kind === "claim") task.assignee = operation.agent;
      if (operation.kind === "complete") task.result = operation.result;
      parsed.lines.splice(range[0], range[1] - range[0] + 1);
      const reparsed = this.parse(parsed.lines.join("\n")); const newHeading = reparsed.columns.get(target.toLowerCase())!;
      let at = parsed.lines.length;
      for (let i = newHeading + 1; i < parsed.lines.length; i++) if (COLUMN_RE.test(parsed.lines[i])) { at = i; break; }
      parsed.lines.splice(at, 0, ...render(task), "");
      return { value: task, text: parsed.lines.join("\n") };
    });
  }
}
