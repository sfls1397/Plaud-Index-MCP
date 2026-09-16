import fs from "node:fs";

export function packageVersion(): string {
  const pkgPath = new URL("../package.json", import.meta.url);
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "1.1.0";
  }
}
