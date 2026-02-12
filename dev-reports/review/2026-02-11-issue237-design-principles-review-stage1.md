# Architecture Review: Issue #237 設計原則レビュー（Stage 1）

## Executive Summary

| 項目 | 内容 |
|------|------|
| **Issue** | #237 未使用コードの削除・リファクタリング |
| **Focus** | 設計原則（SOLID / KISS / YAGNI / DRY） |
| **Stage** | 1（通常レビュー） |
| **Status** | **Conditionally Approved** |
| **Score** | 4/5 |
| **Date** | 2026-02-11 |

設計方針書は設計原則の観点から高い品質を示している。未使用コード削除というリファクタリングの性質に適したアプローチが取られており、SOLID / KISS / YAGNI / DRY の全原則に対して適切な判断がなされている。条件付き承認とした理由は、設計文書の正確性に関する軽微な指摘（1件）があるためである。

---

## 1. SOLID原則準拠レビュー

### 1-1. 単一責任原則（SRP） -- Score: 5/5 PASS

削除対象の各モジュールは明確な責任を持っており、削除によって残存モジュールの責任がより明確になる。

| モジュール | 責任 | 削除後の影響 |
|-----------|------|-------------|
| `claude-poller.ts` | Claude専用ポーリング | `response-poller.ts` に統一。SRP向上 |
| `terminal-websocket.ts` | WebSocketブリッジ | 完全デッドコード。影響なし |
| `WorktreeDetail.tsx` | Worktree詳細UI | `WorktreeDetailRefactored.tsx` に統一。SRP向上 |
| `SimpleTerminal.tsx` | 簡易ターミナルUI | xterm.jsベース Terminal で代替済み |
| `simple-terminal/page.tsx` | ルートページ | 上記に伴い不要 |

特に `claude-poller.ts`（401行）と `response-poller.ts` が同じ「ポーリング」責任を持つ状態が解消されることは、SRPの観点から大きな改善である。

`session-cleanup.ts` は Facade パターンとしてポーラー停止を統括しているが、claude-poller 削除後は response-poller と auto-yes-poller の2つのみを管理する形になり、責任範囲が適切に縮小される。設計方針書ではJSDocの更新も含まれており（セクション4-1）、ドキュメントと実装の一致が保たれる。

### 1-2. 開放閉鎖原則（OCP） -- Score: 4/5 PASS

削除作業は既存の拡張ポイントに影響を与えない。

- `manager.ts` の `stopPollers` メソッド: claude-poller 固有の条件分岐（`if (cliToolId === 'claude')`）が削除されるが、response-poller の停止機能は維持される
- CLI Tool Strategy パターン（`ClaudeTool`, `CodexTool`, `GeminiTool`）: 影響なし。各Strategyの実装は claude-poller に依存していない
- `session-cleanup.ts` の `KillSessionFn` 型: 依存性注入ポイントとして維持される

```typescript
// manager.ts 削除後の stopPollers（設計方針書セクション4-2による）
stopPollers(worktreeId: string, cliToolId: CLIToolType): void {
  stopResponsePolling(worktreeId, cliToolId);
  // claude-poller 固有の条件分岐が削除される
}
```

### 1-3. リスコフの置換原則（LSP） -- Score: 5/5 PASS（該当なし）

削除対象に継承関係は存在しない。CLITool の Strategy パターンはインターフェース（`ICLITool`）ベースであり、型契約への影響はない。

### 1-4. インターフェース分離原則（ISP） -- Score: 5/5 PASS

`claude-poller.ts` は4つの関数をエクスポートしていた:

| エクスポート | 外部使用 | 状況 |
|-------------|---------|------|
| `startPolling()` | 0箇所 | 未使用 |
| `stopPolling()` | 2箇所（session-cleanup.ts, manager.ts） | 使用中 |
| `stopAllPolling()` | 0箇所 | 未使用 |
| `getActivePollers()` | 0箇所 | 未使用 |

4つのエクスポートのうち実際に使用されているのは `stopPolling` のみ。これはモジュールが過剰なインターフェースを公開していた証拠であり、削除によってISP違反状態が解消される。`response-poller.ts` の同名関数群が正式なインターフェースとして機能する。

### 1-5. 依存性逆転原則（DIP） -- Score: 4/5 PASS

`session-cleanup.ts` は `KillSessionFn` 型を通じた依存性注入パターンを使用しており、高レベルモジュールが低レベルモジュールの具象実装に直接依存することを避けている:

```typescript
type KillSessionFn = (worktreeId: string, cliToolId: CLIToolType) => Promise<boolean>;
```

この設計はclaude-poller削除後も維持される。

一方、`manager.ts` は `response-poller` と `claude-poller` への直接importによる具象依存を持っているが、これは本Issueでclaude-pollerへの依存が除去されることで改善する。

---

## 2. KISS原則準拠レビュー -- Score: 5/5 PASS

### 評価ポイント

1. **スコープの適切な制限**: 高優先度の明確な削除対象5ファイルに限定し、低優先度の未使用コードは別Issueに先送りしている。この判断はKISS原則に完全に準拠

2. **段階的削除手順**: 4フェーズ（テスト修正 -> 参照除去 -> ファイル削除 -> ドキュメント更新）は各ステップを単純に保ちながら安全性を確保する妥当な設計

3. **検証ポイントの明示**: 各フェーズに具体的な検証コマンドが記載されている
   - フェーズ1: `npm run test:unit && npm run test:integration`
   - フェーズ2: `npx tsc --noEmit && npm run test:unit && npm run test:integration`
   - フェーズ3: `npm run build && npm run test:unit && npm run test:integration && npm run lint`

4. **過度な複雑さの回避**: 「段階的PR分割」案を不採用としている判断は、レビュー負荷の増加を避けるKISSの実践

---

## 3. YAGNI原則準拠レビュー -- Score: 5/5 PASS

### 評価ポイント

1. **barrel export追加見送り（セクション7）**: `WorktreeDetailRefactored` のbarrel export追加を見送る判断は、YAGNI原則の模範的適用。`worktrees/[id]/page.tsx` が直接importしており、barrel経由にする技術的理由がない

2. **空ファイル化案の棄却（セクション7）**: `claude-poller.ts`を空ファイルとして残す互換性維持案を不採用としている。デッドコード残存を避ける正しい判断

3. **不要なフォールバック排除**: `simple-terminal`をxterm.jsベースTerminalのフォールバックとして残す選択肢を排除している。xterm.jsベースTerminalが完全に代替済みであることが確認されている

4. **テストケース復元なし**: 削除対象コードのテストを復元しない判断。検証対象が存在しないテストを維持する意味はなく、YAGNI原則に準拠

---

## 4. DRY原則準拠レビュー -- Score: 5/5 PASS

### 評価ポイント

本Issue自体がDRY原則の実践そのものである:

1. **ポーリング機能の重複解消**: `claude-poller.ts`（401行）と `response-poller.ts` がほぼ同一の責任を持つ状態を解消。`response-poller.ts` が Issue #193 で完全な後継として実装され、claude-poller の機能を完全にカバーしている

2. **UIコンポーネントの重複解消**: `WorktreeDetail.tsx`（937行）と `WorktreeDetailRefactored.tsx` の重複を解消。`page.tsx` が `WorktreeDetailRefactored` のみをimportしている現状が確認できる:

```typescript
// src/app/worktrees/[id]/page.tsx L10
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
```

3. **ターミナル実装の重複解消**: `SimpleTerminal.tsx`（253行）+ `simple-terminal/page.tsx`（91行）をxterm.jsベースTerminalに統一

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | テスト修正漏れによるCI失敗 | Low | Low | P3 |
| 技術的リスク | 未検出の参照残存 | Low | Low | P3 |
| セキュリティ | 影響なし（内部モジュール削除のみ） | - | - | - |
| 運用リスク | 影響なし（未使用コード削除のみ） | - | - | - |

全リスクがLowである理由:
- 全削除対象は未使用コードであり、実行パスに含まれていない
- `claude-poller.ts` 内のTODOコメント自体が「this code path is unreachable」と明記
- 4フェーズ段階的削除で各段階での検証が計画されている
- テスト先行修正により、削除前のテスト整合性が確保される

---

## 6. 指摘事項

### 6-1. 必須改善項目（Must Fix）: 1件

#### MF-001: simple-terminal リンク参照の記載漏れ

**原則**: DRY（ドキュメント正確性）

**内容**: 設計方針書セクション3-4で `simple-terminal/page.tsx` の参照元を「ルーティングのみ（Next.js App Routerの自動ルート）」と記載しているが、実際には `WorktreeDetail.tsx` からも参照がある。

**根拠**:
```typescript
// src/components/worktree/WorktreeDetail.tsx L652
<Link href={`/worktrees/${worktreeId}/simple-terminal`}>

// src/components/worktree/WorktreeDetail.tsx L678
<Link href={`/worktrees/${worktreeId}/simple-terminal`}>
```

`WorktreeDetail.tsx` 自体がフェーズ3で同時に削除されるため実装上の問題はない。しかし設計文書の正確性の観点で、参照元に `WorktreeDetail.tsx (L652, L678) -- 同時削除対象` を追記すべき。

**影響度**: Low（実装に影響なし。ドキュメント正確性の問題）

### 6-2. 推奨改善項目（Should Fix）: 2件

#### SF-001: manager.ts L179 のコメント削除漏れ

**原則**: YAGNI

**内容**: `manager.ts` L179 に `// Future: Add other tool-specific pollers here if needed` というコメントがあるが、claude-poller の条件分岐削除後にこのコメントは不適切になる。

```typescript
// src/lib/cli-tools/manager.ts L175-179（現状）
    // claude-poller is Claude-specific
    if (cliToolId === 'claude') {
      stopClaudePolling(worktreeId);
    }
    // Future: Add other tool-specific pollers here if needed
```

設計方針書ではL175-178の削除のみ記載されているが、L179のコメントも削除対象に含めるべき。このコメントはYAGNI原則に反する「将来の拡張示唆」であり、削除後のコードに残すべきではない。

**推奨対応**: セクション4-2の削除範囲をL175-179に拡張

#### SF-002: 内部ドキュメントの claude-poller 参照

**原則**: DRY

**内容**: `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` の L456, L589, L1137 に `claude-poller.ts` への参照が残存する。設計方針書のドキュメント更新対象が `architecture.md` のみとなっている。

**推奨対応**: 本Issueの対象外とする場合は、設計方針書に「内部設計ドキュメント（PROMPT_HANDLING_IMPLEMENTATION_PLAN.md等）の更新は別途対応」と明記する。または対象に含める。

### 6-3. 検討事項（Consider）: 2件

#### CS-001: WorktreeDetailRefactored の barrel export

**原則**: KISS

`index.ts` から `WorktreeDetail` のexportを削除した後、barrel exportファイルに `WorktreeDetailRefactored` が含まれないことになる。設計方針書のYAGNI判断は現時点で妥当。将来のIssueでコンポーネント再構成を行う際に検討事項として記録しておく。

#### CS-002: session-cleanup.ts のJSDoc

**原則**: SRP

claude-poller 削除後、session-cleanup.ts のJSDoc「差異を抽象化する」という記述は実態と合わなくなる。設計方針書のセクション4-1で適切なJSDoc更新が含まれており、追加対応は不要。

---

## 7. 設計原則総合評価

| 原則 | Score | 判定 | 根拠 |
|------|-------|------|------|
| SRP | 5/5 | PASS | 重複責任の解消。各モジュールの責任が明確化 |
| OCP | 4/5 | PASS | 既存拡張ポイントへの影響なし |
| LSP | 5/5 | PASS | 継承関係なし。型契約への影響なし |
| ISP | 5/5 | PASS | 過剰なインターフェース公開の解消 |
| DIP | 4/5 | PASS | KillSessionFn 依存性注入パターン維持 |
| KISS | 5/5 | PASS | スコープ制限、段階的手順、検証ポイント明示 |
| YAGNI | 5/5 | PASS | barrel export見送り、空ファイル化棄却 |
| DRY | 5/5 | PASS | ポーリング・UIコンポーネント・ターミナルの重複解消 |

**総合Score: 4/5 -- Conditionally Approved**

条件:
- MF-001 の設計文書修正を実施すること（simple-terminal リンク参照の記載追加）

---

## 8. 結論

Issue #237 の設計方針書は、リファクタリング（未使用コード削除）という目的に対して、設計原則の観点から非常に高い品質を示している。特に以下の点が優れている:

1. **YAGNI原則の厳格な適用**: 不要な追加作業（barrel export、空ファイル化、段階的PR分割）を適切に棄却
2. **KISS原則に基づく段階的アプローチ**: 4フェーズの削除手順で安全性とシンプルさを両立
3. **DRY原則の本質的な実践**: 重複コードの除去そのものがDRY原則の適用

軽微な設計文書の正確性に関する指摘（MF-001）を修正すれば、実装に着手して問題ない。

---

*Generated by architecture-review-agent for Issue #237*
*Date: 2026-02-11*
