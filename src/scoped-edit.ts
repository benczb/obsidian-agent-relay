import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { VaultConflict, VaultPathError } from "./vault.js";

// Explicit, deployment-time opt-in. No path comes from the edit request.
export type ScopedEditPolicy = { notePath: string; basePath: string };
export const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export async function safeExisting(root: string, relative: string): Promise<string> {
  if (!relative || relative.includes("\\") || path.isAbsolute(relative) || relative.includes("\0") || relative.split("/").some(p => !p || p === "." || p === "..")) throw new VaultPathError("Invalid scoped path");
  let current = root;
  for (const [i, part] of relative.split("/").entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (i < relative.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new VaultPathError("Scoped path must be a real file inside the vault");
  }
  return current;
}

export class ScopedEditor {
  constructor(private root: string, readonly policy: ScopedEditPolicy) {
    if (!policy.notePath.endsWith(".md") || !policy.basePath.endsWith(".base") || policy.notePath === policy.basePath) throw new VaultPathError("Scoped edit requires one .md and one .base path");
  }
  async inspect(): Promise<{ markdown: string; sha256: string; base: string; baseSha256: string }> {
    const note = await readFile(await safeExisting(this.root, this.policy.notePath));
    const base = await readFile(await safeExisting(this.root, this.policy.basePath));
    return { markdown: note.toString("utf8"), sha256: digest(note), base: base.toString("utf8"), baseSha256: digest(base) };
  }
  async withNoteLock<T>(run: () => Promise<T>): Promise<T> {
    const file = await safeExisting(this.root, this.policy.notePath);
    const release = await lockfile.lock(file, { realpath: false, retries: { retries: 10, minTimeout: 10, maxTimeout: 100 } });
    try { return await run(); } finally { await release(); }
  }
  async prepend(input: { expectedSha256: string; expectedBaseSha256: string; item: string }): Promise<{ sha256: string; unchanged: boolean; backup?: string }> {
    if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || !/^[a-f0-9]{64}$/.test(input.expectedBaseSha256) || !input.item.trim() || input.item.length > 1000 || /[\r\n\0]/.test(input.item)) throw new VaultPathError("Expected hashes and a single-line item are required");
    return this.withNoteLock(async () => {
      const file = await safeExisting(this.root, this.policy.notePath);
      const original = await readFile(file);
      const text = original.toString("utf8");
      if (!Buffer.from(text).equals(original)) throw new VaultPathError("Note must be valid UTF-8");
      const baseFile = await safeExisting(this.root, this.policy.basePath);
      if (digest(await readFile(baseFile)) !== input.expectedBaseSha256) throw new VaultConflict("Base changed; inspect ordering again");
      // Insert after the first level-one title, preserving all pre-existing bytes.
      const title = /^(?:\uFEFF)?(?:---\r?\n[\s\S]*?\r?\n---\r?\n)?[\s\r\n]*# [^\r\n]+(\r?\n|$)/.exec(text);
      if (!title) throw new VaultPathError("Expected a level-one title after optional frontmatter");
      const nl = title[1] || "\n";
      const block = `${nl}- ${input.item}${nl}`;
      const offset = title[0].length;
      if (text.slice(offset).startsWith(block)) return { sha256: digest(original), unchanged: true };
      if (digest(original) !== input.expectedSha256) throw new VaultConflict("Note changed; read it again");
      const updated = Buffer.from(text.slice(0, offset) + (title[1] ? "" : nl) + block + text.slice(offset));
      const suffix = randomUUID();
      const temp = `${file}.scoped-${suffix}.tmp`;
      const backup = `${file}.scoped-${suffix}.bak`;
      let tempExists = false;
      try {
        const oldStat = await lstat(file);
        const backupHandle = await open(backup, "wx", 0o600);
        try { await backupHandle.writeFile(original); await backupHandle.sync(); } finally { await backupHandle.close(); }
        const handle = await open(temp, "wx", oldStat.mode & 0o777);
        tempExists = true;
        try { await handle.writeFile(updated); await handle.sync(); } finally { await handle.close(); }
        // Detect observed out-of-band edits. Non-cooperating writers must be paused
        // by the operator: filesystem rename is not an external-writer CAS.
        await safeExisting(this.root, this.policy.notePath);
        if (digest(await readFile(file)) !== input.expectedSha256 || digest(await readFile(baseFile)) !== input.expectedBaseSha256) throw new VaultConflict("Source changed before commit");
        await rename(temp, file); tempExists = false;
        const actual = await readFile(file);
        if (!actual.equals(updated)) throw new VaultConflict("Readback changed after commit; backup retained");
        return { sha256: digest(actual), unchanged: false, backup: path.relative(this.root, backup) };
      } finally { if (tempExists) await unlink(temp); }
    });
  }
}
