[English](../en/features/sidebar-status-indicator.md)

# サイドバー ステータスインジケーター

> Issue #31「サイドバーのUX改善」で実装されたリアルタイムステータス検出機能

## 概要

サイドバーの各ブランチにリアルタイムでClaude CLIのステータスを表示する機能です。
ターミナル出力を直接解析し、Claudeの状態（入力待ち・処理中・回答待ち）を正確に検出します。

## ステータス一覧

| ステータス | 表示 | 色 | 説明 |
|-----------|------|-----|------|
| `idle` | ● | グレー | セッション未起動 |
| `ready` | ● | 緑 | 入力プロンプト表示中（新しいメッセージ入力可能） |
| `running` | ⟳ | 青スピナー | Claude処理中（思考インジケータ表示中） |
| `waiting` | ● | 黄 | ユーザー入力待ち（yes/no、選択肢など） |
| `generating` | ⟳ | 青スピナー | レスポンス生成中 |

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

1. **インタラクティブプロンプト** → `waiting` (黄)
2. **思考インジケータ** → `running` (スピナー)
3. **入力プロンプトのみ** → `ready` (緑)
4. **それ以外** → `running` (スピナー) - 処理中と推定

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
- `src/components/sidebar/BranchStatusIndicator.tsx` - ステータスインジケーターコンポーネント
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
