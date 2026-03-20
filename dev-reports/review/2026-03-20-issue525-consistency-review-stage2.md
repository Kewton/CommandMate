# Architecture Review: Issue #525 - Stage 2 整合性レビュー

## Executive Summary

Issue #525（Auto-Yesエージェント毎独立制御）の設計方針書に対する整合性レビューを実施した。設計方針書は全体として既存実装との整合性が高く、Stage 1 レビューの指摘事項も適切に反映されている。ただし、関数シグネチャ変更に伴うコード例の不整合（2件の Must Fix）と、CLIToolType の数の誤記、既存実装構造との差異（4件の Should Fix）が検出された。

**ステータス**: conditionally_approved
**スコア**: 4/5

---

## 1. 整合性検証: 設計方針書 vs 既存ソースコード

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| AutoYesState インターフェース | 変更なし（Section 4-1） | auto-yes-state.ts L21-32: enabled, enabledAt, expiresAt, stopPattern, stopReason | 一致 |
| setAutoYesEnabled 現行シグネチャ | (worktreeId, enabled, duration?, stopPattern?) | auto-yes-state.ts L105-109: 一致 | 一致 |
| getAutoYesState 現行シグネチャ | (worktreeId) | auto-yes-state.ts L86: 一致 | 一致 |
| disableAutoYes 現行シグネチャ | (worktreeId, reason?) | auto-yes-state.ts L138-141: 一致 | 一致 |
| deleteAutoYesState 現行シグネチャ | (worktreeId) | auto-yes-state.ts L265: 一致 | 一致 |
| checkStopCondition 現行シグネチャ | (worktreeId, cleanOutput, onStopMatched?) | auto-yes-state.ts L211-214: 一致 | 一致 |
| getAutoYesStateWorktreeIds | () -> string[] | auto-yes-state.ts L280-282: 一致 | 一致 |
| globalThis.__autoYesStates Map | Map\<string, AutoYesState\> key=worktreeId | auto-yes-state.ts L53-58: 一致 | 一致 |
| globalThis.__autoYesPollerStates Map | Map\<string, AutoYesPollerState\> key=worktreeId | auto-yes-poller.ts L79-86: 一致 | 一致 |
| startAutoYesPolling 現行シグネチャ | (worktreeId, cliToolId) | auto-yes-poller.ts L524-526: 一致 | 一致 |
| stopAutoYesPolling 現行シグネチャ | (worktreeId) | auto-yes-poller.ts L584: 一致 | 一致 |
| isPollerActive 現行シグネチャ | (worktreeId) | auto-yes-poller.ts L143-145: 一致 | 一致 |
| getLastServerResponseTimestamp 現行シグネチャ | (worktreeId) | auto-yes-poller.ts L131-134: 一致 | 一致 |
| MAX_CONCURRENT_POLLERS | 50 | auto-yes-state.ts L334: 50 | 一致 |
| POLLING_INTERVAL_MS | 2000 | auto-yes-state.ts L311: 2000 | 一致 |
| auto-yes-manager.ts barrel | 明示的named exportのみ | auto-yes-manager.ts: 確認済み | 一致 |
| CLI auto-yes --agent | 既に対応済み | cli/commands/auto-yes.ts L23, L79: 一致 | 一致 |
| useAutoYes cliTool パラメータ | 既に受け取り済み | useAutoYes.ts L28: cliTool: string | 一致 |
| current-output API cliTool パラメータ | 既に受け取り済み | current-output/route.ts L49-50 | 一致 |
| auto-yes/route.ts POST cliToolId | 既に受け取り済み | auto-yes/route.ts L156-158 | 一致 |
| CLIToolType 数 | 最大4 (Section 8) | CLI_TOOL_IDS: 5ツール | **不一致** |

---

## 2. 整合性検証: 設計方針書内部の一貫性

| セクション間 | 整合状況 | 詳細 |
|------------|---------|------|
| Section 3 (複合キー設計) vs Section 4-1 (auto-yes-state.ts) | 一致 | buildCompositeKey/extractWorktreeId/extractCliToolId の配置先と関数仕様が整合 |
| Section 4-1 (シグネチャ変更表) vs Section 4-3 (API コード例) | **不一致** | setAutoYesEnabled のコード例が新シグネチャ (cliToolId 追加) を反映していない |
| Section 4-2 (poller 設計) vs Section 4-3 (API 設計) | 一致 | startAutoYesPolling/stopAutoYesPolling の呼び出し方針が整合 |
| Section 4-4 (cleanup 設計) vs Section 3 (byWorktree ヘルパー) | 一致 | byWorktree ヘルパーの使用方針が整合 |
| Section 6 (後方互換性) vs Section 4-3 (API 設計) | 一致 | current-output API の単一オブジェクト形式維持が両セクションで一貫 |
| Section 7 (セキュリティ) vs Section 4-1 (バリデーション) | 一致 | MF-001 のバリデーション戦略が両セクションで一貫 |
| Section 8 (パフォーマンス) vs Section 4-2 (ポーラー設計) | **軽微な不一致** | CLIToolType 数が4と記載されているが実際は5 |
| Section 11 (実装順序) vs Section 4 (バックエンド設計) | 一致 | Phase 1-5 の順序が依存関係と整合 |
| Section 13 (レビュー指摘サマリー) vs 各セクションの反映状況 | 一致 | MF-001, SF-001~003, C-001~004 の全てが該当セクションに反映済み |
| Section 14 (チェックリスト) vs Section 11 (実装順序) | 一致 | チェックリスト項目が実装順序の各 Phase に対応 |

---

## 3. 整合性検証: Issue #525 要件 vs 設計方針書

| Issue 要件 | 設計方針書の対応 | 整合状況 |
|-----------|---------------|---------|
| UIからエージェント毎にauto-yesを独立してON/OFF | Section 5: フロントエンド設計（Toggle/Dialog/Detail/Hook） | 一致 |
| 残り時間がエージェント毎に表示 | Section 5-1: AutoYesToggle.tsx の表示例 | 一致 |
| CLIの設定変更がUIにリアルタイム反映 | Section 4-3: current-output API が cliTool パラメータで絞り込み | 一致 |
| 複数エージェント同時auto-yes有効化 | Section 3: 複合キー設計、Section 4-2: 同一worktree複数ポーラー | 一致 |
| 既存auto-yes動作に影響なし | Section 6: 後方互換性テーブル、cliToolId デフォルト='claude' | 一致 |
| 確認ダイアログにエージェント名表示 | Section 5-1: AutoYesConfirmDialog.tsx | 一致 |
| セッション停止時の全エージェント分クリーンアップ | Section 4-4: session-cleanup.ts, resource-cleanup.ts | 一致 |
| DB永続化はスコープ外 | Section 1 スコープ: in-memory管理を維持 | 一致 |
| POST disable時のcliToolId指定/未指定分岐 | Section 4-3: POST コード例コメント | 一致 |
| GET APIのcliToolIdクエリパラメータ対応 | Section 4-3: GET コード例 | 一致 |
| worktree-status-helper.ts の修正 | Section 4-5: cliToolId毎ループ内で compositeKey 使用 | 一致 |
| resource-cleanup.ts の extractWorktreeId 対応 | Section 4-4: extractWorktreeId で分解して DB 照合 | 一致 |

---

## 4. 整合性検証: 設計方針書が前提とする既存実装の正確性

| 前提事項 | 設計方針書の記述 | 既存実装との照合 | 正確性 |
|---------|---------------|---------------|-------|
| auto-yes-state.ts が in-memory Map で管理 | Section 4-1: globalThis.__autoYesStates | auto-yes-state.ts L53-58 | 正確 |
| auto-yes-poller.ts が cliToolId を保持 | Section 2: ポーラーのMap構成 | auto-yes-poller.ts L52: cliToolId フィールド | 正確 |
| startAutoYesPolling が (worktreeId, cliToolId) を受け取る | Section 4-2 シグネチャ変更表 | auto-yes-poller.ts L524-526 | 正確 |
| useAutoYes が cliTool パラメータを持つ | Section 5-2 | useAutoYes.ts L28 | 正確 |
| CLI auto-yes --agent が対応済み | Section 6 後方互換性 | cli/commands/auto-yes.ts L23 | 正確 |
| API POST が cliToolId を受け付ける | Section 4-3 | auto-yes/route.ts L156-158 | 正確 |
| current-output API が cliTool クエリを使用 | Section 4-3 | current-output/route.ts L49-50 | 正確 |
| isValidWorktreeId による入力検証 | Section 7 セキュリティ | auto-yes-state.ts L12, L266 | 正確 |
| MAX_CONCURRENT_POLLERS = 50 | Section 8 | auto-yes-state.ts L334 | 正確 |
| session-cleanup.ts が CLI_TOOL_IDS でループ | Section 4-4 (暗黙の前提) | session-cleanup.ts L87 | 正確 |
| resource-cleanup.ts の cleanupOrphanedMapEntries | Section 4-4 | resource-cleanup.ts L215-270 | 正確 |
| 現在の getAutoYesState が `_request` で未使用 | Issue本文 Stage 7-8 SF-2 | auto-yes/route.ts L76: `_request` | 正確 |
| auto-yes-poller.ts の incrementErrorCount が disableAutoYes/stopAutoYesPolling を呼ぶ | Issue本文 実装タスク | auto-yes-poller.ts L186-188 | 正確 |
| worktree-status-helper.ts が getLastServerResponseTimestamp を呼ぶ | Section 4-5 | worktree-status-helper.ts L93 | 正確 |
| CLIToolType の数が4 | Section 8 | CLI_TOOL_IDS: 5ツール | **不正確** |

---

## 5. 詳細な指摘事項

### 5-1. Must Fix

#### CS-MF-001: setAutoYesEnabled のシグネチャ変更と auto-yes/route.ts POST コード例の不整合

設計方針書 Section 4-1 の関数シグネチャ変更表では、`setAutoYesEnabled` が `(worktreeId, cliToolId, enabled, duration?, stopPattern?)` に変更される。しかし Section 4-3 の POST コード例（下記箇所）では cliToolId が渡されていない。

```typescript
// Section 4-3 POST コード例（現状の記載）
const state = setAutoYesEnabled(
  params.id,
  body.enabled,  // ← cliToolId が抜けている
  body.enabled ? duration : undefined,
  body.enabled ? stopPattern : undefined
);
```

正しくは以下のようになるべきである。

```typescript
const state = setAutoYesEnabled(
  params.id,
  cliToolId,     // ← 追加
  body.enabled,
  body.enabled ? duration : undefined,
  body.enabled ? stopPattern : undefined
);
```

この不整合は実装者の混乱を招く可能性がある。

#### CS-MF-002: checkStopCondition の onStopMatched コールバックシグネチャの矛盾

設計方針書 Section 4-1 では `checkStopCondition` の第1引数が compositeKey に変更される。既存実装の `processStopConditionDelta`（auto-yes-poller.ts L308）では以下のように呼び出している。

```typescript
return checkStopCondition(worktreeId, newContent, stopAutoYesPolling);
```

`onStopMatched` コールバックとして `stopAutoYesPolling` を直接渡しており、`stopAutoYesPolling(worktreeId)` として呼ばれる。

設計方針書 Section 4-2 では `stopAutoYesPolling` の引数が compositeKey に変更される。したがって、`processStopConditionDelta` 内で `checkStopCondition(compositeKey, newContent, stopAutoYesPolling)` を呼ぶ場合、コールバック内で `stopAutoYesPolling(compositeKey)` が呼ばれることになり、整合性は取れる。

しかし、`checkStopCondition` 内部（auto-yes-state.ts L239）では `onStopMatched(worktreeId)` として呼んでおり、これが `onStopMatched(compositeKey)` に変わる必要がある。既存実装の `checkStopCondition` 内部では `disableAutoYes(worktreeId, 'stop_pattern_matched')` も呼んでいる（L238）が、`disableAutoYes` も `(worktreeId, cliToolId, reason?)` に変更される設計のため、compositeKey から worktreeId と cliToolId を分解して渡す処理が必要になる。

この一連の内部変更が設計方針書で十分に記述されていない。`checkStopCondition` 内部の `disableAutoYes` 呼び出しと `onStopMatched` 呼び出しの両方が compositeKey 対応になる点を明記すべきである。

### 5-2. Should Fix

#### CS-SF-001: startAutoYesPolling のIdempotencyチェック設計の不完全な記述

設計方針書 Section 4-2 のコード例では `existing?.timerId` チェックのみだが、既存実装（auto-yes-poller.ts L541-553）には以下のロジックがある。

1. 同じ cliToolId なら再利用（`{ started: true, reason: 'already_running' }`）
2. 異なる cliToolId なら既存ポーラーを停止して新規作成

compositeKey 化後は key に cliToolId が含まれるため、同じ compositeKey に対しては自動的に同一 cliToolId となり、ロジック2は発生しない。しかし、設計方針書のコード例がこの論理的な変化を説明していないため、実装者が既存の cliToolId 比較ロジックをどう扱うべきか（削除するのか維持するのか）が不明確である。

#### CS-SF-002: current-output/route.ts の compositeKey 生成コード例の型安全性

設計方針書 Section 4-3 で以下のコード例がある。

```typescript
const cliTool = request.nextUrl.searchParams.get('cliTool') ?? 'claude';
const compositeKey = buildCompositeKey(params.id, cliTool);
```

`searchParams.get()` の返り値は `string | null` であり、`?? 'claude'` でフォールバックされるが、`buildCompositeKey` の第2引数は `CLIToolType` 型である。`cliTool` が不正な文字列の場合、型エラーにはならないが論理的に不正な compositeKey が生成される。既存実装（current-output/route.ts L50）では `isCliTool()` でバリデーションしているが、設計方針書のコード例にはこのバリデーションが欠落している。

#### CS-SF-003: CLIToolType の数が設計方針書の「最大4」と既存実装の5ツールで不一致

CLI_TOOL_IDS は `['claude', 'codex', 'gemini', 'vibe-local', 'opencode']` の5ツールであり、設計方針書 Section 8 の「最大4」は不正確。影響は以下の通り。

- ポーラー数/worktree: 最大5（最大4ではない）
- Map エントリ数: N x 最大5
- MAX_CONCURRENT_POLLERS=50 での上限: 50/5 = 10 worktrees（12-13 ではない）

#### CS-SF-004: session-cleanup.ts の byWorktree ヘルパー導入方針と既存構造の差異

既存の session-cleanup.ts は CLI_TOOL_IDS でループしてセッション終了とレスポンスポーラー停止を行い、ループ外で auto-yes ポーラー停止と状態削除を行っている。設計方針書では `stopAutoYesPollingByWorktree()` と `deleteAutoYesStateByWorktree()` のヘルパーを使う設計だが、既存のループ構造内に auto-yes 停止処理を統合する代替案（各 cliToolId に対して個別に `stopAutoYesPolling(compositeKey)` を呼ぶ）との比較が記載されていない。byWorktree ヘルパーは Map 全体を走査するため、ループ内で個別に compositeKey 指定で停止する方が効率的な可能性がある。

### 5-3. Consider

#### CS-C-001: isValidCliTool 関数の重複定義

`auto-yes/route.ts` 内のローカル `isValidCliTool()` と `cli-tools/types.ts` の `isCliToolType()` が同等の機能を持つ。設計方針書 Section 3 で `extractCliToolId` 内で `isValidCliTool` を呼ぶ設計だが、どの定義を使うか未指定。`isCliToolType` に統一することを推奨する。

#### CS-C-002: disableAutoYes の内部呼び出し箇所への影響

`disableAutoYes(worktreeId, reason?)` は `auto-yes-state.ts` 内の `getAutoYesState`（期限切れ時 L92）と `setAutoYesEnabled`（無効化時 L124）から内部的に呼ばれている。シグネチャ変更 `(worktreeId, cliToolId, reason?)` 後、これらの内部呼び出し箇所でも cliToolId を渡す必要がある。しかし、これらの関数自体も既にシグネチャ変更される設計のため、整合性は取れると思われるが、設計方針書に内部依存の修正について明示的な言及がない。

#### CS-C-003: processStopConditionDelta の引数変更の未記載

`processStopConditionDelta` は worktreeId を引数に取るが、`checkStopCondition` が compositeKey を受け取るよう変更されるため、`processStopConditionDelta` の引数も変更が必要。設計方針書にこの変更が明記されていない。

#### CS-C-004: worktree-status-helper.ts の既存ループ構造との差異

既存実装では `getLastServerResponseTimestamp(worktreeId)` が cliToolId ループの外で1回だけ呼ばれている（L93）。設計方針書 Section 4-5 では cliToolId ループ内で compositeKey を使って呼ぶ設計だが、既存コードのループ構造（L69 の `allCliTools.map(async ...)`) 内での呼び出し位置が異なる。

---

## 6. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | コード例の不整合（CS-MF-001, CS-MF-002）により実装者が誤った呼び出しパターンを採用する | Medium | Medium | P1 |
| 技術的リスク | CLIToolType 数の誤記（CS-SF-003）による MAX_CONCURRENT_POLLERS の上限到達計算ミス | Low | Low | P2 |
| 技術的リスク | 内部関数の連鎖的シグネチャ変更（CS-C-002, CS-C-003）の漏れ | Medium | Low | P2 |
| セキュリティ | MF-001 バリデーション戦略は適切に設計されており、既存セキュリティ機構の維持も確認済み | Low | Low | P3 |
| 運用リスク | 後方互換性は適切に設計されており、CLI/UI 既存機能への影響は最小 | Low | Low | P3 |

---

## 7. 改善推奨事項

### 必須改善項目 (Must Fix)

1. **CS-MF-001**: Section 4-3 の POST コード例で `setAutoYesEnabled` に cliToolId 引数を追加する
2. **CS-MF-002**: Section 4-1 または Section 4-2 に、`checkStopCondition` 内部の `disableAutoYes` 呼び出しと `onStopMatched` コールバックが compositeKey 対応になる点を明記する

### 推奨改善項目 (Should Fix)

3. **CS-SF-001**: Section 4-2 の startAutoYesPolling コード例に、compositeKey 化により既存の cliToolId 比較ロジックが不要になる旨の注記を追加する
4. **CS-SF-002**: Section 4-3 の current-output コード例に isCliTool バリデーションを含める
5. **CS-SF-003**: Section 8 の CLIToolType 数を「最大5」に修正し、上限到達計算を更新する
6. **CS-SF-004**: Section 4-4 に session-cleanup.ts のループ内個別停止 vs byWorktree ヘルパーの比較検討を追記する

### 検討事項 (Consider)

7. **CS-C-001**: isValidCliTool / isCliToolType の統一方針を明記する
8. **CS-C-002**: disableAutoYes の内部呼び出し箇所の変更を Section 4-1 に明記する
9. **CS-C-003**: processStopConditionDelta の引数変更を設計方針書に追記する
10. **CS-C-004**: worktree-status-helper.ts の既存ループ構造との差異を注記する

---

## 8. 総合評価

設計方針書は Issue #525 の要件を網羅的にカバーしており、既存実装の前提事項も概ね正確である。Stage 1 レビューの指摘事項（MF-001, SF-001~003, C-001~004）は全て適切に反映されている。複合キー設計、byWorktree ヘルパー、バリデーション戦略、後方互換性、セキュリティ維持の各方面で一貫した設計判断がなされている。

主な課題は、Section 4-3 のコード例が Section 4-1 のシグネチャ変更を完全には反映していない点と、CLIToolType 数の誤記による数値計算のずれである。これらは設計方針書の修正で対応可能であり、設計の根幹には影響しない。

**Approval Status: conditionally_approved** -- Must Fix 2件の修正後、実装に進んで問題ない。

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-03-20*
*Focus: 整合性 (Consistency)*
*Design Document: dev-reports/design/issue-525-auto-yes-per-agent-design-policy.md*
