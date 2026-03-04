# Issue #410 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**: needs_improvement

Issue #410はxterm.jsとrehype-highlightのdynamic import化によるバンドルサイズ削減を提案しているが、仮説検証で判明した通り、xterm.jsが影響するルートの記載に誤りがあり、受入条件が実態と合致していない。修正後は技術的に妥当な提案となる。

---

## Must Fix（必須対応）

### MF-001: F1の記載が不正確 - xterm.jsは/worktrees/[id]の初期ロードに影響しない

**カテゴリ**: 正確性
**場所**: 背景・課題 > F1セクション

**問題**:
Issueの背景・課題セクションF1で「/worktrees/[id] の初期ロードが291KBに達している」と記載されているが、実際のコードを確認した結果:

- `Terminal.tsx` は `/worktrees/[id]/terminal/page.tsx` (L9) にのみimportされている
- メインの `/worktrees/[id]/page.tsx` は `WorktreeDetailRefactored.tsx` をimportするが、そこに `Terminal.tsx` へのimportは存在しない
- Next.jsのApp Routerルートベースコード分割により、xterm.jsは `/worktrees/[id]/terminal` 固有のチャンクとなる

**証拠**:
```
src/app/worktrees/[id]/terminal/page.tsx L9:
  import { TerminalComponent } from '@/components/Terminal';

src/app/worktrees/[id]/page.tsx L10:
  import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
  (Terminal.tsxへのimportなし)
```

**推奨対応**:
F1の記載を「/worktrees/[id]/terminal ページでxterm.jsがSSR非互換のトップレベルimportされている」と修正し、F1とF2が異なるルートの問題であることを明確にする。

---

### MF-002: 受入条件「/worktrees/[id] の初期ロードJSが200KB以下」の根拠不明

**カテゴリ**: 受け入れ条件
**場所**: 受入条件セクション 1つ目

**問題**:
xterm.js（~500KB）はメインの `/worktrees/[id]` ページのバンドルに含まれないため、この受入条件の達成はrehype-highlight/highlight.js（~100KB+）の遅延ロード化のみに依存する。現在のメインページ初期ロードサイズが291KBと仮定した場合、100KB削減しても191KB程度であり200KB以下に到達するが、291KBという数値の根拠とxterm.jsの寄与分が不明なため判断できない。

また「291KB」の測定条件（gzip前/後、First Load JS / Transfer Size等）が記載されておらず、検証再現性がない。

**推奨対応**:
受入条件を以下のように分離・修正する:
1. `/worktrees/[id]`ページ: MarkdownEditorのdynamic import化による`npm run build`出力のFirst Load JS削減量を測定し、具体的な目標値を設定
2. `/worktrees/[id]/terminal`ページ: SSRエラーが発生せず、xterm.jsがクライアントサイドのみでロードされること

---

## Should Fix（推奨対応）

### SF-001: 影響範囲にMessageList.tsxとfiles/[...path]/page.tsxが未記載

**カテゴリ**: 完全性
**場所**: 影響範囲テーブル

**問題**:
`rehype-highlight` をimportしているファイルはMarkdownEditor.tsx以外にも存在する:

| ファイル | 行 | 備考 |
|---------|-----|------|
| `src/components/worktree/MessageList.tsx` | L18 | barrel export経由で公開。現状/worktrees/[id]のレンダーツリーには含まれない |
| `src/app/worktrees/[id]/files/[...path]/page.tsx` | L14 | 別ルートだがrehype-highlightを使用 |

プロジェクト全体の一貫性のため、これらも影響範囲として認識すべき。

**推奨対応**:
影響範囲テーブルにこれらのファイルを追加し、スコープ内か外かを明記する。

---

### SF-002: 実装タスクにMarkdownEditor自体のdynamic import化が含まれていない

**カテゴリ**: 技術的妥当性
**場所**: 実装タスクセクション

**問題**:
`WorktreeDetailRefactored.tsx` (L39) が `MarkdownEditor` を静的importしているため、rehype-highlight/highlight.js CSS だけでなく、MarkdownEditor全体がメインページバンドルに含まれる。MarkdownEditorは条件付きレンダリング（マークダウンファイル選択時のみ表示）であるため、コンポーネント全体を `next/dynamic` で動的importすることが最も効果的なアプローチと考えられる。

プロジェクト内に既に同様のパターンの先例がある:

```typescript
// src/components/worktree/MermaidCodeBlock.tsx L20-30
const MermaidDiagram = dynamic(
  () => import('./MermaidDiagram').then((mod) => ({
    default: mod.MermaidDiagram,
  })),
  {
    ssr: false,
    loading: () => (/* ローディングUI */),
  }
);
```

**推奨対応**:
実装タスクに「WorktreeDetailRefactored.tsxからMarkdownEditorへのimportをnext/dynamic({ssr:false})に変更する」を追加する。

---

### SF-003: Terminal.tsxのdynamic import化の目的が不明確

**カテゴリ**: 明確性
**場所**: 提案する解決策 > 1. xterm.jsのdynamic import化

**問題**:
Terminal.tsxのdynamic import化について、「バンドルサイズ削減」と「SSR互換性確保」のどちらが主目的なのかが曖昧。xterm.jsはブラウザ専用API（DOM操作、window参照等）を使用するため、SSR時にエラーが発生する可能性があり、dynamic importの主目的はSSR互換性であるべき。Terminal.tsxは既に `'use client'` を宣言しているが、Next.js App Routerでは `use client` はSSR時のモジュール実行を防げないため、`ssr: false` が必要。

**推奨対応**:
F1の課題記述を「SSR時にxterm.jsのブラウザ専用APIが実行されエラーとなる問題」として再定義し、dynamic import化の目的をSSR互換性確保として明確化する。

---

### SF-004: テスト計画が実装タスクに含まれていない

**カテゴリ**: 完全性
**場所**: 実装タスクセクション

**問題**:
既存テストファイルが存在するが、テスト更新の計画がない:
- `tests/unit/components/MarkdownEditor.test.tsx`
- `tests/unit/components/TerminalDisplay.test.tsx`

dynamic import化により、テストでの `next/dynamic` モック設定が必要になる可能性がある。また受入条件の「遅延なくロードされること」「ハイライトが正常動作すること」の検証手順が不明。

**推奨対応**:
実装タスクに以下を追加:
1. 既存テスト（MarkdownEditor.test.tsx）の更新・動作確認
2. ローディングインジケーターの表示テスト
3. 受入条件のバンドルサイズ検証手順（`npm run build`出力確認等）

---

## Nice to Have（あれば良い）

### NTH-001: バンドルサイズの測定方法の明記

**カテゴリ**: 明確性
**場所**: Issue全体

**問題**:
「~500KB」「~100KB+」「291KB」の測定方法が不明。

**推奨対応**:
例: 「`npm run build`実行時のRoute (app)セクションのFirst Load JS列で確認」と明記する。

---

### NTH-002: highlight.js CSSの遅延ロード方法の具体化

**カテゴリ**: 技術的妥当性
**場所**: 実装タスク 2つ目

**問題**:
CSSの動的importはJSとは異なるアプローチが必要だが、`next/dynamic` でコンポーネント全体を遅延ロードすればCSS importも自動的にチャンク分離される。

**推奨対応**:
「MarkdownEditorコンポーネント全体をnext/dynamicで遅延ロードすることで、内部のrehype-highlightとhighlight.js CSSも自動的にチャンク分離される」と具体化する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/Terminal.tsx` (L9-12) | xterm.jsトップレベルimport（変更対象） |
| `src/components/worktree/MarkdownEditor.tsx` (L34-35) | rehype-highlight/highlight.js CSSトップレベルimport（変更対象） |
| `src/app/worktrees/[id]/terminal/page.tsx` (L9) | Terminal.tsxのimport元（/worktrees/[id]とは別ルート） |
| `src/app/worktrees/[id]/page.tsx` (L10) | WorktreeDetailRefactored.tsxのimport元（メインページ） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` (L39) | MarkdownEditorの静的import（バンドルに含まれる原因） |
| `src/components/worktree/MessageList.tsx` (L18) | rehype-highlightの追加消費先（Issue未記載） |
| `src/app/worktrees/[id]/files/[...path]/page.tsx` (L14) | rehype-highlightの追加消費先（Issue未記載、別ルート） |
| `src/components/worktree/MermaidCodeBlock.tsx` (L13-30) | next/dynamic + ssr:false の既存先例 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト技術スタック・コーディング規約の参照元 |

### テスト
| ファイル | 関連性 |
|---------|--------|
| `tests/unit/components/MarkdownEditor.test.tsx` | dynamic import化で影響を受ける可能性のある既存テスト |
| `tests/unit/components/TerminalDisplay.test.tsx` | Terminal関連の既存テスト |
