/**
 * The operations lessons moved out of the tool-private memory into docs/orchestrate/ (Issue #4403).
 *
 * Two things are pinned:
 *
 * 1. The sections that received the lessons exist, so a later edit that drops one
 *    shows up here instead of silently losing the rule.
 * 2. The public operations docs carry no private values. The repository is public;
 *    the moved text was written from notes that held home paths and addresses.
 *    `findPrivateValues` is checked against temporary files first (a positive and a
 *    negative control), then run over the real docs.
 *
 * @vitest-environment node
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** GitHub's heading anchor (same rule as orchestrate-doc-links-3481). */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (c) => (c === "-" || c === "_" ? c : ""))
    .replace(/ /g, "-");
}

/** Anchors of the markdown headings outside fenced code. */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const match = inFence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) anchors.add(githubSlug(match[1]));
  }
  return anchors;
}

/** Built from parts so this file itself does not carry the literal home prefix it tests for. */
const HOME_ROOT = ["", "Users", ""].join("/");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DOCS_DIR = path.join(REPO_ROOT, "docs/orchestrate");

/** Values that must not appear in public docs: home paths, the memory folder, mail addresses. */
const PRIVATE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "macOS home path", re: /\/Users\/[A-Za-z0-9._-]+/ },
  {
    name: "Linux home path",
    re: /\/home\/(?!ubuntu\/_work\b)[a-z][A-Za-z0-9._-]*\//,
  },
  { name: "tool-private memory folder", re: /\.claude\/projects\/-/ },
  {
    name: "mail address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/,
  },
];

/** `file:line: <pattern name>` for every line of `files` that carries a private value. */
export function findPrivateValues(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { name, re } of PRIVATE_PATTERNS) {
        if (re.test(line))
          found.push(`${path.basename(file)}:${i + 1}: ${name}`);
      }
    });
  }
  return found;
}

function publicDocs(): string[] {
  const docs = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(DOCS_DIR, f));
  return [
    ...docs,
    path.join(REPO_ROOT, "AGENTS.md"),
    path.join(REPO_ROOT, "CLAUDE.md"),
  ];
}

describe("findPrivateValues (controls)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports a home path, the memory folder and a mail address (positive control)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-move-4403-"));
    const file = path.join(dir, "leak.md");
    fs.writeFileSync(
      file,
      [
        "ok line",
        `see ${HOME_ROOT}someone/work/x`,
        "from ~/.claude/projects/-Users-someone-work/memory",
        "mail a.b@example.com",
      ].join("\n"),
    );
    expect(findPrivateValues([file])).toEqual([
      "leak.md:2: macOS home path",
      "leak.md:3: tool-private memory folder",
      "leak.md:4: mail address",
    ]);
  });

  it("passes repository paths, ~ paths and the public repository URL (negative control)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-move-4403-"));
    const file = path.join(dir, "clean.md");
    fs.writeFileSync(
      file,
      [
        "run `node scripts/orchestrate/merge-pr.mjs`",
        "rollout under `~/.codex/sessions/**/*.jsonl`",
        "auto memory (`~/.claude/projects/.../memory/`) is off",
        "`gh api repos/Kewton/CommandMate/actions/runners`",
        "git worktree add -b <branch> ../commandmate-<topic> origin/develop",
      ].join("\n"),
    );
    expect(findPrivateValues([file])).toEqual([]);
  });
});

describe("docs/orchestrate after the memory move (#4403)", () => {
  it("carries no private values in docs/orchestrate, AGENTS.md or CLAUDE.md", () => {
    expect(findPrivateValues(publicDocs())).toEqual([]);
  });

  const SECTIONS: ReadonlyArray<[string, string]> = [
    ["contract.md", "2-4 委任の前に本文の前提を確かめる"],
    ["contract.md", "2-4 Issue と契約にコードを載せるとき"],
    ["contract.md", "2-4 scope.allow に対のテストを入れる探し方"],
    ["contract.md", "2-4 変異注入の戻しの確かめ方"],
    ["ci-merge.md", "6-4 一本化で表を壊さない"],
    ["ci-merge.md", "6-3 CI が queued のまま進まないとき"],
    ["ci-merge.md", "6-3 落ちたジョブの理由をステップで読む"],
    ["workers.md", "3-3 zsh で待ち・監視のコマンドを組む"],
    ["workers.md", "3-2 自作の監視ガードと poller の作り方"],
    ["exit-codes.md", "3-3 検証の run を cancel すると task も終わる"],
    ["plan-check.md", "1-3 並列にするときの落とし穴"],
    ["team.md", "8. 依頼ごとの完了の見張り"],
    ["report.md", "8 後の worktree の片付け"],
    ["difficulty.md", "1-2b 委任する Issue で起票側がやること"],
    ["difficulty.md", "1-2b 易の Issue を起票するときの書き方"],
  ];

  it.each(SECTIONS)('%s has the section "%s"', (file, heading) => {
    const anchors = headingAnchors(
      fs.readFileSync(path.join(DOCS_DIR, file), "utf8"),
    );
    expect(anchors.has(githubSlug(heading))).toBe(true);
  });

  it("AGENTS.md carries the rules every agent steps on", () => {
    const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(agents).toContain("git worktree add");
    expect(agents).toContain("positive control");
    expect(agents).toContain("act on exactly that list");
  });
});

/** The moved text, as corrected by the consistency review: each claim matches the code it names. */
describe("the moved text agrees with the code and the runbook (#4403 review)", () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

  it("a body that starts with / is described as a slash command, not as an exit code", () => {
    const workers = read("docs/orchestrate/workers.md");
    expect(workers).toContain("**依頼文を `/` で始めない。**");
    expect(workers).toContain("isSlashCommandBody");
    expect(workers).not.toContain("未送信の exit 99 になる");
    const claude = read("CLAUDE.md");
    expect(claude).toContain("依頼文を `/` で始めない");
    expect(claude).not.toContain("slash コマンドとして扱われ未送信 exit 99");
  });

  it("search hits are candidates for scope.allow, bounded by MAX_SCOPE_PATTERNS", () => {
    const contract = read("docs/orchestrate/contract.md");
    expect(contract).not.toContain("ヒットしたファイルをそのまま allow に入れる");
    expect(contract).toContain("MAX_SCOPE_PATTERNS");
  });

  it("the easy-issue writing rules do not split by file count", () => {
    const difficulty = read("docs/orchestrate/difficulty.md");
    expect(difficulty).not.toContain("4 つ以上になるなら Issue を分ける");
    expect(difficulty).toContain("この節は判定を変えない");
  });

  it("worktrees are cut from origin/develop in the runbook and /worktree-setup", () => {
    expect(read(".claude/commands/orchestrate.md")).toContain(
      'git worktree add -b "feature/{N}-worktree" "../commandmate-issue-{N}" origin/develop',
    );
    const setup = read(".claude/commands/worktree-setup.md");
    expect(setup).toContain(
      'git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" origin/develop',
    );
    // The precondition checks the same base it cuts from: no local develop is required.
    expect(setup).toContain("refs/remotes/origin/develop");
    expect(setup).not.toContain("refs/heads/develop");
    expect(setup).toContain("| origin/develop not found |");
  });

  it("the watch rule gives the real reason --tail misses DONE", () => {
    const team = read("docs/orchestrate/team.md");
    expect(team).not.toContain("空行しか読まない");
    expect(team).not.toContain("末尾が空行だけになる");
  });

  it("report.md notes that /worktree-cleanup misreads squash merges", () => {
    expect(read("docs/orchestrate/report.md")).toContain(
      "入口の `/worktree-cleanup` は `git branch --merged` で判定する",
    );
  });
});
