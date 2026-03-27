# Issue #549 レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

Issue #549は6回のレビュー・更新ステージを経て、影響範囲分析の品質が大幅に向上しています。SSR hydration対策、localStorage競合、WorktreeDetailRefactored.tsxのinitialViewMode問題、テスト要件の全てが適切に記述されています。残存する指摘は軽微なものに限られます。

---

## 影響範囲テーブルの正確性評価

### 直接変更ファイル -- 正確

| ファイル | 評価 |
|---------|------|
| `MarkdownEditor.tsx` | 正確。mobileTab初期値のuseEffect追加が必要。line 134付近。 |
| `WorktreeDetailRefactored.tsx` | 正確。line 1869-1875のMarkdownEditor呼び出しにinitialViewMode='split'が未指定であることを確認済み。 |

### 影響なしファイル -- 正確

全5ファイル（MarkdownPreview.tsx, FileViewer.tsx, FilePanelContent.tsx, useIsMobile.ts, markdown-editor.ts）について実コードを確認し、影響なしの理由が正しいことを検証しました。特にFilePanelContent.tsxのline 478でinitialViewMode='preview'が渡されている点との整合性も正しく記載されています。

---

## SSR Hydration記述の技術的正確性

**評価: 正確**

1. **useIsMobileのSSR初期値**: `useState<boolean>(false)` で初期化されuseEffectでクライアントサイド判定を行う -- 正確。useIsMobile.ts line 55で確認。

2. **NGパターンの説明**: `useState(isMobile ? 'preview' : 'editor')` がSSR時に常にeditorになる理由 -- 正確。useStateの初期値はコンポーネントマウント時に一度だけ評価される。

3. **OKパターンの説明**: useEffectでisMobile変化時にsetMobileTab('preview')する方式 -- 正確。hydration完了後にuseEffectが実行されるため、SSRミスマッチを回避できる。

---

## Should Fix（推奨対応）

### SF-1: filePath変更時のmobileTabリセット挙動が未定義

**カテゴリ**: テスト範囲
**場所**: 受け入れ条件 - テスト要件セクション

**問題**:
提案されているuseEffectの依存配列が `[isMobile]` のみの場合、MarkdownEditorの `filePath` propsが変更されてコンポーネントが再レンダーされても、`mobileTab` stateはリセットされません。

具体的なシナリオ: ユーザーがモバイルでMarkdownファイルAを開く -> previewタブが表示される -> editorタブに切り替える -> 同じモーダル内でファイルBを開く -> editorタブのまま表示される（previewに戻らない）。

MarkdownEditorは `memo` でラップされているため（line 108）、propsが変更されても内部stateはReactの仕様によりリセットされません。

**推奨対応**:
この挙動が意図的かどうかを明確にしてください。もしfilePath変更時にもpreviewにリセットしたい場合、useEffectの依存配列に `filePath` を追加するか、テスト要件にこのシナリオを含めてください。ただし、WorktreeDetailRefactored.tsxのモーダルは `editorFilePath` が変更されると条件レンダリングにより再マウントされる可能性が高いため、実際にはこのケースが発生しにくい可能性もあります。低優先度ですが、テスト要件として挙動を明確にしておくと実装時の判断が容易になります。

**証拠**:
- `MarkdownEditor.tsx` line 108: `export const MarkdownEditor = memo(function MarkdownEditor({...`
- `WorktreeDetailRefactored.tsx` line 1860: `{editorFilePath && (` -- 条件レンダリング。editorFilePathがnull->A->null->Bと遷移する場合はアンマウント/再マウントが発生するためstateはリセットされる。ただしA->Bに直接変更される場合は再マウントされずstateが保持される。

---

## Nice to Have（あれば良い）

### NTH-1: 影響なしテーブルのMarkdownPreview.tsxの説明の微修正

**カテゴリ**: 影響ファイル
**場所**: 影響範囲 - 影響なしのファイル（確認済み）テーブル

**問題**:
「MobileTabBarコンポーネントはprops受取のみで初期値ロジックなし」は技術的に正しいですが、影響なしの対象はファイル（MarkdownPreview.tsx）であり、MobileTabBarはその中のexportの一つです。

**推奨対応**:
「MarkdownPreview.tsxおよびその中のMobileTabBarコンポーネントはprops受取のみで、mobileTab初期値の決定ロジックを持たない」のように微修正すると、ファイル単位の影響なし理由としてより正確です。

---

### NTH-2: OKパターンのuseEffectでelseブランチが不要である理由の注記

**カテゴリ**: ドキュメント更新
**場所**: 技術的注意事項（SSR hydration対策）セクション

**問題**:
OKパターンのuseEffectはisMobile===trueの場合のみ処理していますが、isMobileがfalseに変わった場合（ウィンドウリサイズ）にmobileTabを'editor'に戻す処理が不要である理由の説明がありません。

**推奨対応**:
実装者向けの参考情報として「isMobileがfalseの場合はshowMobileTabsもfalseとなりMobileTabBar自体が非表示になるため、mobileTabの値は表示に影響しない。elseブランチは不要。」と注記すると、不要なコードの追加を防げます。

---

## モーダルアニメーションフラッシュのリスク評価

Issueで言及されている「モーダルのopen animationとuseEffectの実行タイミングの競合」について、Modal.tsx（`src/components/ui/Modal.tsx`）を確認しました。

- Modal.tsxはCSS `transition-all` のみ使用しており、JavaScriptベースのアニメーション（setTimeout, requestAnimationFrame等）は使用していない
- useEffectはReactのコミットフェーズ後に同期的にスケジュールされるため、ブラウザの最初のペイント前に完了する可能性が高い
- CSSトランジションはDOMに要素が挿入された後に開始されるため、useEffectの実行とほぼ同時またはそれ以前に完了する

**結論**: フラッシュリスクは低い。Issueの記述「実装時にモーダルアニメーション中にuseEffectが完了することを確認する」は妥当な注意事項です。

---

## 残存ブラインドスポットの確認

| 観点 | 状態 | 詳細 |
|------|------|------|
| SSR hydration | 対処済み | NGパターン/OKパターン共に正確 |
| localStorage競合 | 対処済み | initialViewMode='split'の明示的渡しで解決 |
| MARP影響 | 対処済み | スコープ外に明記 |
| タブレットランドスケープ | 対処済み | スコープ外に注記 |
| テスト範囲 | 概ね十分 | filePath変更シナリオの追加を推奨（SF-1） |
| 破壊的変更 | なし | PC版への影響なし |
| 依存ライブラリ | 影響なし | React標準APIのみ使用 |
| FilePanelContent.tsx | 対処済み | PC側パネルとして影響なしを明記 |

---

## 総合評価

Issue #549は6回のレビュー・更新サイクルを経て、影響範囲分析が十分に成熟しています。Must Fixは0件であり、実装に着手可能な状態です。SF-1（filePath変更時のmobileTabリセット）は実装時に判断できる軽微な設計判断であり、ブロッカーではありません。

---

## 参照ファイル

### コード
- `src/components/worktree/MarkdownEditor.tsx`: mobileTab初期値（line 134）、memo化（line 108）、showMobileTabs条件（line 210-211）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: MarkdownEditor Modal呼び出し（line 1869-1875）
- `src/components/ui/Modal.tsx`: CSS transitionのみ、JSアニメーションなし（line 96-98）
- `src/hooks/useIsMobile.ts`: SSR初期値false（line 55）
- `src/components/worktree/FilePanelContent.tsx`: initialViewMode='preview'（line 478）

### ドキュメント
- `CLAUDE.md`: 実装完了後にモジュールリファレンスへ反映
