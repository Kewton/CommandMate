# Architecture Review: Issue #193 - 設計原則レビュー (Stage 1)

**Issue**: #193 - Claude Code複数選択肢プロンプト検出
**Focus**: 設計原則 (SOLID, KISS, YAGNI, DRY)
**Status**: Conditionally Approved
**Score**: 4/5
**Date**: 2026-02-08
**Reviewer**: Architecture Review Agent

---

## Executive Summary

Issue #193の設計方針書は、Claude Codeの複数選択肢プロンプト検出問題に対して、`DetectPromptOptions` interfaceによるパラメータ化アプローチを採用している。全体的に設計原則への準拠は良好であり、特にOCP（Open-Closed Principle）に基づくinterface設計とISP（Interface Segregation Principle）に準拠したoptionalフィールド設計が優れている。

主要な改善点として、DRY原則に関する1件のMust Fix項目（`cliToolId === 'claude'`判定パターンの6箇所分散）が存在する。ヘルパー関数の導入により解消可能であり、設計全体の承認を妨げるものではない。

---

## Detailed Findings

### 1. SOLID原則

#### 1.1 SRP (Single Responsibility Principle) -- Pass (with notes)

**評価**: 良好

`prompt-detector.ts`のCLIツール非依存性原則（Issue #161で確立）が維持されている点は高く評価できる。`detectPrompt()`は「出力テキストからプロンプトを検出する」という単一責務に集中し、どのCLIツールかの判断は呼び出し元に委譲している。

しかし、設計書では`status-detector.ts`が「内部でcliToolIdからoptionsを構築」すると記載されている。現在の`status-detector.ts`（L87）の`detectPrompt(lastLines)`呼び出しを`detectPrompt(lastLines, promptOptions)`に変更する際、options構築ロジック（`cliToolId === 'claude'`判定）がこのモジュールに埋め込まれる。

```typescript
// status-detector.ts L87 (設計書記載の変更)
const promptOptions = cliToolId === 'claude' ? { requireDefaultIndicator: false } : undefined;
const promptDetection = detectPrompt(lastLines, promptOptions);
```

`status-detector.ts`は既にcliToolIdを受け取っているため自然な拡張だが、「どのCLIツールでどのオプションを使うか」という知識がモジュール内に分散する。後述のMF-001（ヘルパー関数）で解消可能。

#### 1.2 OCP (Open-Closed Principle) -- Pass

**評価**: 優秀

`DetectPromptOptions` interfaceの設計はOCPに良く準拠している。

```typescript
export interface DetectPromptOptions {
  requireDefaultIndicator?: boolean;
}
```

- **拡張に開いている**: 新しいフィールドを追加することで、既存コードに影響を与えずに検出動作をカスタマイズ可能
- **変更に閉じている**: デフォルト値`true`により、既存の全呼び出し元は変更不要（`options`引数なしで従来動作を維持）
- **後方互換性**: `detectPrompt(output)`（引数1つ）の呼び出しが引き続き有効

`requireDefaultIndicator`フラグがPass 1とLayer 4の2つの独立した関心事を同時に制御している点（SF-001）は、現時点では実用的な判断として妥当。将来的にきめ細かい制御が必要になった場合のinterface拡張パスも確保されている。

#### 1.3 LSP (Liskov Substitution Principle) -- Not Applicable

継承関係が変更対象に含まれていないため、評価対象外。

#### 1.4 ISP (Interface Segregation Principle) -- Pass

**評価**: 良好

`DetectPromptOptions`は単一のoptionalフィールドで構成されており、呼び出し元は必要な場合のみオプションを指定すればよい。不要なインターフェースの実装を強制しない設計。

```typescript
// Claude Code呼び出し元: 明示的にオプション指定
detectPrompt(output, { requireDefaultIndicator: false });

// Codex/Gemini呼び出し元: オプション指定不要
detectPrompt(output);
```

#### 1.5 DIP (Dependency Inversion Principle) -- Pass

**評価**: 良好

`prompt-detector.ts`は`CLIToolType`型に一切依存せず、抽象的な`DetectPromptOptions`インターフェースのみに依存する。これはIssue #161で確立された「CLIツール非依存性原則」を忠実に維持している。

依存関係の方向:
```
呼び出し元 (route.ts, auto-yes-manager.ts 等)
  -> CLIToolType (具体)
  -> DetectPromptOptions (抽象)
  -> detectPrompt() (prompt-detector.ts)
     -> DetectPromptOptions (抽象のみ)
```

---

### 2. KISS原則 -- Pass (with notes)

**評価**: 良好

設計全体は適切にシンプルに保たれている。

**良い点**:
- 単一のbooleanフラグで2つのゲート（Pass 1, Layer 4）を制御するアプローチは、過度な抽象化を避けた実用的な設計
- 既存の多層防御構造（Layer 1-4）を壊さず、最小限の条件分岐追加で対応
- optionalパラメータにより、関心のない呼び出し元は一切変更不要

**改善余地** (C-003):
設計書のコード例における `options?.requireDefaultIndicator !== false` は二重否定に近い表現で可読性がやや低い。

```typescript
// 現在の設計書の記載
if (options?.requireDefaultIndicator !== false) {
  // ❯存在チェック
}

// 推奨: 意図を明確にする変数代入
const requireDefault = options?.requireDefaultIndicator ?? true;
if (requireDefault) {
  // ❯存在チェック
}
```

---

### 3. YAGNI原則 -- Pass (with notes)

**評価**: 概ね良好

**良い点**:
- Phase 1調査で最も可能性の高いケースB（パラメータ化）のみを実装し、ケースA/Cは実装しない判断はYAGNI準拠
- `DetectPromptOptions`に将来的に必要になるかもしれないフィールドを先行追加していない

**懸念点** (C-001):
`claude-poller.ts`の到達不能コード2箇所（L164, L232）への修正がP2として計画されている。設計書にも「到達不能コード、一貫性のため」と明記されている。

到達不能コードの修正は実行時に影響を与えず、コード品質の一貫性のためだけの変更である。厳密なYAGNI解釈では「実行されないコードへの投資」に該当する。ただし:

- P2（最低優先度）として位置づけられている
- 「一貫性のため」という合理的な理由がある
- 変更自体は機械的で低リスク

これらを考慮すると、設計書の判断は現実的に妥当である。ただし、到達不能コードであること自体をコメントで明示するか、claude-poller.ts廃止時にまとめて対応する方が効率的。

---

### 4. DRY原則 -- Needs Improvement

**評価**: 要改善（1件のMust Fix）

#### MF-001: cliToolId === 'claude' 判定パターンの6箇所分散

設計書のSection 4.4に示されているパターンが6箇所で繰り返される。

```typescript
// このパターンが6ファイルに分散
const promptOptions = cliToolId === 'claude' ? { requireDefaultIndicator: false } : undefined;
const promptCheck = detectPrompt(cleanOutput, promptOptions);
```

変更対象:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts`
2. `src/lib/auto-yes-manager.ts`
3. `src/lib/status-detector.ts`
4. `src/lib/response-poller.ts` (3箇所のdetectPrompt呼び出し)
5. `src/app/api/worktrees/[id]/current-output/route.ts`
6. `src/lib/claude-poller.ts` (到達不能、2箇所)

**問題**:
- CLIツール判定ロジックの変更（例: 新ツール追加でrequireDefaultIndicator=falseが必要）が6箇所に波及
- 判定ロジックのtypoや不一致が発生するリスク

**推奨解決策**:

`prompt-detector.ts`内部にCLIToolTypeをimportするとCLIツール非依存性原則に違反するため、`cli-patterns.ts`（既にCLIToolType依存あり）にヘルパー関数を配置する。

```typescript
// src/lib/cli-patterns.ts に追加
import type { DetectPromptOptions } from './prompt-detector';

export function buildDetectPromptOptions(cliToolId: CLIToolType): DetectPromptOptions | undefined {
  if (cliToolId === 'claude') {
    return { requireDefaultIndicator: false };
  }
  return undefined;
}
```

各呼び出し元:
```typescript
import { buildDetectPromptOptions } from '@/lib/cli-patterns';

const promptOptions = buildDetectPromptOptions(cliToolId);
const promptCheck = detectPrompt(cleanOutput, promptOptions);
```

この方式により:
- DRY原則を満たす（判定ロジック1箇所に集約）
- prompt-detector.tsのCLIツール非依存性を維持
- cli-patterns.tsは既にCLIToolType依存があるため責務の拡大は最小限

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | DRY違反による変更漏れ（6箇所の判定パターン分散） | Medium | Medium | P1 |
| 技術的リスク | requireDefaultIndicator=falseでの誤検出増加 | High | Low | P2 |
| 技術的リスク | response-poller.ts内3箇所のdetectPrompt変更漏れ | Medium | Low | P2 |
| 運用リスク | claude-poller.ts到達不能コード修正の工数浪費 | Low | Low | P3 |

---

## Design Principles Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (Single Responsibility) | Pass (with notes) | prompt-detector.tsの非依存性維持は優秀。status-detector.tsへのoptions構築埋め込みはヘルパーで解消可能 |
| OCP (Open-Closed) | Pass | DetectPromptOptions interfaceによる拡張ポイント設計が適切。デフォルト値で後方互換性維持 |
| LSP (Liskov Substitution) | N/A | 継承関係なし |
| ISP (Interface Segregation) | Pass | optionalフィールドのみで構成。不要な実装を強制しない |
| DIP (Dependency Inversion) | Pass | prompt-detector.tsはCLIToolTypeに非依存。抽象interfaceのみに依存 |
| KISS (Simplicity) | Pass (with notes) | 単一フラグで2ゲート制御は簡潔。二重否定パターンは改善余地あり |
| YAGNI (No premature work) | Pass (with notes) | ケースB限定実装は適切。到達不能コード修正は低優先度で容認 |
| DRY (No duplication) | Needs Improvement | cliToolId判定パターン6箇所分散はヘルパー関数で解消すべき |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

| ID | 原則 | 内容 | 対象ファイル |
|----|------|------|-------------|
| MF-001 | DRY | `buildDetectPromptOptions(cliToolId)` ヘルパー関数を `cli-patterns.ts` に追加し、6箇所の判定パターンを集約 | `src/lib/cli-patterns.ts` + 6呼び出し元 |

### 推奨改善項目 (Should Fix)

| ID | 原則 | 内容 |
|----|------|------|
| SF-001 | OCP | 設計書にPass 1/Layer 4の個別制御が必要になった場合の拡張方針コメントを追加 |
| SF-002 | SRP | MF-001のヘルパー関数でstatus-detector.ts内のoptions構築ロジック埋め込みを解消 |
| SF-003 | KISS | response-poller.ts内にprivateヘルパーを設けてdetectPrompt呼び出し3箇所を集約 |

### 検討事項 (Consider)

| ID | 原則 | 内容 |
|----|------|------|
| C-001 | YAGNI | claude-poller.ts到達不能コードは修正よりもドキュメント化を優先検討 |
| C-002 | OCP | CLIツール数増加時のレジストリパターン導入（現時点では不要） |
| C-003 | KISS | `requireDefaultIndicator !== false` を `requireDefaultIndicator ?? true` に書き換えて可読性向上 |

---

## Approval Status

**Conditionally Approved** -- MF-001（DRYヘルパー関数）の設計書への反映を条件に承認。

設計全体としてはOCP/ISP/DIPの観点から優れた設計であり、Issue #161で確立されたCLIツール非依存性原則を忠実に維持している。DRY違反の解消は実装フェーズで対応可能であり、設計の方向性自体は正しい。
