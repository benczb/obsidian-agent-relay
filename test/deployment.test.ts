import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Docker build context is an explicit source-only allowlist", async () => {
  const rules = (await readFile(new URL("../.dockerignore", import.meta.url), "utf8")).split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  assert.deepEqual(rules, ["**", "!Dockerfile", "!.dockerignore", "!package.json", "!package-lock.json", "!tsconfig.json", "!src/", "!src/**"]);
});
