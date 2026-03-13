# Issue #166 レビューレポート

**レビュー日**: 2026-03-14
**フォーカス**: 通常レビュー
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 2 |

Issue #166は機能の方向性としては妥当だが、実装に着手する前に解決すべき問題が複数ある。最も重要なのは、(1) 背景説明の事実誤認の修正、(2) ホームディレクトリアクセスに対するセキュリティ設計の追加、(3) 非推奨Custom Promptsの対応方針の明確化である。

---

## Must Fix（必須対応）

### MF-1: 背景の「.claude/commands/*.mdのみ対応」は事実と異なる

**カテゴリ**: 正確性
**場所**: Issue本文 - 背景セクション

**問題**:
Issue本文の背景セクションに「スラッシュコマンドの読込は現在Claude Code用（`.claude/commands/*.md`）のみ対応している」と記載されているが、Issue #343で`.claude/skills/{name}/SKILL.md`の読込が既に実装済みである。`loadSkills()`関数が`slash-commands.ts`に存在し、`getSlashCommandGroups()`でcommands + skillsをマージしている。

**証拠**:
- `src/lib/slash-commands.ts:256-291` - `loadSkills()`関数
- `src/lib/slash-commands.ts:331-350` - `getSlashCommandGroups()`でskillsとcommandをマージ

**推奨対応**:
「現在Claude Code用（`.claude/commands/*.md`および`.claude/skills/`）のみ対応している」に修正する。Codex固有のディレクトリ構造（`~/.codex/prompts/`, `.codex/skills/`）には未対応であることを明確に記述する。

---

### MF-2: SlashCommandSource型への新値追加タスクが欠落

**カテゴリ**: 完全性
**場所**: Issue本文 - 実装タスクセクション

**問題**:
現在の`SlashCommandSource`は`'standard' | 'mcbd' | 'worktree' | 'skill'`の4種類。Codex固有のコマンドソースを識別するために`'codex-prompt'`や`'codex-skill'`等の新しいsource値が必要だが、実装タスクに型定義の拡張が含まれていない。sourceの区別がないとUIでのグループ表示やフィルタリングが不正確になる。

**証拠**:
- `src/types/slash-commands.ts:31` - `SlashCommandSource`型定義

**推奨対応**:
実装タスクに「`SlashCommandSource`型にCodex固有のソース種別を追加」を追加する。例：`'codex-prompt' | 'codex-skill'`。また、`SlashCommandCategory`への新カテゴリ追加要否も検討する。

---

### MF-3: ホームディレクトリ（~/）アクセスのセキュリティ設計が未記載

**カテゴリ**: セキュリティ
**場所**: Issue本文全体

**問題**:
`~/.codex/prompts/`の読込はホームディレクトリへのアクセスを伴う。既存の`path-validator.ts`はworktreeルートを基準としたパス検証を行うが、ホームディレクトリのファイル読込は異なるセキュリティコンテキストとなる。パストラバーサル防御、symlinkによるエスケープ防御、ファイルサイズ制限、ファイル数制限などのセキュリティ考慮が記述されていない。

**証拠**:
- `src/lib/security/path-validator.ts` - 既存のパス検証はworktreeルート基準
- `src/lib/slash-commands.ts:266-279` - `loadSkills()`にはパストラバーサル防御とファイルサイズ制限が実装済み

**推奨対応**:
実装タスクに以下のセキュリティ要件を追加する：
1. `~/.codex/`配下のパストラバーサル防御（`..`を含むパスの拒否）
2. symlinkによるディレクトリ外エスケープの検出
3. ファイルサイズ上限（既存の`MAX_SKILL_FILE_SIZE_BYTES=64KB`に倣う）
4. ファイル数上限（既存の`MAX_SKILLS_COUNT=100`に倣う）
5. `safeParseFrontmatter()`によるJSエンジン無効化の適用

---

## Should Fix（推奨対応）

### SF-1: 非推奨のCustom Prompts対応方針が不明確

**カテゴリ**: 明確性
**場所**: Issue本文 - 実装タスク / カスタムコマンド仕様セクション

**問題**:
Issue本文でCustom Prompts（`~/.codex/prompts/`）が「非推奨だが動作する」「非推奨（deprecated）、Skillsへの移行が推奨」と記載されているにもかかわらず、実装タスクには「`~/.codex/prompts/*.md`からのコマンド読込」が含まれている。非推奨機能の実装は技術的負債を生む可能性があり、対応方針の判断と根拠が明示されていない。

**推奨対応**:
以下のいずれかの方針を明記する：
- (A) 非推奨だが既存ユーザーの互換性のため実装する（スコープに含める）
- (B) Skillsのみ対応し、Custom Promptsは対象外とする（スコープから除外）
- (C) Phase 1でSkills、Phase 2でCustom Promptsと段階的に対応する

---

### SF-2: filterCommandsByCliTool()との統合方法が未定義

**カテゴリ**: 明確性
**場所**: Issue本文 - 実装タスクセクション

**問題**:
「Codexタブ選択時にこれらのコマンドを候補に表示」という要件があるが、既存の`filterCommandsByCliTool()`では、`cliTools`が未定義のコマンドはClaude専用として扱われる（`cliToolId === 'claude'`のときのみ表示）。Codex固有コマンドに`cliTools: ['codex']`を設定する必要があるが、その方針が記述されていない。

**証拠**:
- `src/lib/command-merger.ts:191-193` - `cliTools`がundefinedなら`cliToolId === 'claude'`のときのみ表示
- `src/lib/slash-commands.ts:126-129` - D009コメント（Skillsは現在cliTools未設定で全ツール表示）

**推奨対応**:
実装タスクに「Codex固有コマンドのcliTools設定方針」を追加する：
1. `~/.codex/prompts/`から読み込んだコマンドには`cliTools: ['codex']`を自動設定
2. `.codex/skills/`から読み込んだスキルにも`cliTools: ['codex']`を自動設定
3. `filterCommandsByCliTool()`による既存のフィルタリング機構で自動的にCodexタブのみに表示される設計を記述

---

### SF-3: グローバル（~/）とローカル（.codex/）の読み込みスコープ設計が未定義

**カテゴリ**: 設計
**場所**: Issue本文全体

**問題**:
`~/.codex/prompts/`はグローバル（ユーザー共通）、`.codex/skills/`はリポジトリローカルであるが、これらをどのスコープで読み込むかの設計が記述されていない。既存の`loadSlashCommands()`と`loadSkills()`は`basePath`引数でworktree別の読み込みを制御しているが、グローバルコマンドの読み込みタイミング、キャッシュ戦略、重複時の優先度が未定義。

**推奨対応**:
以下の設計方針を明記する：
1. `~/.codex/prompts/`はグローバルキャッシュとして1回読み込み（`commandsCache`に倣う）
2. `.codex/skills/`はworktreeの`basePath`指定で読み込み
3. 同名コマンドの優先度（ローカル > グローバル、既存の`deduplicateByName()`に倣う）
4. キャッシュのクリアタイミング

---

### SF-4: 受け入れ条件（Acceptance Criteria）が未定義

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
Issue本文に実装タスクのチェックリストはあるが、受け入れ条件が定義されていない。各タスクの完了基準や動作確認方法が不明確であり、テスト計画も記載されていない。

**推奨対応**:
以下の受け入れ条件を追加する：
1. `~/.codex/prompts/`に配置した`.md`ファイルがCodexタブで表示されること
2. `.codex/skills/`の`SKILL.md`がCodexタブで表示されること
3. Claudeタブでは表示されないこと（cliToolsフィルタリング）
4. 存在しないディレクトリの場合にエラーが発生しないこと
5. パストラバーサル攻撃を防御できること
6. テスト計画（unit test対象の関数一覧）

---

### SF-5: SKILL.md形式パースの仕様詳細が不足

**カテゴリ**: 完全性
**場所**: Issue本文 - Codexのカスタムコマンド仕様 - Skills

**問題**:
「SkillsのSKILL.md形式パース」とあるが、Codexの`.codex/skills/`配下のSKILL.md形式が`.claude/skills/`のSKILL.md形式と同一かどうかが明示されていない。フロントマターのフィールド、ディレクトリ構造の仕様が不明確。

**推奨対応**:
Codex公式ドキュメントに基づいて`.codex/skills/`のディレクトリ構造とSKILL.mdの形式仕様を明記する。既存の`parseSkillFile()`を共通化できるか、Codex固有のパーサーが必要かの判断材料を提供する。

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issue #343へのリンクが不足

**カテゴリ**: 完全性
**場所**: Issue本文 - 関連Issue

**問題**:
Issue #343（`.claude/skills/`対応）は直接関連する先行Issueだが、関連Issueセクションに記載されていない。

**推奨対応**:
関連Issueに「#343 .claude/skills/対応（設計参考）」を追加する。

---

### NTH-2: 既存のコマンド表示UIへの影響が未記載

**カテゴリ**: 完全性
**場所**: Issue本文 - 実装タスクセクション

**問題**:
Codex固有コマンドの追加により、SlashCommandSelectorコンポーネントやuseSlashCommandsフックへの影響が想定されるが、UI側の変更箇所への言及がない。

**推奨対応**:
影響を受けるUIコンポーネントを実装タスクに追加するか、影響範囲レビュー（Stage 2）で詳細化する旨を記載する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/slash-commands.ts` | 既存のコマンド・スキル読込ロジック。Codex対応の拡張対象 |
| `src/types/slash-commands.ts` | SlashCommandSource, SlashCommandCategory型定義の拡張が必要 |
| `src/lib/command-merger.ts` | filterCommandsByCliTool()によるCLIツール別フィルタリング |
| `src/lib/cli-tools/types.ts` | CLIToolType定義。'codex'が既に含まれている |
| `src/lib/security/path-validator.ts` | パス検証ユーティリティ。セキュリティ設計の参考 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成・モジュール一覧の参照 |
