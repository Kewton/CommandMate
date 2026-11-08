/**
 * Controls for the tolerant whole-tree walk (Issue #4246).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "@tests/helpers/temp-dir";
import { ignoreVanished, walkTree } from "@tests/helpers/tolerant-walk";

describe("walkTree (Issue #4246)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cm-walk-4246-"));
  });
  afterEach(() => {
    chmodSync(root, 0o755);
    removeTempDir(root);
  });

  it("visits nested files (baseline)", () => {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "x.ts"), "");
    const seen: string[] = [];
    walkTree(root, (_full, name) => void seen.push(name));
    expect(seen.sort()).toEqual(["a", "x.ts"]);
  });

  it("skips a directory that vanishes mid-walk (positive control)", () => {
    mkdirSync(join(root, "keep"));
    mkdirSync(join(root, "gone"));
    writeFileSync(join(root, "gone", "y.ts"), "");
    const seen: string[] = [];
    const run = (): void =>
      walkTree(root, (full, name, stat) => {
        seen.push(name);
        // Remove every directory the walk has not entered yet, as a concurrent test would.
        if (stat.isDirectory()) {
          for (const other of ["keep", "gone"]) {
            if (join(root, other) !== full) removeTempDir(join(root, other));
          }
        }
      });
    expect(run).not.toThrow();
    // The first directory entered stays; the sibling removed under the walk is skipped.
    expect(seen.filter((n) => n === "keep" || n === "gone")).toHaveLength(1);
  });

  it("skips a child whose listing fails with ENOENT only after it was stat-ed", () => {
    mkdirSync(join(root, "a"));
    const seen: string[] = [];
    walkTree(root, (full, name) => {
      seen.push(name);
      if (name === "a") removeTempDir(full);
    });
    expect(seen).toEqual(["a"]);
  });

  it("still throws when the walk root itself is missing (negative control)", () => {
    expect(() => walkTree(join(root, "nope"), () => undefined)).toThrow(
      /ENOENT/,
    );
  });

  it("ignoreVanished passes non-ENOENT errors through", () => {
    expect(ignoreVanished(() => 1)).toBe(1);
    expect(() =>
      ignoreVanished(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).toThrow("denied");
    expect(
      ignoreVanished(() => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    ).toBeUndefined();
  });
});
