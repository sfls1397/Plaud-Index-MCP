import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

describe("no secrets in source, tests, or examples", () => {
  const files = walk(root).filter((f) =>
    /\.(ts|js|json|md|plist|yml|yaml|sh|example)$/.test(f)
  );

  it("does not commit PLAUD_API_TOKEN values or Bearer tokens", () => {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/PLAUD_API_TOKEN\s*[:=]\s*['"][^"'\s]{8,}['"]/);
      expect(text, file).not.toMatch(/Bearer\s+eyJ[A-Za-z0-9._-]{20,}/);
      expect(text, file).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    }
  });

  it("does not depend on Apple Tools MCP", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("plaud-index-mcp");
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.description).toBe(
      "Semantic search for Plaud notes/transcripts — always-on indexer with local embeddings"
    );
    expect(pkg.description).not.toMatch(/mini indexer/i);
    expect(pkg.description).not.toMatch(/apple tools/i);
    expect(pkg.repository.url).toBe("git+https://github.com/sfls1397/Plaud-Index-MCP.git");
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).some((k) => /apple-tools/i.test(k))).toBe(false);
  });

  it("does not wire Grok OAuth as indexer auth", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toMatch(/PLAUD_API_TOKEN/);
    expect(readme).toMatch(/Keychain/);
    expect(readme).toMatch(/not Grok/i);
  });
});
