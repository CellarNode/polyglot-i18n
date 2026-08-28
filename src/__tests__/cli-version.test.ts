import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// CEL-1545: src/cli.ts's `.version(...)` literal has drifted from
// package.json's `version` three times (CEL-1267, and twice more since,
// most recently in this PR) because nothing ties the two together —
// `pnpm build` is a plain `tsc`, so a stale literal ships to npm and
// `--version` misreports forever (a published package can't be edited).
// This guard fails the build the moment they diverge again.
describe("CLI --version matches package.json", () => {
  it("src/cli.ts's .version(...) literal equals package.json's version", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));

    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf-8"));
    const cliSource = readFileSync(`${root}/src/cli.ts`, "utf-8");

    const match = cliSource.match(/\.version\(\s*["']([^"']+)["']\s*\)/);
    expect(match, "expected a .version(\"x.y.z\") call in src/cli.ts").not.toBeNull();

    const cliVersion = match![1];
    expect(cliVersion).toBe(pkg.version);
  });
});
