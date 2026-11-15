/**
 * The six "still holds" lessons moved into docs / skill (Issue #4403, fourth PR).
 * Pins that each rule is present in its section and that the touched files carry no private
 * values. The private-value scan is shown on temporary files first (positive and negative control).
 *
 * @vitest-environment node
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const PRIVATE_RE =
  /\/Users\/(?!(?:yourname|me)\/)[A-Za-z0-9._-]+|\.claude\/projects\/-|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/;

const RULES: ReadonlyArray<{ file: string; needles: readonly string[] }> = [
  {
    file: "docs/user-guide/cli-operations-guide.md",
    needles: ["`commandmate update` も旧サーバーを止めてから", "有効にし直してください"],
  },
  {
    file: "docs/en/user-guide/cli-operations-guide.md",
    needles: ["`commandmate update` also stops the old server", "enable Auto-Yes again"],
  },
  {
    file: ".claude/skills/catalog-reconcile/SKILL.md",
    needles: [
      "ツール別のキー（`slashCommands.descriptions.<name>.<tool>`）へ分割",
      "slash-command-description-override.test.ts",
      "委任する前に決めて",
      "`cliTools` を省略した行は Claude 向け",
      "`frequentlyUsed.<tool>`",
      "**ツール単位**で除く",
    ],
  },
  {
    file: "docs/internal/TESTING_GUIDE.md",
    needles: ["probe は確保ではない", "body は読まない", "全 CLI のセッション"],
  },
  {
    file: "docs/en/internal/TESTING_GUIDE.md",
    needles: ["does not read the body", "every CLI"],
  },
  {
    file: "docs/reference/skill-agent-compatibility.md",
    needles: ["skills-agent-discovery-probe.test.ts", "未計測を固定している対の fixture"],
  },
];

describe("confirmed memory move (#4403, 4th)", () => {
  for (const { file, needles } of RULES) {
    it(`${file} carries the moved rules`, () => {
      const text = read(file);
      for (const n of needles) expect(text).toContain(n);
    });
  }

  it("the catalog-reconcile split description no longer says to write one sentence for both tools", () => {
    expect(read(".claude/skills/catalog-reconcile/SKILL.md")).not.toContain(
      "両ツールの意味を含む 1 文",
    );
  });

  describe("private value scan", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const tmpFile = (body: string): string => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "cm-4403-"));
      dirs.push(d);
      const f = path.join(d, "a.md");
      fs.writeFileSync(f, body);
      return f;
    };

    it("positive control: flags a home path and a mail address", () => {
      const home = ["", "Users", "someone", "x"].join("/");
      expect(PRIVATE_RE.test(fs.readFileSync(tmpFile(home), "utf8"))).toBe(true);
      expect(PRIVATE_RE.test(fs.readFileSync(tmpFile(["a", "b.example"].join("@")), "utf8"))).toBe(true);
    });

    it("negative control: leaves plain text alone", () => {
      expect(PRIVATE_RE.test(fs.readFileSync(tmpFile("plain /api/x?cliTool=codex"), "utf8"))).toBe(false);
    });

    it("the touched docs carry none", () => {
      for (const { file } of RULES) {
        for (const line of read(file).split("\n")) {
          expect(PRIVATE_RE.test(line), `${file}: ${line.slice(0, 60)}`).toBe(false);
        }
      }
    });
  });
});
