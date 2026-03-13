# Issue #485 レビューレポート (Stage 5)

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー（2回目）
**目的**: 前回指摘の反映確認 + 新規問題の洗い出し

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 1 |

**総合品質: high**

前回のStage 1（通常レビュー1回目）およびStage 3（影響範囲レビュー）で指摘されたMust Fix項目（MF-1, MF-2, MF-3, S3-001, S3-002, S3-003）は全て適切に対応されている。Issue本文は実装者が必要な情報を得られる品質に達しており、新たなMust Fix項目は発見されなかった。

---

## 前回指摘の反映確認

### Stage 1 Must Fix

| ID | 指摘内容 | 対応状況 |
|----|---------|---------|
| MF-1 | draftKeyの不正確な記載 | 対応済み - DRAFT_STORAGE_KEY_PREFIX + worktreeIdに修正 |
| MF-2 | useInfiniteMessagesの誤った参照 | 対応済み - WorktreeDetailRefactored -> HistoryPane props経由に修正 |
| MF-3 | ConversationPairCardでのuseConversationHistory使用の誤り | 対応済み - propsベースの表示コンポーネントとして正確に記載 |

### Stage 3 Must Fix

| ID | 指摘内容 | 対応状況 |
|----|---------|---------|
| S3-001 | LeftPaneTabSwitcher経由の伝播経路の誤り | 対応済み - 正しい伝播経路に修正、「変更不要」を明記 |
| S3-002 | memo()とforwardRefの技術的制約の未記載 | 対応済み - 実装タスクに注記追加 |
| S3-003 | leftPaneMemoのuseMemo依存配列への追加の未記載 | 対応済み - 影響範囲テーブルに明記 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### S5-001: NotesAndLogsPane内部でのMemoPane伝播の明記

**カテゴリ**: 完全性

**問題**:
影響範囲テーブルのNotesAndLogsPane.tsxの変更内容が「NotesAndLogsPanePropsにonInsertToMessage追加」のみとなっており、内部でMemoPane呼び出し箇所にコールバックを転送する修正が暗黙的になっている。NotesAndLogsPaneは内部でactiveSubTab状態を管理しており、'notes'タブ選択時のみMemoPaneをレンダリングする構造のため、MemoPane呼び出し箇所の修正も変更内容に含まれる。

**証拠**:
- NotesAndLogsPane.tsx L113-114: `<MemoPane worktreeId={worktreeId} className="h-full" />` -- 現在onInsertToMessageを渡していない

**推奨対応**:
影響範囲テーブルのNotesAndLogsPane.tsxの変更内容を「NotesAndLogsPanePropsにonInsertToMessage追加、内部のMemoPane呼び出し箇所へのコールバック伝播」に更新する。

---

#### S5-002: MobileContentのmemoタブでmaxAgentsが渡されていない既存不整合の認識

**カテゴリ**: 整合性

**問題**:
デスクトップ側（WorktreeDetailRefactored.tsx L1397）ではNotesAndLogsPaneにmaxAgents={4}を渡しているが、MobileContent内（WorktreeDetailSubComponents.tsx L885-894）では渡していない。Issue #485のスコープ外だが、実装時にMobileContentPropsを修正する際にこの不整合に遭遇する可能性がある。

**推奨対応**:
Issue #485のスコープ外として認識しておく。実装時に気付いた場合は別Issueとして起票するか、軽微な修正として同時対応するかを判断する。

---

### Nice to Have（あれば良い）

#### S5-003: メモ伝播経路の「デスクトップ」表記の精度

**カテゴリ**: 明確性

**問題**:
コールバック伝播経路の「メモ（デスクトップ）」は、より正確には「左ペインmemoタブ選択時」のレンダリング経路を指す。現在の記載でも実装上の問題はない。

**推奨対応**: 対応任意。

---

## 検証結果サマリー

| 検証項目 | 結果 |
|---------|------|
| Issueタイトルの正確性 | 正確 |
| 背景・課題の妥当性 | 適切 |
| 実装タスクの完全性 | 十分（memo()注意点、テスト区分も記載済み） |
| 受入条件の検証可能性 | 検証可能（具体的で測定可能な条件） |
| 影響範囲の正確性 | 高い（軽微な補足点のみ残存） |
| コードベースとの整合性 | 整合 |

---

## 参照ファイル

### コード
- `src/components/worktree/NotesAndLogsPane.tsx` L113-114: MemoPane呼び出し箇所
- `src/components/worktree/WorktreeDetailSubComponents.tsx` L882-896: MobileContentのmemoタブ
- `src/components/worktree/WorktreeDetailRefactored.tsx` L1386-1399: デスクトップ側NotesAndLogsPane呼び出し

---

## 結論

Issue #485は4回のレビュー/修正サイクル（Stage 1-4）を経て、実装に必要な情報が十分に整備された状態にある。Must Fix項目はなく、残存するShould Fix 2件はいずれも軽微な補足事項である。Issueは実装着手可能な品質に到達している。
