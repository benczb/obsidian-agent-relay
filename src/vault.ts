import { appendFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export type VaultEntry = { path: string; type: "folder" | "note" };
export type SearchMatch = { path: string; line: number; excerpt: string };

export class VaultPathError extends Error {}
export class VaultConflict extends Error {}

export class VaultStore {
  private readonly root: string;
  private readonly attachmentFolder: string;

  private constructor(root: string, attachmentFolder: string) {
    this.root = root;
    this.attachmentFolder = attachmentFolder;
  }

  static async open(root: string, attachmentFolder = "Attachments"): Promise<VaultStore> {
    if (!path.isAbsolute(root)) throw new VaultPathError("Vault root must be absolute");
    const actualRoot = await realpath(root);
    const store = new VaultStore(actualRoot, attachmentFolder);
    store.validateRelative(attachmentFolder, false);
    return store;
  }

  private validateRelative(input: string, noteOnly: boolean): string {
    if (!input || path.isAbsolute(input) || input.includes("\0")) throw new VaultPathError("Path must be a nonempty vault-relative path");
    const normalized = input.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) throw new VaultPathError("Path cannot contain empty, . or .. segments");
    if (noteOnly && !normalized.toLowerCase().endsWith(".md")) throw new VaultPathError("Note path must end in .md");
    return normalized;
  }

  private async resolveSafe(input: string, noteOnly: boolean, createParents = false): Promise<{ relative: string; absolute: string }> {
    const relative = this.validateRelative(input, noteOnly);
    const parts = relative.split("/");
    const parentParts = parts.slice(0, -1);
    let current = this.root;
    for (const part of parentParts) {
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new VaultPathError("Path parent must be a real directory inside the vault");
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        if (!createParents) break;
        await mkdir(current);
      }
    }
    const absolute = path.join(this.root, ...parts);
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new VaultPathError("Symbolic links are not allowed");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { relative, absolute };
  }

  async list(folder = ""): Promise<VaultEntry[]> {
    let start = this.root;
    let prefix = "";
    if (folder) {
      const resolved = await this.resolveSafe(folder, false);
      start = resolved.absolute;
      prefix = resolved.relative;
    }
    const output: VaultEntry[] = [];
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          output.push({ path: relative, type: "folder" });
          await walk(absolute, relative);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          output.push({ path: relative, type: "note" });
        }
      }
    };
    await walk(start, prefix);
    return output;
  }

  async readNote(notePath: string): Promise<string> {
    const resolved = await this.resolveSafe(notePath, true);
    return readFile(resolved.absolute, "utf8");
  }

  async createNote(notePath: string, markdown: string): Promise<string> {
    const resolved = await this.resolveSafe(notePath, true, true);
    try { await writeFile(resolved.absolute, markdown, { encoding: "utf8", flag: "wx" }); }
    catch (error: any) { if (error?.code === "EEXIST") throw new VaultConflict(`Note already exists: ${resolved.relative}`); throw error; }
    return resolved.relative;
  }

  async appendNote(notePath: string, markdown: string): Promise<string> {
    const resolved = await this.resolveSafe(notePath, true, true);
    await appendFile(resolved.absolute, markdown, "utf8");
    return resolved.relative;
  }

  async uploadAttachment(filename: string, contentBase64: string): Promise<string> {
    const name = this.validateRelative(filename, false);
    if (name.includes("/")) throw new VaultPathError("Attachment filename cannot contain folders");
    const destination = `${this.attachmentFolder}/${name}`;
    const resolved = await this.resolveSafe(destination, false, true);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentBase64, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== contentBase64.replace(/\s/g, "").replace(/=+$/, "")) throw new Error();
    } catch { throw new VaultPathError("contentBase64 must be valid base64"); }
    try { await writeFile(resolved.absolute, bytes, { flag: "wx" }); }
    catch (error: any) { if (error?.code === "EEXIST") throw new VaultConflict(`Attachment already exists: ${resolved.relative}`); throw error; }
    return resolved.relative;
  }

  async search(query: string): Promise<SearchMatch[]> {
    const needle = query.toLocaleLowerCase();
    const results: SearchMatch[] = [];
    for (const entry of await this.list()) {
      if (entry.type !== "note") continue;
      const text = await this.readNote(entry.path);
      text.split(/\r?\n/).forEach((line, index) => {
        if (results.length < 200 && line.toLocaleLowerCase().includes(needle)) results.push({ path: entry.path, line: index + 1, excerpt: line.slice(0, 500) });
      });
      if (results.length >= 200) break;
    }
    return results;
  }
}
