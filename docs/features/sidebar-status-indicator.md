[English](../en/features/sidebar-status-indicator.md)

# サイドバー ステータスインジケーター

> Issue #31「サイドバーのUX改善」で実装されたリアルタイムステータス検出機能

## 概要

サイドバーの各ブランチにリアルタイムでClaude CLIのステータスを表示する機能です。
ターミナル出力を直接解析し、Claudeの状態（入力待ち・処理中・回答待ち）を正確に検出します。

## ステータス一覧

**サイドバー / Home / Sessions** の表示は共通プリミティブ `StatusDot`
（`src/components/ui/StatusDot.tsx`, Issue #1051）が担う。
`running` / `generating` は発光ドット + ゆっくりしたパルス（+ モーション凍結時も残る
リングで `ready` と区別）、`waiting` は **amber の強いアテンションパルス + amber リング**
（Issue #1787）、その他は静的ドット。

> **Issue #1787 で解消した逆転**: 以前の `waiting` は opacity 1→0.45 だけの弱い点滅
> （`animate-status-blink`）で、放置してよい `running` の発光より目立たなかった。
> 「要対応」が最も目立つよう `animate-status-attention`（1.4s・box-shadow 12px/4px）へ
> 置き換え、`animate-status-blink` は他に利用箇所が無かったため削除した。

下表は **StatusDot（サイドバー / Home / Sessions）** の表示を示す。

| ステータス | 表示 | 色 | 説明 |
|-----------|------|-----|------|
| `idle` | ● | グレー | セッション未起動 |
| `ready` | ● | 緑 | 入力プロンプト表示中（新しいメッセージ入力可能） |
| `running` | ● 発光・パルス（リング） | 緑グロー | Claude処理中（思考インジケータ表示中） |
| `waiting`（`waitingKind='prompt'` / 不明） | ● 強アテンションパルス（`ring-4`） | amber グロー | アプリから答えられる入力待ち（yes/no・番号選択など） |
| `waiting`（`waitingKind='menu'` / `'unclassified'`） | ● パルス（`ring-2`） | amber グロー | 端末操作が必要な待ち（選択リスト・pager など） |
| `generating` | ● 発光・パルス（リング） | 緑グロー | レスポンス生成中 |

### `waitingKind` による強弱（Issue #1786 / #1787）

`waitingKind`（`'prompt'｜'menu'｜'unclassified'｜null`）は #1786 が
`sessionStatusByCli` / `sessionStatusByInstance` に載せる。UI 側は
`deriveWorktreeWaitingDetail()`（`src/types/sidebar.ts`）で worktree 単位に畳み
（`prompt > menu > unclassified` の優先度・`awaitingInstruction` は OR）、
`StatusDot` の `waitingKind` prop に渡す。

- **`prompt`**: 今すぐアプリから答えられる → 最強調（`animate-status-attention` + `ring-4`）
- **`menu` / `unclassified`**: 端末を触る必要がある → 中強調（`animate-status-glow` + `ring-2`）
- **フィールド欠落 / null**（#1786 以前のサーバ応答）: **一律で最強調にフォールバック**する。
  「人間が要る」状態の安全側は過剰強調であって過小強調ではない

> **モーション**: パルスは CSS の infinite アニメーション（`animate-status-glow` /
> `animate-status-attention`, `globals.css` の `@theme`）で実装し、ポーリング再描画でリセットされない。
> OS の「視差効果を減らす」設定時は `globals.css`（Issue #1050）が全アニメを無効化し、
> 静的ドットへフォールバックする。このとき `running` は緑リング、**`waiting` は amber リング**
> （Issue #1787。以前は無地 amber に退化していた）で `ready` と識別できる。

### 入力待ちの優先ソートと次アクション（Issue #1787）

- **二段ソート**: `sortBranches()`（`src/lib/sidebar-utils.ts`）が `waiting` のブランチを
  先頭グループへ固定し、グループ内は選択中のソート順（既定 `updatedAt`）を維持する。
  判定は集約ステータス（`isWaitingBranch()` → `aggregateCliStatus`）なので、alias インスタンス
  だけが待っているブランチも浮上する。**「ステータス」ソート選択時は前段を掛けない**
  （`STATUS_PRIORITY` が既に `waiting` を先頭に置いており、降順＝「idle を先に」が
  表現できなくなるため）。グループ表示ではリポジトリ単位のグルーピングを保ったまま
  各グループ内で適用する
- **次アクション**: `getNextAction()`（`src/lib/session/next-action-helper.ts`）は
  辞書キー（`nextAction.*`）を返す。サイドバー行では `waiting` と `awaitingInstruction` の
  ときだけ**インライン表示**し（hover 限定はタッチ端末で永久に不可視になるため）、
  それ以外はツールチップにのみ出す。`WorktreeCard` は `isNextActionKey()` で
  キーと判定できた場合のみ翻訳し、旧サーバが送る英語リテラルはそのまま描画する
- **`awaitingInstruction`**: タスク完了・次の指示待ちは amber ではなく**緑バッジ**
  （`awaitingInstruction.badge`）でサイドバー行と `WorktreeCard` に出す。
  「待たせている」と「待っている」を色で取り違えさせない

### 表示の適用範囲（Issue #1078 で統一済み）

Issue #1051 の StatusDot 化は当初 **サイドバー / Home / Sessions のみ**で、worktree詳細と
`MobileHeader` は独自の色設定（青スピナー / `bg-yellow-500`）のまま併存していた。
Issue #1078 で両者とも `<StatusDot>` へ移行し、この不整合は解消済み。

`src/config/status-colors.ts` に残るのは以下の2つ:

| export | 用途 |
|--------|------|
| `SIDEBAR_STATUS_CONFIG` | `ReviewTab` / Sessions のエージェント status dot（色・dot/spinner・`labelKey`） |
| `DESKTOP_STATUS_LABEL_KEYS` | worktree詳細 DesktopHeader の長文ラベル（`worktree.detailStatus.*`）のみ |

- **ラベルは辞書キー**: モジュールスコープでは `t()` を呼べないため、config はキーだけを持ち
  描画側が解決する（Issue #1271 / #1304）。汎用6語は `common.status.*`（Issue #1273）を再利用する。
- **`waiting` の色**: `src/components/Terminal.tsx` の `bg-yellow-500`（接続中ドット）は
  Issue #1787 でトークン `bg-warning` へ統一済み（`MobileTabBar.tsx` も解消済み）。
  同ファイルに残る `bg-amber-500` / `bg-green-500` / `bg-red-500`（disabled / connected /
  disconnected の接続ステータス）は**ターミナル面の常時ダーク島**として現状維持で、
  CI の Token discipline も `*Terminal*` を除外している。

## ブランチ左の集約ステータスアイコン（Issue #867）

サイドバーの各ブランチ左には、選択中エージェントごとのステータスを**1つのアイコンに集約**して表示します（以前は最大5個のドットを並べて描画していました）。

### 集約ロジック

`aggregateCliStatus(cliStatus)`（`src/types/sidebar.ts`）が、各エージェントのステータスから最も重要な1つを選びます。優先度は以下の通りです（ソート用の `STATUS_PRIORITY` とは別物）。

```
waiting > running / generating > ready > idle
```

- いずれかのエージェントが `waiting` なら `waiting`（amber ドット・アテンションパルス）。
- `waiting` がなく `running` または `generating` があれば発光ドット（`running` を優先）。
- 上記がなく `ready` があれば `ready`（緑ドット）。
- それ以外は `idle`（グレードット）。

### エージェント別内訳の表示

集約後も各エージェントのステータスは失われません。アイコンの `title` / `aria-label` に
`formatCliStatusBreakdown(cliStatus)` が生成する内訳（例: `Claude: running, Codex: idle`）を設定し、
ホバー／フォーカスで確認できます。

> ソート（`STATUS_PRIORITY`、`waiting` 優先）はブランチ単位の `status` を基準としており、
> この集約アイコンの導入によって既存のソート挙動は変わりません。
> **Issue #1787 の二段ソート**（`waiting` 先頭固定）だけは集約ステータスを見るので、
> alias インスタンスだけが待っているブランチもドットと同じ基準で浮上します。

## 検出ロジック

### 思考インジケータの検出

Claudeが処理中の場合、以下のパターンがターミナルに表示されます：

```
✻ Philosophising… (ctrl+c to interrupt · thinking)
· Contemplating… (ctrl+c to interrupt)
✽ Wibbling… (ctrl+c to interrupt · thought for 1s)
```

検出パターン（正規表現）:
```typescript
const CLAUDE_SPINNER_CHARS = [
  '✻', '✽', '⏺', '·', '∴', '✢', '✳', '✶',
  '⦿', '◉', '●', '○', '◌', '◎', '⊙', '⊚',
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
];

const CLAUDE_THINKING_PATTERN = new RegExp(
  `[${CLAUDE_SPINNER_CHARS.join('')}]\\s+.+…|to interrupt\\)`,
  'm'
);
```

### 入力プロンプトの検出

Claudeが新しいメッセージを受け付ける状態の場合：

```
❯
```

または、推奨コマンドがプリセットされている場合：

```
❯ /work-plan
```

検出パターン:
```typescript
// Issue #132: 空のプロンプト行と推奨コマンド付きプロンプト行の両方をマッチ
const CLAUDE_PROMPT_PATTERN = /^[>❯](\s*$|\s+\S)/m;
```

このパターンは以下のケースにマッチします：
- 空のプロンプト: `❯ ` または `> `
- 推奨コマンド付きプロンプト: `❯ /work-plan` または `> npm install`

### インタラクティブプロンプトの検出

yes/no確認や選択肢を表示している場合：

```
? Do you want to proceed? (y/N)
? Select an option:
  1. Option A
  2. Option B
```

## 検出優先順位

1. **インタラクティブプロンプト** → `waiting` (黄・弱点滅)
2. **思考インジケータ** → `running` (緑・発光パルス)
3. **入力プロンプトのみ** → `ready` (緑)
4. **それ以外** → `running` (緑・発光パルス) - 処理中と推定

## ポーリング間隔

| 対象 | 間隔 |
|------|------|
| サイドバーステータス更新 | 2秒 |
| Worktree詳細（アクティブ時） | 2秒 |
| Worktree詳細（アイドル時） | 5秒 |

## 実装ファイル

### 設定
- `src/config/status-colors.ts` - ステータス色の一元管理

### 検出ロジック
- `src/lib/cli-patterns.ts` - CLIツール別のパターン定義
- `src/lib/prompt-detector.ts` - プロンプト検出ロジック

### API
- `src/app/api/worktrees/route.ts` - ワークツリー一覧のステータス取得
- `src/app/api/worktrees/[id]/route.ts` - 個別ワークツリーのステータス取得
- `src/app/api/worktrees/[id]/current-output/route.ts` - リアルタイム出力取得

### フロントエンド
- `src/components/ui/StatusDot.tsx` - 共通ステータスドット（発光・パルス・点滅、Issue #1051）
- `src/components/sidebar/BranchStatusIndicator.tsx` - StatusDot を用いたインジケーター
- `src/types/sidebar.ts` - ステータス判定ロジック
- `src/contexts/WorktreeSelectionContext.tsx` - ポーリング管理

## CLIツール別対応

| CLIツール | 思考パターン | プロンプトパターン |
|-----------|-------------|-------------------|
| Claude | `✻ Thinking…` | `❯` |

## 注意事項

- 空行はフィルタリングしてからパターンマッチングを行う
- ターミナルの最後15行（空行除く）を検査対象とする
- ANSIエスケープコードは除去してから検出
