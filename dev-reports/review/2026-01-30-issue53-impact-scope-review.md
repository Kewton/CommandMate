# Architecture Review Report: Issue #53 Impact Scope Analysis

**Issue**: #53 - Assistant応答の保存ロジックを「次のユーザー入力まで」方式に変更
**Review Stage**: 3 (影響分析レビュー)
**Focus Area**: 影響範囲
**Date**: 2026-01-30
**Status**: Approved

---

## Executive Summary

Issue #53の設計書に対する影響範囲（Impact Scope）レビューを完了しました。設計書は変更の影響範囲を適切かつ網羅的に分析しており、リスクは全て特定・軽減されています。

| 評価項目 | 結果 |
|---------|------|
| 直接影響ファイル | 3ファイル |
| 間接影響ファイル | 6ファイル以上 |
| API後方互換性 | 維持 |
| DBスキーマ変更 | なし |
| パフォーマンス影響 | 軽微 |
| 総合リスク | 低 |

---

## 1. 影響範囲分析

### 1.1 直接変更対象ファイル

| ファイル | 変更種別 | 影響度 | 説明 |
|---------|---------|--------|------|
| `src/lib/assistant-response-saver.ts` | 新規作成 | 高 | 保存ロジック集約モジュール |
| `src/app/api/worktrees/[id]/send/route.ts` | 修正 | 高 | savePendingAssistantResponse呼び出し追加 |
| `src/lib/response-poller.ts` | 修正 | 中 | 重複保存防止ロジック追加 |

### 1.2 間接影響ファイル（変更なし）

| ファイル | 影響種別 | 説明 |
|---------|---------|------|
| `src/lib/db.ts` | 依存 | 既存DB操作関数を再利用 |
| `src/lib/cli-session.ts` | 依存 | captureSessionOutput()を利用 |
| `src/lib/ws-server.ts` | 依存 | broadcastMessage()を利用 |
| `src/lib/cli-patterns.ts` | 依存 | stripAnsi()を利用 |
| `src/types/models.ts` | 依存 | ChatMessage型を利用 |
| フロントエンド全般 | 間接影響 | データ品質向上による恩恵 |

### 1.3 影響フロー図

```
[User sends message]
        |
        v
[POST /api/worktrees/:id/send] <-- 直接変更
        |
        +---> [savePendingAssistantResponse()] <-- 新規作成
        |           |
        |           +---> captureSessionOutput() (依存)
        |           +---> cleanCliResponse() / extractAssistant...() (新規)
        |           +---> createMessage() (依存)
        |           +---> broadcastMessage() (依存)
        |
        +---> [startPolling()]
                    |
                    v
              [checkForResponse()] <-- 修正（重複防止追加）
                    |
                    +---> lastCapturedLine チェック
                    +---> Race condition 再チェック
```

---

## 2. API影響分析

### 2.1 POST /api/worktrees/:id/send

| 項目 | 状態 |
|------|------|
| 破壊的変更 | なし |
| 後方互換性 | 維持 |
| レスポンス形式 | 変更なし |

**内部処理フローの変更点**:
1. タイムスタンプ生成が先に実行される
2. savePendingAssistantResponse()が呼び出される
3. その後、既存の処理が継続

### 2.2 GET /api/worktrees/:id/messages

| 項目 | 状態 |
|------|------|
| 破壊的変更 | なし |
| 後方互換性 | 維持 |

**注意**: Assistant応答がより確実に保存されるため、返却されるメッセージ数が増加する可能性があります（正常動作）。

---

## 3. データベース影響分析

### 3.1 スキーマ変更

**変更なし** - 既存のテーブル構造を維持

### 3.2 データ変更

| テーブル | 影響 |
|---------|------|
| `chat_messages` | assistantロールのレコード数増加（正常動作） |
| `session_states` | last_captured_lineの役割変更（スキーマ変更なし） |

### 3.3 マイグレーション

**不要**

---

## 4. パフォーマンス影響分析

### 4.1 レイテンシ

| 処理 | 影響 | 重大度 |
|------|------|--------|
| メッセージ送信 | tmuxキャプチャ（10-50ms）追加 | 低 |

### 4.2 リソース使用

| リソース | 影響 | 重大度 |
|---------|------|--------|
| CPU | 重複チェックのオーバーヘッド | 無視できる |
| ストレージ | メッセージ保存増加 | 低 |

---

## 5. リスク評価

### 5.1 特定されたリスク

| ID | リスク | 発生確率 | 影響度 | 対策状況 |
|----|--------|----------|--------|----------|
| R1 | Race condition（競合状態） | 低 | 低 | 軽減済み |
| R2 | バッファリセット誤検出 | 低 | 中 | 軽減済み |
| R3 | タイムスタンプ順序問題 | 極低 | 低 | 受容 |
| R4 | DB容量増大 | 中 | 低 | 受容 |

### 5.2 軽減策

**R1: Race condition対策**
```typescript
// response-poller.ts
const currentSessionState = getSessionState(db, worktreeId, cliToolId);
if (currentSessionState && result.lineCount <= currentSessionState.lastCapturedLine) {
  console.log(`[checkForResponse] Race condition detected, skipping save`);
  return false;
}
```

**R2: バッファリセット検出**
```typescript
// assistant-response-saver.ts
export function detectBufferReset(
  currentLineCount: number,
  lastCapturedLine: number
): { bufferReset: boolean; reason: 'shrink' | 'restart' | null }
```

---

## 6. 設計書カバレッジ評価

### 6.1 影響範囲セクションの評価

| 評価項目 | 状態 |
|---------|------|
| セクション存在 | あり（セクション9） |
| 完全性 | 完全 |
| ギャップ | なし |

### 6.2 強み

- 変更対象ファイルが明確にリストアップされている
- 影響度（高/低）が各ファイルに対して評価されている
- 影響を受けないファイルも明示的に記載されている
- 後続Issue（#54, #59）での改善事項が設計書に反映済み

---

## 7. Findings

### 7.1 Must Fix (0件)

なし

### 7.2 Should Fix (2件)

#### SF-1: パフォーマンス影響の定量的評価を設計書に追記

**カテゴリ**: ドキュメント
**優先度**: 中
**工数**: 低

設計書のセクション9に、パフォーマンス影響（tmuxキャプチャによるlatency増加、DB容量増加）の定量的評価を追記することを推奨します。

#### SF-2: フロントエンドへの間接影響を明記

**カテゴリ**: ドキュメント
**優先度**: 低
**工数**: 低

設計書のセクション9.2「影響を受けないファイル」に、フロントエンドがUIの変更なしにデータ品質向上の恩恵を受けることを明記することを推奨します。

### 7.3 Nice to Have (2件)

#### NH-1: メッセージアーカイブ/削除機能の検討

将来的にメッセージのアーカイブまたは古いメッセージの自動削除機能を検討。

#### NH-2: 重複保存検出のメトリクス収集

Race conditionによるスキップ発生頻度をログから分析できるよう、将来的にメトリクス収集を検討。

---

## 8. 総合評価

| 項目 | 評価 |
|------|------|
| 総合リスク | 低 |
| 承認状態 | **Approved** |

設計書の影響範囲分析は適切かつ網羅的です。直接変更対象3ファイル、間接影響6ファイル以上を正確に特定しています。APIの後方互換性は維持され、DBスキーマ変更も不要です。パフォーマンス影響は軽微であり、リスクは全て適切に特定・軽減されています。

設計原則レビュー（Stage 1）および整合性レビュー（Stage 2）の結果も設計書に反映済みであり、影響分析の観点からも承認可能な状態です。

---

## 9. レビュー対象ファイル

- `dev-reports/design/issue53-assistant-response-save-design-policy.md`
- `src/lib/assistant-response-saver.ts`
- `src/app/api/worktrees/[id]/send/route.ts`
- `src/lib/response-poller.ts`
- `src/lib/db.ts`
- `src/lib/__tests__/assistant-response-saver.test.ts`

---

**Reviewed by**: Architecture Review Agent
**Date**: 2026-01-30
