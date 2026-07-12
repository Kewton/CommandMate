# デザインシステム（セマンティックトークン）

CommandMate の色は **CSS 変数（セマンティックトークン）** で一元管理する。
Tailwind からは `bg-background` / `bg-surface` / `text-accent-500` のようなセマンティック
クラスで参照し、`gray-*` / `cyan-*` / `blue-*` の直書きは原則禁止とする。

- トークン定義: [`src/app/globals.css`](../src/app/globals.css)（`:root` = ライト、`.dark` = ダーク）
- Tailwind への登録: [`tailwind.config.js`](../tailwind.config.js) の `theme.extend.colors`
- 初出: Issue #1041（基盤導入。既存コンポーネントの一括置換は #1045 で実施）

> このトークン基盤の導入では **見た目を変えない**。各トークンの値は現行 Tailwind シェードの
> 実効値を写し取っている（例: `--background`(light) = `gray-50`）。

## トークン一覧

値は `rgb(...)` 合成のため **RGB チャンネル値（スペース区切り）** で定義する。
末尾に対応する現行 Tailwind シェードを併記する。

| トークン | ライト（`:root`） | ダーク（`.dark`） | 用途 |
|---------|------------------|------------------|------|
| `--background` | gray-50 | `#0f1117`（旧 `cmd-bg-dark`） | ページ背景 |
| `--foreground` | gray-900 | gray-100 | 基本文字色 |
| `--surface` | white | gray-800 | カード・パネル背景 |
| `--surface-foreground` | gray-900 | gray-100 | サーフェス上の文字色 |
| `--surface-2` | gray-50 | gray-900 | 一段深いサーフェス |
| `--muted` | gray-100 | gray-800 | 補助背景 |
| `--muted-foreground` | gray-500 | gray-400 | 補助文字 |
| `--border` | gray-200 | gray-700 | 境界線 |
| `--input` | gray-300 | gray-600 | フォーム枠 |
| `--ring` | cyan-500 | cyan-500 | フォーカスリング |
| `--accent-50`〜`--accent-700` | cyan-50〜700 | cyan-50〜700 | アクセント（cyan スケール） |
| `--success` | green-500 | green-500 | 成功 |
| `--warning` | amber-500 | amber-500 | 警告 |
| `--danger` | red-500 | red-500 | エラー・破壊的操作 |
| `--info` | blue-500 | blue-500 | 情報 |

`--accent-*` と `--success` / `--warning` / `--danger` / `--info` はライト・ダークで同値だが、
将来のモード別調整を容易にするため両ブロックに明示的に定義している。

## Tailwind クラス対応

| CSS 変数 | Tailwind クラス例 |
|---------|------------------|
| `--background` | `bg-background` |
| `--foreground` | `text-foreground` |
| `--surface` / `--surface-foreground` / `--surface-2` | `bg-surface` / `text-surface-foreground` / `bg-surface-2` |
| `--muted` / `--muted-foreground` | `bg-muted` / `text-muted-foreground` |
| `--border` | `border-border` |
| `--input` | `border-input` |
| `--ring` | `ring-ring` / `focus:ring-ring` |
| `--accent-500` | `bg-accent-500` / `text-accent-500` |
| `--success` / `--warning` / `--danger` / `--info` | `text-success` / `bg-danger` など |

各色は `rgb(var(--token) / <alpha-value>)` 形式で登録しているため、
`bg-surface/80` のように **透過度指定** がそのまま使える。

## 使用ルール

1. **新規・変更するスタイルはセマンティックトークン経由で指定する**
   （`bg-white dark:bg-gray-800` ではなく `bg-surface`）。
2. トークンはライト/ダーク両モードで自動的に切り替わるため、**`dark:` バリアントは原則不要**。
3. 新しい意味的な色が必要になったら、直書きを増やさず **まずトークンを追加** する。

## 直書き色の禁止と例外

`gray-*` / `cyan-*` / `blue-*` 等の **直書きカラークラスは原則禁止**。以下は例外として許容する。

- **モードに依存しない固定色**: ブランド固定のシンタックスハイライト（`.prose pre` の
  `#0d1117` 等）、ターミナル配色、`::highlight()` 検索ハイライト。
- **意味的にトークン化されていない一過性の装飾**: 追加のトークン化が過剰と判断できる箇所。
  この場合もライト/ダーク両対応を保つこと。
- **サードパーティ由来のクラス**: xterm.js / highlight.js 等が要求する固定クラス。

例外を用いる場合は、その色がなぜトークン化に馴染まないかを PR で説明すること。
