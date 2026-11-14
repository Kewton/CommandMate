/**
 * The testing / UAT / tmux / hooks / detection lessons moved out of the tool-private
 * memory into docs (Issue #4403, second PR).
 *
 * Two things are pinned:
 *
 * 1. The sections that received the lessons exist, so a later edit that drops one
 *    shows up here instead of silently losing the rule.
 * 2. The receiving docs carry no private values. The repository is public; the moved
 *    text was written from notes that held home paths, account names and addresses.
 *    `findPrivateValues` is checked against temporary files first (a positive and a
 *    negative control), then run over the real docs.
 *
 * @vitest-environment node
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** GitHub's heading anchor (same rule as orchestrate-memory-move-4403). */
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

/**
 * Values that must not appear in public docs. The `yourname` home path is the placeholder the
 * docs already use for an example path, so it is allowed.
 */
const PRIVATE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "macOS home path", re: /\/Users\/(?!yourname\/)[A-Za-z0-9._-]+/ },
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
function findPrivateValues(files: readonly string[]): string[] {
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

/** Repo-relative doc -> headings this PR added to it. */
const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  "docs/internal/TESTING_GUIDE.md": [
    "テストの落とし穴",
    "合否は exit code で見る",
    "CI だけで落ちるテスト",
    "並列 worktree と負荷",
    "変異注入でテストが空振りでないことを示す",
    "モックとテスト環境の罠",
    "build と静的ガードだけが見るもの",
    "一括置換の確かめ",
    "E2E（Playwright）",
    "実 TUI と tmux を使う検証",
    "サーバの負荷を測る",
  ],
  "docs/internal/MANUAL_TESTING_GUIDE.md": [
    "実機の UAT の罠",
    "検出の修正は空虚な合格に注意する",
    "入力欄と配置の UAT",
    "ブラウザの自動操作",
    "Playwright のハーネスの罠",
  ],
  "docs/user-guide/uat-isolation.md": [
    "run-server.sh を通さずに手で立てるとき",
    "環境は `env -i` で全部渡し、動いているプロセスで確かめる",
    "本番の DB を UAT のサーバーに読ませない",
    "tmux は私設のサーバーを通常の環境で起こす",
    "codex をサーバーを通さずに測る",
    "UAT の組み方",
    "振る舞いを変えない変更は変更前のビルドと比べる",
    "本物に頼らず状態を作る",
  ],
  "docs/architecture.md": [
    "14. 実装上の制約と罠",
    "14.1 server.ts の import",
    "14.2 dist/server に入るコードと ESM-only 依存",
    "14.3 route handler に届く URL",
    "14.4 i18n（next-intl）",
    "14.5 プロンプトの読み手",
    "14.6 status のキャプチャキャッシュ",
  ],
  "docs/design/agent-event-source-interface.md": [
    "6. ツール別の実測（実装と実機プローブの前提）",
    "6.1 Command Code の TUI・転写・headless",
    "6.2 copilot の picker を実機で採るときの罠",
    "6.3 model・effort の切替",
  ],
  "docs/design/codex-detection-corpus.md": [
    "4. 画面の読み方の実測（composer とダイアログ）",
    "4-2. 番号を持たないダイアログ",
  ],
  "docs/design/codex-agent-event-source.md": [
    "3.6 共有デーモンでは hook がデーモンの環境で動く（0.157 以降）",
  ],
  "docs/design/1623-tmux-reading-mode.md": [
    "attach の可視域と tmux hook の実測（tmux 3.5a）",
  ],
  "docs/reference/skill-agent-compatibility.md": [
    "8.7 `skill_loaded` はストリームにしか出ない",
  ],
};

/** Every doc this PR wrote into (headings or bullets). */
const RECEIVING_DOCS: readonly string[] = [
  ...Object.keys(SECTIONS),
  "docs/design/agent-hooks-gemini-antigravity-integration.md",
  "docs/user-guide/opencode-v2.md",
  "AGENTS.md",
];

describe("findPrivateValues (controls)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports a home path, the memory folder and a mail address (positive control)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-move-4403-d2-"));
    const file = path.join(dir, "leak.md");
    fs.writeFileSync(
      file,
      [
        "ok line",
        `CM_DB_PATH=${HOME_ROOT}someone/work/data/uat.db`,
        "from ~/.claude/projects/-Users-someone-work/memory",
        "captured frame shows a.b@example.com",
      ].join("\n"),
    );
    expect(findPrivateValues([file])).toEqual([
      "leak.md:2: macOS home path",
      "leak.md:3: tool-private memory folder",
      "leak.md:4: mail address",
    ]);
  });

  it("passes placeholders, ~ paths and the public repository URL (negative control)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-move-4403-d2-"));
    const file = path.join(dir, "clean.md");
    fs.writeFileSync(
      file,
      [
        `CM_ROOT_DIR=${HOME_ROOT}yourname/projects`,
        "env -i HOME=\"$HOME\" CM_DB_PATH=<run>/uat.db node dist/server/server.js",
        "tmux -L <label> -f /dev/null new-session -d -x 200 -y 1000",
        "https://github.com/Kewton/CommandMate/issues",
        "rollout under `~/.codex/sessions/**/*.jsonl`",
      ].join("\n"),
    );
    expect(findPrivateValues([file])).toEqual([]);
  });
});

describe("docs after the testing / tmux memory move (#4403)", () => {
  it("carries no private values in the receiving docs", () => {
    expect(
      findPrivateValues(RECEIVING_DOCS.map((f) => path.join(REPO_ROOT, f))),
    ).toEqual([]);
  });

  const cases = Object.entries(SECTIONS).flatMap(([file, headings]) =>
    headings.map((heading): [string, string] => [file, heading]),
  );

  it.each(cases)('%s has the section "%s"', (file, heading) => {
    const anchors = headingAnchors(
      fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
    );
    expect(anchors.has(githubSlug(heading))).toBe(true);
  });

  it("AGENTS.md carries the exit-code and Playwright rules every agent steps on", () => {
    const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(agents).toContain("echo $?");
    expect(agents).toContain("CI=true npx playwright test");
  });
});

/** The moved text, as corrected by the review: each claim matches the code it names. */
describe("the moved text agrees with the code (#4403 review)", () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

  it("the trust dialog is answered by moving to Yes, not by a bare Enter", () => {
    const guide = read("docs/internal/TESTING_GUIDE.md");
    expect(guide).not.toContain("ダイアログは Enter で通す");
    expect(guide).toContain("Enter だけで通さない");
    expect(guide).toContain("resolveClaudeTrustDialogKeys");
    // The code this rule mirrors: some claude versions default the cursor to "No, exit".
    expect(read("src/lib/detection/tools/claude/patterns.ts")).toContain(
      "Enter EXITS Claude Code",
    );
  });

  it("the generic detectPrompt is not presented as the Auto-Yes path", () => {
    const manual = read("docs/internal/MANUAL_TESTING_GUIDE.md");
    expect(manual).not.toContain("Auto-Yes と同じ結果を見るには `stripBoxDrawing` を通す");
    expect(manual).toContain("detectPromptOnCleanFrame");
    expect(manual).toContain("汎用の `detectPrompt` の結果で代用しない");
    expect(read("src/lib/auto-yes-poller-tick.ts")).toContain(
      "detectPromptOnCleanFrame",
    );
  });

  it("fileParallelism=false is described as serialisation, not shared module state", () => {
    const guide = read("docs/internal/TESTING_GUIDE.md");
    expect(guide).not.toContain("全ファイルが 1 プロセスで順に走るので");
    expect(guide).not.toContain("後続のスイート全体の registry が壊れる");
    expect(guide).toContain("**直列化**");
    expect(guide).toContain("`isolate` は既定の `true` のまま");
    expect(read("vitest.config.ts")).not.toMatch(/isolate:\s*false/);
  });

  it("the slash palette opens on the value, so fill() opens it too", () => {
    const manual = read("docs/internal/MANUAL_TESTING_GUIDE.md");
    expect(manual).not.toContain("でしか開かない");
    expect(manual).toContain("`fill()` でも `pressSequentially` でも開く");
  });

  it("a short transition may be missed between captures, not always invisible", () => {
    const arch = read("docs/architecture.md");
    expect(arch).not.toContain("5 秒未満で始まって終わる遷移は API にも UI にも現れない");
    expect(arch).toContain("キャプチャの採取と採取の間に完結すると見逃しうる");
  });
});
