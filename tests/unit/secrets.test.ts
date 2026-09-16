import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/sanitize.js";
import { packageVersion } from "../../src/mcp/server.js";

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
    expect(pkg.version).toBe("1.1.1");
    expect(pkg.description).toBe(
      "Semantic search for Plaud notes/transcripts — always-on indexer with local embeddings"
    );
    expect(pkg.description).not.toMatch(/mini indexer/i);
    expect(pkg.description).not.toMatch(/apple tools/i);
    expect(pkg.repository.url).toBe("git+https://github.com/sfls1397/Plaud-Index-MCP.git");
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).some((k) => /apple-tools/i.test(k))).toBe(false);
    expect(packageVersion()).toBe("1.1.1");
  });

  it("does not wire Grok OAuth as indexer auth", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toMatch(/PLAUD_API_TOKEN/);
    expect(readme).toMatch(/Keychain/);
    expect(readme).toMatch(/not Grok/i);
    expect(readme).toMatch(/plaud-index-mcp login/);
    expect(readme).toMatch(/not the shareable path/);
    expect(readme).toMatch(/8199/);
    expect(readme).toMatch(/plaud-index-mcp` `1\.1\.1/);
    expect(readme).toMatch(/plaud-index-mcp@1\.1\.1/);
    expect(readme).toMatch(/docs\/host-setup\.md/);
    expect(readme).toMatch(/signed into Plaud before Allow/);
    expect(readme).toMatch(/2 minutes/);
    expect(readme).toMatch(/logged-in GUI\/Terminal/);
    expect(readme).toMatch(/not via LaunchAgent/);
    expect(readme).toMatch(/Keychain write failed/);
    expect(readme).toMatch(/~\/\.local\/node/);
    expect(readme).not.toMatch(/MacBook Development clone is required/i);
    expect(readme).not.toMatch(/Office Manager/i);
    expect(readme).not.toMatch(/notion\.so/i);
  });

  it("ships an always-on host setup walkthrough a stranger can follow", () => {
    const setup = fs.readFileSync(path.join(root, "docs/host-setup.md"), "utf8");
    expect(setup).toMatch(/always-on/);
    expect(setup).toMatch(/plaud-index-mcp login/);
    expect(setup).toMatch(/8199/);
    expect(setup).toMatch(/signed into Plaud/);
    expect(setup).toMatch(/2 minutes/);
    expect(setup).toMatch(/LaunchAgent/);
    expect(setup).toMatch(/Keychain write failed/);
    expect(setup).toMatch(/ssh -L 8199:localhost:8199/);
    expect(setup).toMatch(/~\/\.local\/node/);
    expect(setup).toMatch(/security -i/);
    expect(setup).toMatch(/4096/);
    expect(setup).toMatch(/does not replace/);
    expect(setup).not.toMatch(/Office Manager/i);
    expect(setup).not.toMatch(/notion\.so/i);
    expect(setup).not.toMatch(/MacBook Development clone/i);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.files).toContain("docs/");
  });

  it("does not commit OAuth client secrets", () => {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/clientSecret\s*:\s*["'][^"']+["']/);
      expect(text, file).not.toMatch(/PLAUD_CLIENT_SECRET\s*=\s*["'][^"']{4,}["']/);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts access and refresh tokens from log text", () => {
    const jwtish = ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".aaa.bbb"].join("");
    const refresh = ["super", "refresh"].join("-");
    const text = redactSecrets(`access_token=${jwtish} refresh_token=${refresh} Bearer ${jwtish}`);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(refresh);
    expect(text).not.toContain(jwtish);
  });
});
