# Issue #391 Stage 1 レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（Consistency & Correctness）
**ステージ**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

**全体評価**: high

Issue #391の根本原因分析は正確であり、仮説検証レポートでも3つの仮説全てがConfirmedされている。修正方針（案A + 案B の組み合わせ）は概念的に妥当だが、擬似コードレベルでのエッジケース対応に不足がある。受入条件は主要パスをカバーしているが、中間状態の長時間放置シナリオが未定義。全体として品質は高く、Should Fix指摘を反映すれば堅牢な実装が可能。

---

## Must Fix（必須対応）

なし。

---

## Should Fix（推奨対応）

### SF-001: 案AのisEditingフラグ解除条件が不完全

**カテゴリ**: 完全性
**場所**: 修正方針 > 案A セクション

**問題**:
修正方針の案Aでは、`isEditing`フラグを`true`から`false`に戻す処理が「`next.size === MAX_SELECTED_AGENTS`時（API呼び出し後）」のみとなっている。以下のケースで`isEditing`が`true`のまま残留する可能性がある:

1. ユーザーがチェックを外した後、2つ目を選択せずに別のタブに移動して戻った場合
2. 長時間放置した場合

**証拠**:
擬似コードでは`setIsEditing(false)`が`if (next.size === MAX_SELECTED_AGENTS)`ブロック内のみに記載。チェックを外してそのまま放置した場合のリセットパスが存在しない。

**推奨対応**:
`isEditing`フラグの解除条件を明確化する:
- API呼び出し成功/失敗時に`false`にする（記載済み）
- タイムアウト（例: 30秒）での安全弁リセットを検討する
- コンポーネント再マウント時は`useState`初期値`false`で自動リセットされる旨を明記する
- あるいは「ユーザーが明示的に2つ選択するまで中間状態を維持する」という設計判断を明記する

---

### SF-002: 案BのsetSelectedAgentsスキップ条件の具体的実装が不明確

**カテゴリ**: 完全性
**場所**: 修正方針 > 案B セクション

**問題**:
案Bでは「`selectedAgents`が変化していない場合は`setSelectedAgents()`を呼ばない」と記載されているが、具体的な比較方法が示されていない。ReactのAPIレスポンスから毎回新しい配列オブジェクトが生成されるため、`===`比較では常に異なると判定される。

**証拠**:
`WorktreeDetailRefactored.tsx` L1026-1052: `fetchWorktree`の`useCallback`依存配列は`[worktreeId]`のみ。`selectedAgents`を依存配列に追加するとポーリング再設定が頻発するため、`useRef`パターンが必要。

```tsx
// WorktreeDetailRefactored.tsx L1034-1037
if (data.selectedAgents) {
  setSelectedAgents(data.selectedAgents); // 毎回新しい配列参照が渡される
}
```

**推奨対応**:
具体的な比較ロジックを示す。`useRef`で最新の`selectedAgents`を保持し、値レベルの比較を行う:

```tsx
const selectedAgentsRef = useRef(selectedAgents);
selectedAgentsRef.current = selectedAgents;

// fetchWorktree内:
if (data.selectedAgents) {
  const current = selectedAgentsRef.current;
  if (data.selectedAgents[0] !== current[0] || data.selectedAgents[1] !== current[1]) {
    setSelectedAgents(data.selectedAgents);
  }
}
```

---

### SF-003: 受入条件にisEditingタイムアウト/放置シナリオが不足

**カテゴリ**: 完全性
**場所**: 受入条件 セクション

**問題**:
ユーザーがチェックを外した後に長時間放置するケース（中間状態のまま数分経過する場合）について受入条件が定義されていない。`isEditing`フラグ方式を採用する場合、このシナリオの期待動作を明確にすべき。

**推奨対応**:
以下のいずれかの受入条件を追加:
- 案1: 「チェックを外した後、一定時間（例: 30秒）別のエージェントを選択しなかった場合、次回ポーリングでサーバーの値に同期される」
- 案2: 「チェックを外した後、ユーザーが明示的に2つ選択するまで中間状態を維持する。ページリロードでリセットされる」

どちらの振る舞いを採用するか設計判断として明記すること。

---

### SF-004: 案AのAPI失敗時リバート動作のisEditing処理が欠落

**カテゴリ**: 明確性
**場所**: 修正方針 > 案A セクション 擬似コード

**問題**:
擬似コードのAPI呼び出し後、`setIsEditing(false)`がAPI成功パスにのみ記載されている。API失敗（catchブロック）時にも`isEditing`を`false`に戻す処理が必要。

**証拠**:
現行コード `AgentSettingsPane.tsx` L152-176 はtry/catch/finallyパターンでAPI呼び出しを行っている:

```tsx
// L161-172: 現行のエラーハンドリング
if (response.ok) {
  onSelectedAgentsChange(pair);
} else {
  // Revert on failure
  setCheckedIds(new Set(selectedAgents));
}
// catch: Revert on network error
// finally: setSaving(false)
```

擬似コード案Aでは、このcatch/finallyブロックに`setIsEditing(false)`が含まれていない。

**推奨対応**:
`finally`ブロックで`setIsEditing(false)`を呼ぶ:

```tsx
finally {
  setSaving(false);
  setIsEditing(false); // API成功・失敗いずれの場合もリセット
}
```

---

## Nice to Have（あれば良い）

### NTH-001: 既存テストへの影響と追加テスト方針の記載

**カテゴリ**: 完全性
**場所**: Issue本文（テスト方針なし）

**問題**:
`AgentSettingsPane.test.tsx` L62-80に「should sync checked state when selectedAgents prop changes」テストが存在し、現行の`useEffect`無条件同期動作を前提としている。修正後はこのテストの期待動作が変わる。

**推奨対応**:
以下のテストケースの追加/更新を受入条件に追記:
1. `isEditing`中に`selectedAgents` propが変更されても`checkedIds`が上書きされないことの検証
2. `isEditing`解除後に`selectedAgents` propの変更が正しく同期されることの検証
3. 既存テスト「should sync checked state when selectedAgents prop changes」を`isEditing=false`前提に更新

---

### NTH-002: Issue本文中の行番号の軽微なズレ

**カテゴリ**: 整合性
**場所**: 根本原因 セクション

**問題**:
Issue本文では「IDLE: 5秒 / ACTIVE: 2秒、L1796-1804」と記載されているが、仮説検証レポートで確認された実際の行番号はL1792-1807。

**推奨対応**:
「L1796-1804」を「L1792-1807」に修正。

---

### NTH-003: Issue #368との関連リンク

**カテゴリ**: 完全性
**場所**: Issue本文

**問題**:
本バグはIssue #368で導入された`AgentSettingsPane`の設計に起因する。トレーサビリティのために関連Issueリンクがあると良い。

**推奨対応**:
Issue本文に「関連Issue: #368（Agent設定UI導入）」を追記。

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連性 |
|---------|--------|--------|
| `src/components/worktree/AgentSettingsPane.tsx` | L98-100, L141-176 | バグの直接原因（useEffect無条件上書き）と修正対象（handleCheckboxChange） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L984, L1026-1052, L1792-1807 | selectedAgents state定義、fetchWorktreeポーリング、ポーリング間隔設定 |
| `src/app/api/worktrees/[id]/route.ts` | L209-230 | PATCH APIのselectedAgentsバリデーションとcli_tool_id整合性チェック |
| `tests/unit/components/worktree/AgentSettingsPane.test.tsx` | L62-80 | 修正後に更新が必要な既存テスト |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `dev-reports/issue/391/issue-review/hypothesis-verification.md` | 全仮説Confirmed済みの検証レポート |

---

## 次のステップへの推奨事項

Must Fixの指摘はなく、Stage 2（影響範囲レビュー）へ進行して問題ない。Should Fixの4件（特にSF-001とSF-004）は実装時に漏れやすいポイントであるため、Issue本文への反映を推奨する。
