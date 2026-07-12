# Design System

CommandMate の UI デザイン基盤に関する規約をまとめる。

---

## アイコン (Icons)

### ライブラリ

- UI アイコンは **[lucide-react](https://lucide.dev/)** に統一する。
- 絵文字リテラル(🤖 / ⚡ / ✦ / 💻 / ⭐ / ✨ など)を **UI 表示に使用しない**。
  絵文字は OS・ブラウザで見た目が変わり、モダンな UI トーンを崩すため。
  - 例外: ターミナルストリーム出力(xterm.js に書き込むテキスト)や CLI 出力・
    ログ・検出パターン(`src/lib/detection/**`)は対象外。これらは表示 UI ではなく
    テキストコンテンツのため。

### サイズ規約

アイコンサイズは以下の 3 段階に統一する(`size` prop または `w-*/h-*`)。

| サイズ | 用途 |
|--------|------|
| **16px** | テキストインライン、密度の高いリスト・バッジ内 |
| **20px** | ナビゲーション・ツールバー・タブ(標準) |
| **24px** | 見出し・強調・モーダルヘッダ |

### strokeWidth

- `strokeWidth` は **2**(lucide-react のデフォルト)を基準とする。
- 現行デザインの見た目に合わせて個別調整する場合を除き、変更しない。

### 色

- アイコンの色は原則 `currentColor` を継承させ、親要素のテキスト色
  (セマンティックトークン経由、ライト/ダーク両対応)で制御する。
- ブランド固有色(CLI ツールの claude/codex/gemini 等)は個別指定を許容する。

### アクセシビリティ

- 装飾目的のアイコンには `aria-hidden="true"` を付与し、隣接するテキストラベルや
  `aria-label` を主たるアクセシブルネームとする。
- アイコン単独ボタンには必ず `aria-label` を付与する。

### 実装例

```tsx
import { Bot } from 'lucide-react';

// ナビ・ツールバー(20px 標準)
<Bot size={20} aria-hidden="true" />

// テキストインライン(16px)
<Star size={16} className="inline align-[-2px] mr-1" aria-hidden="true" />
```
