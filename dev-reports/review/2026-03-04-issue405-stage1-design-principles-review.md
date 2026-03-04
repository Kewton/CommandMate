# Architecture Review Report: Issue #405 - Stage 1 (Design Principles)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #405 |
| Stage | 1 - Design Principles |
| Status | Conditionally Approved |
| Score | 4 / 5 |
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 5 |

Issue #405 の設計方針書（tmux capture最適化）に対する設計原則レビューを実施した。全体として設計品質は高く、KISS原則に基づくキャッシュ設計、ICLIToolインターフェース非変更によるSOLID適合、既存globalThisパターンとの一貫性が評価できる。must_fixは1件（ClaudeToolのHealthCheck統合設計の具体化不足）のみ。

---

## Review Target

- **Design Document**: `dev-reports/design/issue-405-tmux-capture-optimization-design-policy.md`
- **Focus Area**: SOLID / KISS / YAGNI / DRY / Design Patterns / Module Design

---

## Detailed Findings

### Must Fix (1 item)

#### DR1-005: ClaudeToolのisRunning() HealthCheckとlistSessions()一括判定の整合性が未定義

- **Category**: Module Design
- **Affected Section**: 3.3 isRunning()最適化（listSessions一括取得）

**Problem**: 設計書セクション3.3で「ClaudeToolのisRunning()はHealthCheck付き。listSessions()による存在確認後、Claude Sessionのみ追加のHealthCheckが必要」と注意書きがあるが、具体的な実装パスが記載されていない。

現在のコードでは `ClaudeTool.isRunning()` は `isClaudeRunning()` を呼び出し、内部で `hasSession()` + `isSessionHealthy()` の2段階チェックを行う:

```typescript
// src/lib/claude-session.ts (L493-507)
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) {
    return false;
  }
  const result = await isSessionHealthy(sessionName);
  if (!result.healthy) {
    console.warn(`[isClaudeRunning] Session ${sessionName} unhealthy: ${result.reason}`);
    return false;
  }
  return true;
}
```

listSessions()一括取得に置き換えた場合、Claudeセッションだけ追加のHealthCheckを呼ぶ分岐が必要になるが、その具体的なフローが未定義。

**Suggestion**: セクション3.3に以下の擬似コードを追加すべき:

```typescript
// Phase 3の具体的な実装フロー
for (const cliToolId of allCliTools) {
  const sessionName = cliTool.getSessionName(worktree.id);
  let isRunning = sessionNames.has(sessionName);

  // Claude専用HealthCheck: listSessionsで存在確認後のみ実行
  if (isRunning && cliToolId === 'claude') {
    const health = await isSessionHealthy(sessionName);
    if (!health.healthy) {
      isRunning = false; // route.tsではセッション再作成しない
    }
  }
  // ... capture & status detection
}
```

---

### Should Fix (4 items)

#### DR1-001: TmuxCaptureCacheモジュールが複数の責務を持つ（SRP懸念）

- **Category**: SOLID (SRP)
- **Affected Section**: 3.1 tmux captureキャッシュモジュール

`tmux-capture-cache.ts` は (1) TTLベースキャッシュ管理、(2) singleflightパターン、(3) eviction戦略 の3つの責務を内包する。現時点のコード量では問題にならないが、singleflightパターンは汎用ユーティリティとして他モジュール（schedule-manager.ts等）でも利用可能であり、将来的な分離可能性をコメントで明記すべき。

#### DR1-002: B案キャッシュ無効化の漏れリスク

- **Category**: DRY
- **Affected Section**: 3.4 キャッシュ無効化設計

8箇所以上にinvalidateCache()を個別挿入する設計は、新規CLIツール追加時の漏れリスクがある。追加の安全策として:

1. CLAUDE.mdにinvalidateCache()呼び出し箇所のチェックリストを追記
2. `sendKeysAndInvalidate()` のような薄いラッパー関数の作成をPhase 4実装時に再評価

ラッパー案はC案（ラッパー層）の軽量版であり、8箇所の分散をDRYに集約できる可能性がある。

#### DR1-004: captureSessionOutput()内部でのキャッシュ統合とOCP

- **Category**: SOLID (OCP)
- **Affected Section**: 3.2 captureSessionOutput()の変更

キャッシュロジック直接埋め込みはインターフェース非変更のメリットが大きく、正当化される。ただし、将来的なDI移行の余地を残すため、fetchFnコールバックパターンの拡張可能性を意識した構造を推奨。

#### DR1-008: captureSessionOutputFresh()の設計が未定義

- **Category**: Module Design
- **Affected Section**: 3.4.3 prompt-response APIのキャッシュバイパス

セクション3.4.3で言及される`captureSessionOutputFresh()`がインターフェース設計に含まれていない。以下のいずれかを明記すべき:

- **(A)** `captureSessionOutput()` にoptionsの `{ bypassCache: true }` を追加（インターフェース変更あり）
- **(B)** `captureSessionOutputFresh()` を別関数として新設し、内部で `capturePane()` 直接呼び出し + `setCachedCapture()` 書き戻し

(B)案が推奨される。既存テストへの影響を回避できるため。

---

### Nice to Have (5 items)

#### DR1-003: singleflightパターンのYAGNI検証

singleflightの実装コストは低い（10-15行）ためYAGNI違反とまでは言えないが、Phase 1で効果を計測してから追加する段階的アプローチも検討に値する。

#### DR1-006: globalThisパターンの一貫性は良好

既存の `__autoYesStates`, `__scheduleManagerStates`, `__versionCheckCache` と一貫した方式。将来的にglobalThisキー一覧のドキュメント化を推奨するが、Issue #405時点では不要。

#### DR1-007: CACHE_MAX_CAPTURE_LINES=10000の一律保持はKISS適合

A案は呼び出し元の行数差異をsliceで解決する単純な設計であり、優れた判断。

#### DR1-009: session-cleanup.tsのclearAllCache()追加はFacade適合

既存のFacadeパターンとの整合性が高く、問題なし。

#### DR1-010: ICLIToolインターフェース非変更はLSP/ISP適合

各CLITool実装への影響なし、不要なメソッド追加なし。優れた設計判断。

#### DR1-011: capture/route.tsのhasSession()最適化漏れ

キャッシュ対象外の判断自体は妥当だが、hasSession()がlistSessions()キャッシュの恩恵を受けない点をセクション3.5に補足説明として記載すべき。

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical | Medium | ClaudeToolのHealthCheck統合の具体設計が未定義であり、実装時に設計判断が必要。singleflightの効果が不確定。 |
| Security | Low | キャッシュ層はTTL=2秒で自動失効、CACHE_MAX_ENTRIES=100でDoS防止。既存execFile()ベースのセキュリティ機構に影響なし。 |
| Operational | Low | graceful shutdownでの全キャッシュクリア、テスト用リセット関数が設計済み。メモリ上限20MBは許容範囲。 |

---

## Design Principles Checklist

| Principle | Assessment | Notes |
|-----------|------------|-------|
| Single Responsibility (SRP) | Acceptable with note | tmux-capture-cache.tsに複数責務あるが、現規模では許容。DR1-001参照。 |
| Open/Closed (OCP) | Good | captureSessionOutput()内部変更のみでインターフェース非変更。DR1-004は将来改善。 |
| Liskov Substitution (LSP) | Excellent | ICLITool実装クラスへの影響なし。 |
| Interface Segregation (ISP) | Excellent | ICLIToolに不要メソッド追加なし。 |
| Dependency Inversion (DIP) | Good | fetchFnコールバックパターンで上位依存を回避。 |
| KISS | Excellent | A案（最大行数キャッシュ+slice）は最も単純な解法。 |
| YAGNI | Good | singleflightは軽量だが定量的根拠が弱い。DR1-003参照。 |
| DRY | Acceptable with note | B案無効化の分散はDRY弱点だが、循環依存回避とのトレードオフ。DR1-002参照。 |

---

## Improvement Recommendations

### Required (Before Implementation)

1. **DR1-005**: セクション3.3にClaudeTool HealthCheck統合の具体的な実装擬似コードを追加

### Recommended (During Implementation)

2. **DR1-008**: `captureSessionOutputFresh()` の関数定義をセクション3.1.1に追加
3. **DR1-002**: Phase 4実装時にラッパー関数による無効化集約を再評価
4. **DR1-001**: singleflight部分に将来分離可能性のコメントを記載
5. **DR1-004**: getOrFetchCapture()のDI拡張余地を意識した構造

### Future Consideration

6. **DR1-006**: globalThisキー一覧のドキュメント化（5キー以上になった時点）
7. **DR1-003**: singleflight効果のベンチマーク検証
8. **DR1-011**: capture/route.tsのhasSession()に関する補足説明

---

## Approval Status

**Conditionally Approved** - DR1-005（ClaudeTool HealthCheck統合の具体設計）を設計書に反映した上で実装に進むことを推奨する。その他のshould_fix項目は実装フェーズでの対応で問題ない。

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-03-04*
*Target: Issue #405 - tmux capture optimization design policy*
