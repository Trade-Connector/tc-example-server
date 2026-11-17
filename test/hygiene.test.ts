// Public-repo hygiene: example data must never be real.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// From ACMA's list of phone numbers reserved for use in fiction: they never reach a real person.
const FICTIONAL_MOBILES = new Set(["0491570006", "0491570156"]);

async function textFiles(): Promise<string[]> {
  const out = [path.join(root, "README.md"), path.join(root, ".env.example")];
  for (const dir of ["src", "public", "docs", "test"]) {
    for (const entry of await readdir(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|js|html|css|md|json)$/.test(entry.name)) out.push(path.join(entry.parentPath, entry.name));
    }
  }
  return out;
}

describe("example data", () => {
  it("uses only ACMA's fictional numbers for Australian mobiles", async () => {
    const files = await textFiles();
    assert.ok(files.length > 20);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/(?:\+61 ?|\b0)4\d{2}[ -]?\d{3}[ -]?\d{3}\b/g)) {
        const digits = match[0].replace(/\D/g, "").replace(/^61/, "0");
        assert.ok(FICTIONAL_MOBILES.has(digits), `${path.relative(root, file)}: ${match[0]} is not one of ACMA's fictional numbers`);
      }
    }
  });

  it("calls the API version v1 and nothing finer", async () => {
    // Within v1, TC adds things without a new version number; a dotted API version would mislead.
    const files = [...(await textFiles()), path.join(root, "CHANGELOG.md")];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      assert.doesNotMatch(text, /\bv1\.\d|\b1\.1\.0\b/, path.relative(root, file));
    }
  });
});
