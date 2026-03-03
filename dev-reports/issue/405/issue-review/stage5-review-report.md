# Issue #405 Stage 5 レビューレポート

**レビュー日**: 2026-03-04
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5（通常レビュー 2回目）
**前提**: Stage 1-4の指摘反映後の最終確認

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

**全体品質**: High

Stage 1-4の全must_fix（3件）が適切に反映されており、Issue品質は大幅に向上した。新規のmust_fix指摘は0件であり、実装着手可能な品質に達している。

---

## 前回指摘事項の反映状況

### Must Fix（3件中3件反映済み）

| ID | タイトル | 反映状況 |
|----|---------|---------|
| R1-007 | 受入条件の定量化 | **反映済み** - 2つの定量的基準（キャッシュTTL以内の反映遅延、コマンド送信後の次回ポーリングでのステータス更新）に具体化 |
| R3-001 | auto-yes応答後のキャッシュ無効化タイミング | **反映済み** - try-finallyパターンの擬似コード付き詳細設計を追記 |
| R3-002 | captureSessionOutput()インターフェース互換性 | **反映済み** - A案（インターフェース非変更）を採用し、受入条件にも追加 |

### Should Fix（13件中11件反映済み）

| ID | タイトル | 反映状況 |
|----|---------|---------|
| R1-001 | captureSessionOutput呼び出し箇所の網羅性 | **反映済み** - 4箇所から7箇所に拡充 |
| R1-002 | captureLines行数差異への対応方針 | **反映済み** - A案採用、メモリ見積もり記載 |
| R1-003 | isRunning()のtmux I/Oコスト | **反映済み** - listSessions()一括取得を実装タスクに追加 |
| R1-005 | キャッシュ無効化戦略 | **反映済み** - 4つの無効化ポイントを詳細記載 |
| R1-009 | CLAUDE.md更新 | **反映済み** - 実装タスクに追加 |
| R1-010 | 実装タスクの明確化 | **反映済み** - active CLI tool事前取得に焦点を当てた記述に変更 |
| R3-005 | キャッシュ無効化フック挿入箇所 | **反映済み** - 影響範囲テーブルに7ファイル追加 |
| R3-006 | 既存テスト互換性 | **反映済み** - 受入条件に追加 |
| R3-007 | globalThisパターン | **反映済み** - 詳細記載 |
| R3-008 | session-cleanup.ts | **反映済み** - 影響範囲テーブルに追加 |
| R3-009 | ANSIエスケープシーケンス | **反映済み** - 考慮事項を追記 |
| R3-012 | isRunning()最適化A案 | **反映済み** - 実装タスクに明記 |
| R3-003 | response-pollerのキャッシュ影響 | **未反映** - キャッシュ無効化戦略の反映により実質的リスク軽減済み |
| R3-004 | prompt-response APIとauto-yesの競合 | **未反映** - スコープ外の排他制御問題として暗黙的に除外 |

### Nice to Have（7件: 反映対象外として妥当にスキップ）

R1-004, R1-006, R1-008, R1-011, R3-010, R3-011 -- いずれも実装時の判断・対応で十分な項目。

---

## 新規指摘事項

### Should Fix

#### R5-001: worktrees/[id]/route.tsの最適化タスクの明示化

**カテゴリ**: consistency
**場所**: 実装タスク / 影響範囲テーブル

**問題**:
`src/app/api/worktrees/[id]/route.ts` (L54-88) は `src/app/api/worktrees/route.ts` (L44-89) と全く同一のN+1パターン（全5ツールに対する`isRunning()` + `captureSessionOutput()`ループ）を持つ。worktrees/route.tsの実装タスクには`listSessions()`一括取得やactive CLI tool絞り込みが明記されているが、worktrees/[id]/route.tsに対する同等の最適化が独立した実装タスク項目として記載されていない。

影響範囲テーブルには「listSessions()結果利用」と変更内容に記載されているが、実装タスクとの対応が不明確。

**推奨対応**:
実装タスクに「GET /api/worktrees/[id]: worktrees/route.tsと同等のlistSessions()一括取得・active CLI tool絞り込みを適用」を追加するか、既存タスクの適用範囲にworktrees/[id]/route.tsが含まれることを明記する。

---

#### R5-002: B案（呼び出し元での明示的キャッシュクリア）の漏れ防止策の記載不足

**カテゴリ**: completeness
**場所**: 実装タスク > キャッシュ無効化

**問題**:
キャッシュ無効化フック挿入方式としてB案（呼び出し元での明示的キャッシュクリア）が採用されているが、将来新たなCLIツールが追加された場合の漏れ防止策が記載されていない。Issue #379でOpenCodeが追加された前例があるように、新ツールの`sendMessage()`/`killSession()`にもキャッシュクリアを挿入する必要がある。

**推奨対応**:
以下のいずれかの方策を記載すべき:
1. BaseCLIToolクラスにキャッシュクリアのテンプレートメソッドを導入
2. CLAUDE.mdに「新規CLIツール追加時のチェックリスト」として記載
3. 受入テストに全CLIツールのsendMessage()後のキャッシュ無効化テストを追加

---

### Nice to Have

#### R5-003: current-output APIのisRunning()最適化範囲の明確化

**カテゴリ**: completeness
**場所**: 影響範囲テーブル > current-output/route.ts

`current-output/route.ts`は単一worktree・単一CLIツールへのアクセスであり、`listSessions()`一括取得の恩恵は限定的。`captureSessionOutput()`のA案キャッシュヒット時にhasSession()もスキップされるため追加最適化は不要だが、その旨を注記すると明確になる。

---

#### R5-004: assistant-response-saverのcaptureLines具体値の記載

**カテゴリ**: correctness
**場所**: 背景・課題 > S3

S3セクションで他の呼び出し箇所は「10,000行」「5,000行」等の具体値が記載されているが、assistant-response-saverのみ具体値が記載されていない。実際の値はSESSION_OUTPUT_BUFFER_SIZE=10,000行。一貫性のため具体値を追記するとよい。

---

#### R5-005: キャッシュバイパス時のフレッシュ取得結果の書き戻し方針

**カテゴリ**: completeness
**場所**: 提案する解決策 > 1. キャッシュ無効化戦略

prompt-response APIのキャッシュバイパス時に、フレッシュ取得した結果をキャッシュに書き戻すかどうかの方針が未決定。実装時の判断で対応可能だが、「書き戻す（他の呼び出し元がフレッシュデータを利用可能）」等の方針を一言記載すると実装者への指針になる。

---

## 総合評価

Issue #405は4回のレビューイテレーション（Stage 1-4）を経て、以下の点で優れた品質に達している:

1. **問題分析の正確性**: S1/S3/P1/P2の4つの課題が実コードの行番号参照付きで正確に記載されている。captureSessionOutput()の全7箇所の呼び出し箇所が網羅されている。

2. **解決策の具体性**: キャッシュ設計方針（A案採用、メモリ見積もり10MB、キャッシュ無効化戦略4ポイント、try-finallyパターン、ANSIエスケープ考慮、captureSessionOutput()インターフェース非変更）が詳細に記載されている。

3. **影響範囲の網羅性**: 影響範囲テーブルが19ファイルにわたり、キャッシュ無効化フック挿入箇所を含めて網羅的。

4. **受入条件の検証可能性**: 7つの受入条件が全て定量的または検証可能な形式で記載されている。

5. **レビュー履歴の透明性**: Stage 2/Stage 4の反映内容がIssue末尾に記録されている。

**結論**: must_fix指摘0件。実装着手可能な品質に達している。should_fix 2件（R5-001、R5-002）は実装前の軽微な補足で対応可能。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/route.ts` (L54-88): worktrees/route.tsと同一のN+1パターン（R5-001）
- `src/app/api/worktrees/route.ts` (L44-89): N+1パターンの主要箇所
- `src/app/api/worktrees/[id]/current-output/route.ts` (L52, L70): isRunning()とcaptureSessionOutput()呼び出し
- `src/lib/assistant-response-saver.ts` (L119, L243): SESSION_OUTPUT_BUFFER_SIZE=10000行（R5-004）
- `src/lib/prompt-answer-sender.ts` (L89, L96, L100, L106): キャッシュ無効化フック挿入対象

### ドキュメント
- `CLAUDE.md`: モジュール説明テーブル更新が実装タスクに含まれている
