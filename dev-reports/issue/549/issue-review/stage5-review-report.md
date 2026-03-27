# Issue #549 レビューレポート (Stage 5)

**レビュー日**: 2026-03-27
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 2回目
**ステージ**: 5/6

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

## 全体評価

Issue #549は2回のレビューイテレーション（通常レビュー + 影響範囲レビュー）を経て、高品質なIssue記述に改善された。前回の全指摘事項（Stage 1: 6件、Stage 3: 6件）のうち11件が反映済み、1件が妥当な理由でスキップされている。受け入れ条件、技術的注意事項（SSR hydration対策）、影響範囲分析、テスト要件が網羅されており、実装に着手可能な状態である。

今回のレビューで検出されたのはshould_fix 2件、nice_to_have 2件のみで、いずれも実装を妨げるものではない。

---

## 前回指摘事項の反映状況

### Stage 1（通常レビュー 1回目）-- 全6件反映済み

| ID | カテゴリ | ステータス | 反映内容 |
|----|---------|-----------|---------|
| MF-1 | 完全性 | 反映済み | 受け入れ条件を機能要件6項目 + テスト要件4項目として追加 |
| SF-1 | 明確性 | 反映済み | 現在のフローと目標フローを図示、方針Cを選択と明記 |
| SF-2 | 技術的妥当性 | 反映済み | モバイル時はlocalStorage無視して常にpreview表示と明記 |
| SF-3 | 明確性 | 反映済み | mobileTab初期値変更を実装アプローチに明記 |
| NTH-1 | 完全性 | 反映済み | MARPファイルをスコープ外に明記 |
| NTH-2 | 完全性 | 反映済み | スクリーンショットにキャプション追加 |

### Stage 3（影響範囲レビュー 1回目）-- 5件反映、1件スキップ

| ID | カテゴリ | ステータス | 反映内容 |
|----|---------|-----------|---------|
| MF-1 | 影響ファイル | 反映済み | SSR hydration問題を技術的注意事項セクションとして追加。NG/OKパターンのコード例付き |
| SF-1 | 影響ファイル | 反映済み | WorktreeDetailRefactored.tsxを変更対象ファイルに追加、initialViewMode='split'の明示的渡しを記載 |
| SF-2 | テスト範囲 | 反映済み | mobileTab初期値に関するテストケース4項目を追加 |
| SF-3 | 影響ファイル | 反映済み | FilePanelContent.tsxを影響なしファイルテーブルに明記 |
| NTH-1 | 移行考慮 | 反映済み | タブレットランドスケープモードの影響なしをスコープ外に注記 |
| NTH-2 | ドキュメント | スキップ | CLAUDE.md更新は実装完了後に行うべきため、Issue本文への反映は不要（妥当） |

---

## Should Fix（推奨対応）

### SF-1: useEffect mobileTab切替時のフラッシュに関する受け入れ条件

**カテゴリ**: 技術的妥当性
**場所**: 技術的注意事項（SSR hydration対策）セクション

**問題**:
Issueでは「MarkdownEditorはモーダルで開かれるため体感上の問題はない」と記載しているが、モーダルのopen animationとuseEffectの実行タイミングが競合する場合、editorタブが一瞬表示される可能性がある。この挙動について受け入れ条件に検証観点が含まれていない。

**証拠**:
- `useIsMobile` hookのuseEffectはコンポーネントマウント後に実行される
- モーダルコンポーネント（`WorktreeDetailRefactored.tsx:1861-1878`）のopen animationタイミングとuseEffect実行が同一レンダリングサイクルで完了するかは実装依存
- Issue本文では「体感上の問題はない」と断定しているが、検証観点として明示されていない

**推奨対応**:
受け入れ条件に「モバイルでMarkdownEditorモーダル表示時、editorタブのちらつきが体感上問題ない程度であること（またはモーダルアニメーション中に切替が完了すること）」を追加するか、実装確認事項として注記する。

---

### SF-2: initialViewMode='split' に対するテスト要件の欠落

**カテゴリ**: 完全性
**場所**: 受け入れ条件 - テスト要件セクション

**問題**:
実装アプローチのステップ4で「WorktreeDetailRefactored.tsxのモバイルMarkdownEditor Modal呼び出し時にinitialViewMode='split'を明示的に渡す」と記載されているが、これに対応するテスト要件がテスト要件セクションに含まれていない。

**証拠**:
- 実装アプローチに「initialViewMode='split'を明示的に渡す」変更が明記されている
- テスト要件4項目はいずれもMarkdownEditor内部のmobileTab挙動に関するもので、WorktreeDetailRefactored.tsxのprops渡しを検証するテストがない

**推奨対応**:
テスト要件に「WorktreeDetailRefactored.tsxのモバイルMarkdownEditor Modal呼び出し時にinitialViewMode='split'が渡されていること」を追加する。

---

## Nice to Have（あれば良い）

### NTH-1: レビュー履歴に反映結果サマリーがない

**カテゴリ**: 完全性
**場所**: レビュー履歴セクション

レビュー履歴セクションにはレビュー結果（指摘事項）は記載されているが、反映結果（Stage 2, Stage 4）のサマリーが含まれていない。「6件中5件反映、1件スキップ」のような記録があるとトレーサビリティが向上する。

---

### NTH-2: コード参照の行番号は変動リスクあり

**カテゴリ**: 明確性
**場所**: 補足情報 - 関連コード参照セクション

関連コード参照テーブルの行番号（例: line 80-93, line 134）は現在のコードと一致しているが、他の変更で容易にずれる。参考値であることの注記か、関数名ベースの参照への切り替えを検討するとよい。

---

## 参照ファイル

### コード
- `src/components/worktree/MarkdownEditor.tsx`: mobileTab初期値(line 134)、getInitialViewMode(line 80-93)、showMobileTabs条件(line 210-211)
- `src/components/worktree/WorktreeDetailRefactored.tsx`: モバイルMarkdownEditor Modal(line 1869-1875)
- `src/hooks/useIsMobile.ts`: SSR hydration対策(line 55)
