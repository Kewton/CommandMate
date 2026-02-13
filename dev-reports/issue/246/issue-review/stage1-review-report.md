# Issue #246 レビューレポート

**レビュー日**: 2026-02-13
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

## 総評

Issue #246はスマートフォンでのバックグラウンド復帰時エラーという実際のバグを正確に報告しており、根本原因の分析も仮説検証により全て確認済みである。Issueの品質は高く、Must Fixに該当する重大な誤りは見当たらない。

ただし、実装に進む前に明確化すべき点がいくつかある。特に、WorktreeList.tsxとWorktreeDetailRefactored.tsxでは問題構造が異なること、エラーリセットのタイミング仕様が未定義であること、既存ポーリングとの競合状態への対処方針が不明確であることは、実装時の混乱を防ぐために事前に解決しておくべきである。

---

## Must Fix（必須対応）

該当なし。

Issueの根本原因分析は仮説検証レポートにより全て確認されており、技術的に誤った記載や重大な矛盾は見当たらない。

---

## Should Fix（推奨対応）

### SF-1: WorktreeList.tsxの問題構造の区別

**カテゴリ**: 完全性
**場所**: 実装タスク セクション - 3つ目のタスク

**問題**:
WorktreeList.tsxのポーリングはerror状態でブロックされない設計であり、WorktreeDetailRefactored.tsxとは異なる問題構造を持つ。Issueでは両者を同列に扱っているが、実際のコード構造は大きく異なる。

**証拠**:
- `WorktreeDetailRefactored.tsx` L1479-1493: `if (loading || error) return;` ガードあり -- errorでポーリング停止
- `WorktreeList.tsx` L122-129: `setInterval(() => { fetchWorktrees(true); }, 5000)` -- ガードなし、errorでもポーリング継続
- `WorktreeList.tsx` L65-81: `fetchWorktrees(silent=true)` はエラー時もsetError()するが、setIntervalは独立して動作し続ける

**推奨対応**:
WorktreeList.tsxへの対応は「バックグラウンド復帰時にsetIntervalが正常に再開しない可能性への対処（タイマー再設定）」と明記し、WorktreeDetailRefactored.tsxの「エラー状態からの自動復帰」とは別の問題であることを区別して記載する。

---

### SF-2: 受入条件「既存のポーリング動作に影響がない」の具体化

**カテゴリ**: 明確性
**場所**: 受入条件 セクション - 3つ目の条件

**問題**:
`visibilitychange`イベントでデータ再取得をトリガーする場合、既存の`setInterval`ポーリングとの並行動作をどう扱うかの基準がない。「影響がない」が何を意味するか不明確である。

**証拠**:
- `WorktreeDetailRefactored.tsx` L1479-1493のsetIntervalポーリング
- 新規追加される`visibilitychange`ハンドラ
- 両者が同時にfetchを発行する可能性がある

**推奨対応**:
以下のような具体的な検証基準を追加する:
- 「`visibilitychange`による再取得と、既存の`setInterval`ポーリングが競合（同時発火）しても、データの整合性が保たれること」
- 「`setInterval`のタイミングやインターバル値が変更されていないこと」

---

### SF-3: エラーリセットタイミングの仕様化

**カテゴリ**: 完全性
**場所**: 対策案 セクション

**問題**:
ページ復帰時にエラー状態をどのタイミングでリセットするかが未定義である。即座にリセットする方式と、データ取得成功後にリセットする方式では、UXとエラーハンドリングの堅牢性が大きく異なる。

**証拠**:
- 既存の`handleRetry`関数（L1434-1442）: `setError(null)` -> `setLoading(true)` -> fetch -> `setLoading(false)` の順序
- 仮説検証レポートの「追加確認が必要な点」でも同様の指摘あり

**推奨対応**:
エラーリセットの詳細フローを明記する。例:
1. `visibilitychange`検知時に`error`を即座に`null`にリセット
2. `loading`を`true`に設定
3. データ再取得を実行
4. 再取得失敗時は再度`error`を設定

既存の`handleRetry`関数と同等のフローを再利用するかどうかも明記するとよい。

---

### SF-4: fetchWorktreeのエラーハンドリング非対称性の明記

**カテゴリ**: 技術的妥当性
**場所**: 根本原因の仮説 セクション

**問題**:
`fetchWorktree`関数のみが`setError()`を呼ぶが、`fetchMessages`と`fetchCurrentOutput`は`console.error`のみでエラー状態を設定しない。この非対称性がIssueで明示されていない。

**証拠**:
- `fetchWorktree` (L994-995): `setError(message)` -- error状態をセット
- `fetchMessages` (L1011): `console.error(...)` -- error状態をセットしない
- `fetchCurrentOutput` (L1051): `console.error(...)` -- error状態をセットしない

**推奨対応**:
`fetchWorktree`のみがerror状態を引き起こす点を根本原因の分析に追記する。また、`visibilitychange`復帰時に`fetchWorktree`が失敗した場合のリトライ戦略（指数バックオフ、最大リトライ回数など）についても検討事項として追加する。

---

## Nice to Have（あれば良い）

### NTH-1: useWorktreeUIStateのclearErrorと ローカルerror stateの関係性整理

**カテゴリ**: 完全性
**場所**: 影響範囲 セクション - 関連コンポーネント

**問題**:
`useWorktreeUIState.ts`にはreducerベースの`clearError`アクション（L118, L200, L270）が既に存在するが、`WorktreeDetailRefactored.tsx`のエラー状態はローカルの`useState`（L939）で管理されている。これら2系統のerror管理が存在する点が整理されていない。

**推奨対応**:
実装タスクまたは対策案の中で、`useWorktreeUIState.ts`のclearErrorアクションと、ローカルstateの`setError`の使い分けを明確にする。

---

### NTH-2: テスト戦略の具体化

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

**問題**:
テストに関する記載が「ユニットテストの追加」「スマートフォン実機での動作確認」のみで、`visibilitychange`イベントのテスト方法が具体的でない。

**推奨対応**:
テスト戦略を具体化する。例:
- Vitestで`document.dispatchEvent(new Event('visibilitychange'))`を発行し、`Object.defineProperty`で`document.visibilityState`を制御する
- エラー状態からの復帰シナリオをテストする
- fetchモックで失敗ケース（ネットワークエラー）もカバーする

---

### NTH-3: visibilitychangeハンドラのthrottle考慮

**カテゴリ**: 完全性
**場所**: 対策案 セクション

**問題**:
ユーザーがアプリを短時間で繰り返しバックグラウンド/フォアグラウンド切り替えした場合、`visibilitychange`イベントが連続発火してAPI呼び出しが多重に行われる可能性がある。

**推奨対応**:
`visibilitychange`ハンドラ内でデータ再取得をthrottle/debounceする考慮を検討事項として追加する。`src/lib/utils.ts`に既存の`debounce`関数があり、プロジェクト内で利用実績がある。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 主要変更対象。ポーリングエフェクト(L1479-1493)、初期化ガード(L1449-1476)、エラー表示(L1535-1537)、handleRetry(L1434-1442)、fetchWorktree(L984-998) |
| `src/components/worktree/WorktreeList.tsx` | 副次的変更対象。ポーリング(L122-129)はerror/loadingガードなしでWorktreeDetailRefactoredとは異なる問題構造 |
| `src/hooks/useWorktreeUIState.ts` | clearErrorアクション(L118,L200,L270)が存在。ローカルerror stateとの2系統管理に注意 |
| `src/lib/utils.ts` | debounce関数が存在し、visibilitychangeハンドラの連続発火防止に活用可能 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクトのコーディング規約・ファイル構成・テスト戦略の参照 |
| `dev-reports/issue/246/issue-review/hypothesis-verification.md` | 仮説検証レポート。全仮説がConfirmed/Partially Confirmed |

---

*レビュー完了: 2026-02-13*
