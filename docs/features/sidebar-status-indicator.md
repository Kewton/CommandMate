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
リングで `ready` と区別）、`waiting` は amber の弱い点滅、その他は静的ドット。

下表は **StatusDot（サイドバー / Home / Sessions）** の表示を示す。

| ステータス | 表示 | 色 | 説明 |
|-----------|------|-----|------|
| `idle` | ● | グレー | セッション未起動 |
| `ready` | ● | 緑 | 入力プロンプト表示中（新しいメッセージ入力可能） |
| `running` | ● 発光・パルス（リング） | 緑グロー | Claude処理中（思考インジケータ表示中） |
| `waiting` | ● 弱点滅 | amber | ユーザー入力待ち（yes/no、選択肢など） |
| `generating` | ● 発光・パルス（リング） | 緑グロー | レスポンス生成中 |

> **モーション**: パルス／点滅は CSS の infinite アニメーション（`animate-status-glow` /
> `animate-status-blink`, `globals.css` の `@theme`）で実装し、ポーリング再描画でリセットされない。
> OS の「視差効果を減らす」設定時は `globals.css`（Issue #1050）が全アニメを無効化し、
> 静的ドットへフォールバックする（このとき `running` はリングで `ready` と識別できる）。

### 表示の適用範囲と既知の不整合（Issue #1051 時点）

Issue #1051 の StatusDot 化は **サイドバー / Home / Sessions のみ**。以下は今回移行しておらず、
**従来の `src/config/status-colors.ts`（`MOBILE_STATUS_CONFIG` / `DESKTOP_STATUS_CONFIG`）** のままで、
今後の追随対象。全面的な表示統一はまだ達成していない点に注意。

| 箇所 | `running` / `generating` | `waiting` |
|------|--------------------------|-----------|
| サイドバー / Home / Sessions（StatusDot） | 緑グロー + パルス（発光ドット） | amber（`bg-warning`）・弱点滅 |
| worktree詳細（`WorktreeDetailRefactored` 等）・`MobileHeader` | 青スピナー（`border-info`, `animate-spin`） | 黄（`bg-yellow-500`）・静的 |

- **`running` の色/表現差**: StatusDot 側は緑の発光ドット、worktree詳細/MobileHeader 側は青スピナーのまま。
- **`waiting` の色差**: StatusDot は amber（`bg-warning`）、worktree詳細/MobileHeader は `bg-yellow-500`。
  さらに `Terminal.tsx` / `MobileTabBar.tsx` は `bg-yellow-500` をハードコードしている。
  完全統一には `status-colors.ts` とこれらのハードコード双方の変更が必要なため、追随作業まで保留。

## ブランチ左の集約ステータスアイコン（Issue #867）

サイドバーの各ブランチ左には、選択中エージェントごとのステータスを**1つのアイコンに集約**して表示します（以前は最大5個のドットを並べて描画していました）。

### 集約ロジック

`aggregateCliStatus(cliStatus)`（`src/types/sidebar.ts`）が、各エージェントのステータスから最も重要な1つを選びます。優先度は以下の通りです（ソート用の `STATUS_PRIORITY` とは別物）。

```
waiting > running / generating > ready > idle
```

- いずれかのエージェントが `waiting` なら `waiting`（amber ドット・弱点滅）。
- `waiting` がなく `running` または `generating` があれば発光ドット（`running` を優先）。
- 上記がなく `ready` があれば `ready`（緑ドット）。
- それ以外は `idle`（グレードット）。

### エージェント別内訳の表示

集約後も各エージェントのステータスは失われません。アイコンの `title` / `aria-label` に
`formatCliStatusBreakdown(cliStatus)` が生成する内訳（例: `Claude: running, Codex: idle`）を設定し、
ホバー／フォーカスで確認できます。

> ソート（`STATUS_PRIORITY`、`waiting` 優先）はブランチ単位の `status` を基準としており、
> この集約アイコンの導入によって既存のソート挙動は変わりません。

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
