/**
 * The CLI / release / UI / recording lessons moved out of the tool-private memory into docs
 * (Issue #4403, third and last PR).
 *
 * Three things are pinned:
 *
 * 1. The sections and rules that received the lessons exist, so a later edit that drops one
 *    shows up here instead of silently losing the rule.
 * 2. Each moved claim that names code still agrees with that code (the memory notes were
 *    partly stale; only what the code confirms was moved).
 * 3. The receiving docs carry no private values. The repository is public; the moved text
 *    was written from notes that held home paths, account names and addresses.
 *    `findPrivateValues` is checked against temporary files first (a positive and a negative
 *    control), then run over the real docs.
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

/**
 * Values that must not appear in public docs. `yourname` / `me` (macOS) and `user` (Linux) are the
 * placeholders the docs already use for example paths (DEPLOYMENT.md), so they are allowed.
 */
const PRIVATE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "macOS home path", re: /\/Users\/(?!(?:yourname|me)\/)[A-Za-z0-9._-]+/ },
  {
    name: "Linux home path",
    re: /\/home\/(?!ubuntu\/_work\b|user\/)[a-z][A-Za-z0-9._-]*\//,
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
  "docs/user-guide/troubleshooting.md": [
    "画面が「最新バージョンに更新しています」のまま／画面の移動で壊れる？",
  ],
  "docs/en/user-guide/troubleshooting.md": [
    'The screen stays on "Updating to the latest version" / breaks when you move between screens?',
  ],
  "docs/user-guide/skills.md": ["5-1. SKILL.md の本文に `$<数字>` を書かない"],
  "docs/en/user-guide/skills.md": [
    "5-1. Do not write `$<digit>` in a SKILL.md body",
  ],
  "docs/design-system.md": [
    "hover でだけ出す操作はタッチ端末で見えない",
    "UI の帯の横スクロールにはスクロールバーを出さない",
    "Modal の背景クリック",
    "フォーカストラップ（`useFocusTrap`）",
  ],
  "docs/user-guide/demo-video.md": [
    "収録と撮影の罠",
    "画面の移動の直後は切る",
    "Playwright の録画の解像度と時刻",
    "チャット面のスクリーンショット",
    "素の TUI を 1:1 で撮る",
    "テロップの帯の被りを測る",
    "macOS の GUI を `osascript` と `screencapture` で撮る",
  ],
  "docs/orchestrate/command-code.md": ["付録 同梱バンドルから仕様を読むとき"],
};

/** Every doc this PR wrote into (headings or bullets). */
const RECEIVING_DOCS: readonly string[] = [
  ...Object.keys(SECTIONS),
  ".claude/skills/rebuild/SKILL.md",
  "docs/release-guide.md",
  "docs/en/release-guide.md",
  "docs/DEPLOYMENT.md",
  "docs/user-guide/cli-operations-guide.md",
  "docs/en/user-guide/cli-operations-guide.md",
  "docs/design/agent-skills-distribution.md",
  "CLAUDE.md",
];

describe("findPrivateValues (controls)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports a home path, the memory folder and a mail address (positive control)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-move-4403-d3-"));
    const file = path.join(dir, "leak.md");
    fs.writeFileSync(
      file,
      [
        "ok line",
        `export HOME=${HOME_ROOT}Shared/demo-home`,
        "from ~/.claude/projects/-Users-someone-work/memory",
        "the CLI header shows a.b@example.com",
      ].join("\n"),
    );
    expect(findPrivateValues([file])).toEqual([
      "leak.md:2: macOS home path",
      "leak.md:3: tool-private memory folder",
      "leak.md:4: mail address",
    ]);
  });

  it("passes placeholders, ~ paths and the public registry URLs (negative control)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-move-4403-d3-"));
    const file = path.join(dir, "clean.md");
    fs.writeFileSync(
      file,
      [
        `CM_ROOT_DIR=${HOME_ROOT}yourname/projects`,
        `CM_BROWSE_ROOTS=${HOME_ROOT}me/work,/home/user/repos`,
        "https://registry.npmjs.org/-/npm/v1/attestations/commandmate@<version>",
        "npm view commandmate@<version> dist.shasum",
        "tmux new-session -d -s <name> -c <dir> -x <cols> -y <rows> <command>",
      ].join("\n"),
    );
    expect(findPrivateValues([file])).toEqual([]);
  });
});

describe("docs after the CLI / release memory move (#4403)", () => {
  it("carries no private values in the receiving docs", () => {
    expect(
      findPrivateValues(RECEIVING_DOCS.map((f) => path.join(REPO_ROOT, f))),
    ).toEqual([]);
  });

  const cases = Object.entries(SECTIONS).flatMap(([file, headings]) =>
    headings.map((heading): [string, string] => [file, heading]),
  );

  it.each(cases)('%s has the section "%s"', (file, heading) => {
    expect(headingAnchors(read(file)).has(githubSlug(heading))).toBe(true);
  });

  it("the release guide says a cancelled publish may still have published (ja and en)", () => {
    expect(read("docs/release-guide.md")).toContain(
      "**`cancelled` / `failure` は「未公開」の証拠ではありません。**",
    );
    expect(read("docs/en/release-guide.md")).toContain(
      "**`cancelled` / `failure` is not proof that nothing was published.**",
    );
    // The workflow records the same incident; the doc rule mirrors it.
    expect(read(".github/workflows/publish.yml")).toContain(
      "a `cancelled` publish\n    # job is NOT proof that nothing was published",
    );
  });

  it("the release guide asks for the back-merge after a sync-only PR too (ja and en)", () => {
    expect(read("docs/release-guide.md")).toContain(
      "**版を上げない同期の PR でも同じことが要ります。**",
    );
    expect(read("docs/en/release-guide.md")).toContain(
      "**A sync-only PR (no version bump) needs the same.**",
    );
  });

  it("the release guide collects metrics before the worktree cleanup, which the code explains", () => {
    expect(read("docs/release-guide.md")).toContain("**worktree の掃除より先に採る。**");
    expect(read("docs/en/release-guide.md")).toContain(
      "**Collect the Vibe metrics before cleaning up worktrees.**",
    );
    expect(
      read("src/lib/db/migrations/v52-orphaned-worktree-children.ts"),
    ).toContain("getDeletableWorktreeChildTables");
  });

  it("DEPLOYMENT decides the build from the build inputs, since next.config bakes the version", () => {
    const deploy = read("docs/DEPLOYMENT.md");
    expect(deploy).toContain("**ビルドの要否はビルドの入力の差分で決めます。**");
    expect(deploy).toContain("**再起動の前に、このサーバーへつながっている待機を確かめます。**");
    expect(read("next.config.js")).toMatch(
      /NEXT_PUBLIC_APP_VERSION:\s*packageJson\.version/,
    );
  });

  it("CLAUDE.md keeps server stop/start/build out of the main reference worktree", () => {
    expect(read("CLAUDE.md")).toContain(
      "| `../commandmate-main` | `main` | main の参照用（サーバーの停止・起動・ビルドをここでしない） |",
    );
  });

  it("the contract path rule matches loadTaskContract, which joins the path onto the worktree", () => {
    expect(read("docs/user-guide/cli-operations-guide.md")).toContain(
      "`--contract` のパスは **worktree のルートからの相対パス**で渡します。",
    );
    expect(read("docs/en/user-guide/cli-operations-guide.md")).toContain(
      "Pass the `--contract` path **relative to the worktree root**.",
    );
    const parser = read("src/lib/tasks/contract-parser.ts");
    expect(parser).toContain("const absolutePath = join(worktreePath, relativePath);");
    expect(parser).toContain("contract file not found in ${worktreePath}");
  });

  it("the stale-build section names the reload guard the code has", () => {
    expect(read("docs/user-guide/troubleshooting.md")).toContain("CHUNK_RELOAD_GUARD_MS");
    expect(read("src/lib/error/chunk-reload.ts")).toMatch(
      /export const CHUNK_RELOAD_GUARD_MS = 30_000;/,
    );
  });

  it("the Modal rule matches the press-and-release check in ui/Modal", () => {
    expect(read("docs/design-system.md")).toContain(
      "**押下（`mousedown`）と離上（`mouseup`）の両方がラッパー自身に着いたときだけ閉じる。**",
    );
    const modal = read("src/components/ui/Modal.tsx");
    expect(modal).toContain("pressStartedOnBackdrop");
    expect(modal).toContain("releaseLandedOnBackdrop");
  });

  it("the palette dedup note matches keyOf and mergeCodexFamilySkills", () => {
    expect(read("docs/design/agent-skills-distribution.md")).toContain(
      "**名前と `cliTools` の組**",
    );
    expect(read("src/lib/command-merger.ts")).toContain(
      "return `${c.name}::${toolsKey}`;",
    );
    expect(read("src/lib/slash-commands.ts")).toContain(
      "export function mergeCodexFamilySkills(",
    );
  });

  it("the bundle-reading note points at the matcher rule the hooks config documents", () => {
    expect(read("docs/orchestrate/command-code.md")).toContain(
      "src/lib/hooks/sources/command-code/hooks-config.ts",
    );
    expect(read("src/lib/hooks/sources/command-code/hooks-config.ts")).toContain(
      '`matcher` must be the EMPTY STRING, and `"*"` silently kills two events',
    );
  });
});

/** The moved text, as corrected by the review: each claim matches the code it names. */
describe("the moved text agrees with the code (#4403 third PR review)", () => {
  it("publish waits for main's CI instead of running the tests itself (ja and en)", () => {
    const ja = read("docs/release-guide.md");
    const en = read("docs/en/release-guide.md");
    expect(ja).not.toContain("公開の前にテスト全体を 1 本で走らせる");
    expect(en).not.toContain("It runs the whole test suite in one job before publishing");
    expect(ja).toContain("`Require CI to have passed on the tag commit`（`scripts/check-release-ci.mjs`）");
    expect(en).toContain("`Require CI to have passed on the tag commit` (`scripts/check-release-ci.mjs`)");
    const workflow = read(".github/workflows/publish.yml");
    expect(workflow).toContain("- name: Require CI to have passed on the tag commit");
    expect(workflow).toContain("--timeout-minutes 45");
    expect(workflow).not.toMatch(/run: npm run test:unit/);
  });

  it("the rebuild skill decides the build from the build inputs, like DEPLOYMENT.md", () => {
    const skill = read(".claude/skills/rebuild/SKILL.md");
    expect(skill).not.toContain("| `.env` / 設定だけ変えた |");
    expect(skill).toContain("**ビルドは「ビルドの入力が変わったとき」だけ必要です。**");
    expect(skill).toContain("`NEXT_PUBLIC_APP_VERSION` としてバンドルへ焼き込む");
    const deploy = read("docs/DEPLOYMENT.md");
    expect(deploy).not.toContain("| `.env` / 設定を変えた、");
    expect(deploy).toContain("| `.env` だけ変えた（ビルドの入力は変えていない）、クラッシュから復帰したい |");
  });

  it("a dialog is drawn while the prompt is still waiting, not only on pages open at the time", () => {
    const demo = read("docs/user-guide/demo-video.md");
    expect(demo).not.toContain("そのプロンプトが出た時点で開いていたページ");
    expect(demo).toContain("**そのプロンプトがまだ待機中**");
    // A page opened later reads current-output in its initial fetch.
    expect(read("src/hooks/useWorktreeDetailController.ts")).toContain("fetchCurrentOutput(),");
  });

  it("the stale-build section keeps the connection as a cause to rule out first (ja and en)", () => {
    const ja = read("docs/user-guide/troubleshooting.md");
    const en = read("docs/en/user-guide/troubleshooting.md");
    expect(ja).not.toContain("ディスク上の `.next` が食い違うと起きます。");
    expect(en).not.toContain("This happens when the build the running server loaded at start-up");
    expect(ja).toContain("まず**通信の状態**を切り分けます");
    expect(en).toContain("first rule out **the connection**");
    expect(read("src/lib/error/chunk-reload.ts")).toContain("return onLine ? 'build' : 'network';");
  });
});

describe("the build-input rule names every build's inputs (#4403 third PR re-review)", () => {
  const RULE =
    "`next build`（`npm run build`）・`build:cli`・`build:server` の入力が前のビルド（`.next/BUILD_ID`・`dist/server/`・`dist/cli/`）より新しければビルドする。";

  it("the rebuild skill and DEPLOYMENT.md state the same rule, including server.ts", () => {
    for (const rel of [".claude/skills/rebuild/SKILL.md", "docs/DEPLOYMENT.md"]) {
      const doc = read(rel);
      expect(doc).toContain(RULE);
      expect(doc).toContain("ルートの `server.ts`");
      expect(doc).not.toContain("`tsconfig*.json` のどれかが `.next/BUILD_ID` より新しければ");
    }
    expect(read("docs/DEPLOYMENT.md")).not.toContain(
      "`package.json` / `next.config.*` / `tsconfig*.json` / `locales/` / `public/` / `src/` のどれかが `.next/BUILD_ID` より新しければビルドする",
    );
  });

  it("server.ts is a build:server input that npm start runs from dist/server", () => {
    // tsconfig.server.json carries comments, so it is matched as text rather than parsed.
    expect(read("tsconfig.server.json")).toMatch(/"include":\s*\[\s*"server\.ts",/);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:server"]).toContain("tsconfig.server.json");
    expect(pkg.scripts.start).toContain("dist/server/server.js");
  });
});
