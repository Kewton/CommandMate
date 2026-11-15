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
    needles: [
      "`commandmate update` も旧サーバーを止めてから入れ替える",
      "update のあとに自動応答を続けたいときは、Auto-Yes を有効にし直してください",
    ],
  },
  {
    file: "docs/en/user-guide/cli-operations-guide.md",
    needles: [
      "`commandmate update` also stops the old server before swapping it",
      "After an update, enable Auto-Yes again",
    ],
  },
  {
    file: ".claude/skills/catalog-reconcile/SKILL.md",
    needles: [
      "ツール別のキー（`slashCommands.descriptions.<name>.<tool>`）へ分割し、",
      "分割したキーの一覧を固定している試験",
      "attestation の `issue` は正の整数でなければローダが拒否する",
      "worker へ委任する前に決めて契約に書いておく",
      "**自分でツール別のキーへ分割**",
      "split into per-tool keys (claude, codex)",
      "は、\n人手で分ける",
      "`cliTools` を省略した行は Claude 向け",
      "`frequentlyUsed.<tool>` に同じ名前",
      "**ツール単位**で除く",
    ],
  },
  {
    file: "docs/internal/TESTING_GUIDE.md",
    needles: [
      "probe は確保ではない",
      "body は読まない",
      "1 本だけ止めるには `instance` も要る",
    ],
  },
  {
    file: "docs/en/internal/TESTING_GUIDE.md",
    needles: [
      "It does not read the body",
      "pass `instance` as well",
    ],
  },
  {
    file: "docs/reference/skill-agent-compatibility.md",
    needles: [
      "未計測を固定している fixture も同じ変更で直す",
      "tests/unit/lib/skills/compatibility-matrix.test.ts",
      "gemini の行ならさらに",
    ],
  },
];

describe("confirmed memory move (#4403, 4th)", () => {
  for (const { file, needles } of RULES) {
    it(`${file} carries the moved rules`, () => {
      const text = read(file);
      for (const n of needles) expect(text).toContain(n);
    });
  }

  it("the catalog-reconcile 4-2 section no longer teaches the old placeholder behaviour", () => {
    const skill = read(".claude/skills/catalog-reconcile/SKILL.md");
    expect(skill).not.toContain("left as a review placeholder");
    expect(skill).not.toContain("説明がコマンド名そのものになっている衝突を直す");
  });

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
