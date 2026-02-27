# Architecture Review: Issue #374 - Vibe Local Context Window Size

## Review Overview

| Item | Value |
|------|-------|
| Issue | #374 |
| Stage | 1 (通常レビュー) |
| Focus | 設計原則 (SOLID / KISS / YAGNI / DRY) |
| Status | Conditionally Approved |
| Score | 4 / 5 |
| Date | 2026-02-28 |

## Executive Summary

Issue #374の設計方針書は、Vibe Local CLIツールの `--context-window` オプションをworktree単位で設定可能にする機能の設計を記述している。既存の `vibeLocalModel` 実装パターンとの一貫性を重視したシンプルな設計であり、defense-in-depth によるセキュリティ設計も適切に考慮されている。

設計原則の観点から8件の指摘事項を検出した（must-fix: 1件、should-fix: 3件、nice-to-have: 4件）。must-fix 1件はDB直接アクセスに関するDIP違反だが、既存パターンとの一貫性を考慮すると severity を緩和する余地がある。全体としてスコープが明確で実装リスクの低い設計方針書であり、指摘事項を反映した上で実装に進めることを推奨する。

---

## Detailed Findings

### [S1-001] should-fix: バリデーションロジックの重複（DRY）

**原則**: DRY (Don't Repeat Yourself)

**問題**:
設計方針書のセクション5では、API層（`route.ts`）とCLI層（`vibe-local.ts`）の両方で同一のバリデーション条件をインラインで記述する方針となっている。

```typescript
// API層 (route.ts)
typeof ctxWindow !== 'number' || !Number.isInteger(ctxWindow)
    || ctxWindow < 128 || ctxWindow > VIBE_LOCAL_CONTEXT_WINDOW_MAX

// CLI層 (vibe-local.ts) - defense-in-depth
typeof ctxWindow === 'number' && Number.isInteger(ctxWindow)
    && ctxWindow >= 128 && ctxWindow <= VIBE_LOCAL_CONTEXT_WINDOW_MAX
```

defense-in-depth として両レイヤーでのバリデーションは合理的だが、条件式がインラインで書かれるため、将来 MIN/MAX 値の変更時に修正漏れのリスクがある。定数は共有するが、ロジック自体は重複している。

**改善提案**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/cli-tools/types.ts` にバリデーション関数を定義し、両レイヤーで共有する。

```typescript
// src/lib/cli-tools/types.ts
export function isValidVibeLocalContextWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= VIBE_LOCAL_CONTEXT_WINDOW_MIN &&
    value <= VIBE_LOCAL_CONTEXT_WINDOW_MAX
  );
}
```

これは `OLLAMA_MODEL_PATTERN` 定数の共有パターンと同様のアプローチであり、既存プロジェクトの慣例とも整合する。

---

### [S1-002] nice-to-have: AgentSettingsPaneの責務増加傾向（SRP）

**原則**: SRP (Single Responsibility Principle)

**問題**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/components/worktree/AgentSettingsPane.tsx` は現在約270行で、以下の責務を持つ:
1. エージェント選択チェックボックス
2. Ollama モデルセレクター

Issue #374でコンテキストウィンドウ入力欄が追加されると3つ目の責務が加わる。

**改善提案**:
現時点では即座の分割は不要（YAGNI）。ただし、将来 vibe-local 固有の設定が更に増える場合は `VibeLocalSettingsSection` サブコンポーネントへの切り出しを検討する。設計方針書にこの方針をメモとして追記することを推奨。

---

### [S1-003] nice-to-have: SELECT文への新カラム追加が6箇所（DRY）

**原則**: DRY (Don't Repeat Yourself)

**問題**:
設計方針書セクション3.3で、`getWorktrees()` と `getWorktreeById()` のそれぞれについて SELECT文・型キャスト・マッピングの計6箇所を修正する必要がある。`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/db.ts` を確認すると、両関数のマッピングロジック（行240-263 および 行344-363）はほぼ同一構造であり、構造的な重複が存在する。

**改善提案**:
既存パターンとの一貫性を優先する方針は妥当。長期的には `mapWorktreeRow()` ヘルパー関数の抽出で修正箇所を削減できるが、Issue #374のスコープでは既存パターン踏襲で問題ない。

---

### [S1-004] should-fix: VIBE_LOCAL_CONTEXT_WINDOW定数の配置場所（OCP）

**原則**: OCP (Open/Closed Principle)

**問題**:
`VIBE_LOCAL_CONTEXT_WINDOW_MIN/MAX` を `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/cli-tools/types.ts` に配置する方針だが、このファイルには全CLIツール共通の型定義（`CLIToolType`, `ICLITool`）が含まれている。vibe-local 固有の定数の追加はファイルの責務を拡大させる。

ただし、`OLLAMA_MODEL_PATTERN` が既に同ファイルに配置されている前例がある（138行目）ため、一貫性の観点では許容範囲。

**改善提案**:
現時点では `types.ts` への配置を維持しつつ、JSDoc で vibe-local 固有であることを明記する。将来的に vibe-local 固有の定数・パターンが増える場合は `src/lib/cli-tools/vibe-local-config.ts` への分離を検討する。

---

### [S1-005] must-fix: vibe-local.ts内でのDB直接アクセス（DIP）

**原則**: DIP (Dependency Inversion Principle)

**問題**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/cli-tools/vibe-local.ts` の `startSession()` メソッド（行61-111）内で、直接 `getDbInstance()` および `getWorktreeById()` を呼び出してDBアクセスを行っている。設計方針書では context-window の読み取りもこの既存パターンに従う方針。

```typescript
// vibe-local.ts startSession() 行89-97
try {
  const db = getDbInstance();
  const wt = getWorktreeById(db, worktreeId);
  if (wt?.vibeLocalModel && OLLAMA_MODEL_PATTERN.test(wt.vibeLocalModel)) {
    vibeLocalCommand = `vibe-local -y -m ${wt.vibeLocalModel}`;
  }
} catch {
  // DB read failure is non-fatal; use default model
}
```

CLI層（ビジネスロジック）がDB層に直接依存する構造は DIP に反する。また、`startSession()` のテスト時にDB をモック/セットアップする必要があり、テスタビリティを低下させる。

**改善提案**:
2つの選択肢がある:

**選択肢A（推奨・段階的）**: Issue #374 では既存パターンを踏襲し、設計方針書に将来のリファクタリング方針として明記する。severity を should-fix に緩和。

**選択肢B（理想的・スコープ拡大）**: `startSession()` のシグネチャを拡張して `vibeLocalModel` と `contextWindow` を引数として受け取る設計に変更。呼び出し側（send/route.ts 等）でDBから読み取った値を渡す。

```typescript
async startSession(
  worktreeId: string,
  worktreePath: string,
  options?: { model?: string; contextWindow?: number }
): Promise<void>
```

既存の `vibeLocalModel` も同時にリファクタリングが必要になるため、スコープの判断が必要。

---

### [S1-006] nice-to-have: Props伝播チェーンの複雑さ（KISS）

**原則**: KISS (Keep It Simple, Stupid)

**問題**:
Props伝播パターンが `WorktreeDetailRefactored` -> `NotesAndLogsPane` -> `AgentSettingsPane` の3段階。Issue #374で `vibeLocalContextWindow` と `onVibeLocalContextWindowChange` の2 props が追加されると、`NotesAndLogsPane` のprops数が更に増加する。

現在の `/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/components/worktree/NotesAndLogsPane.tsx` の `NotesAndLogsPaneProps` には既に6フィールドがあり（行33-46）、Issue #374で8フィールドになる。

**改善提案**:
既存パターンと同一であり、現時点では許容範囲。将来的には props オブジェクトの構造化を検討する。

```typescript
// 将来の検討事項
interface VibeLocalSettings {
  model: string | null;
  contextWindow: number | null;
  onModelChange: (model: string | null) => void;
  onContextWindowChange: (ctxWindow: number | null) => void;
}
```

---

### [S1-007] should-fix: 下限値128の根拠と妥当性（YAGNI）

**原則**: YAGNI (You Aren't Gonna Need It)

**問題**:
設計方針書セクション9では下限128の理由を「Ollamaの最小モデル対応」と記載しているが、Ollamaのデフォルトコンテキストウィンドウサイズは通常2048以上であり、128という値を実際に使用するユースケースが不明確。下限を過度に低く設定すると、ユーザーの誤設定リスクが増加する。

**改善提案**:
実際のOllamaモデルの最小コンテキストウィンドウサイズを調査し、実用的な下限値を設定する（例: 2048）。または128を維持する場合は根拠をJSDocコメントに明記する。

---

### [S1-008] nice-to-have: 個別update関数パターンの拡張（OCP）

**原則**: OCP (Open/Closed Principle)

**問題**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/db.ts` には個別のupdate関数が既に多数存在する:
- `updateWorktreeDescription()` (行414)
- `updateWorktreeLink()` (行431)
- `updateFavorite()` (行926)
- `updateStatus()` (行943)
- `updateCliToolId()` (行960)
- `updateSelectedAgents()` (行982)
- `updateVibeLocalModel()` (行1004)

Issue #374で `updateVibeLocalContextWindow()` が追加されると8関数目。設計方針書では「YAGNIの観点から汎用化は不要」としているが、3フィールド目の vibe-local 固有設定追加でパターンの繰り返しが顕著になりつつある。

**改善提案**:
現時点では個別関数パターンで管理可能。4フィールド以上になった場合の汎用化を技術的負債として追跡することを推奨する。

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | DB直接アクセスパターンのテスタビリティ低下 | Low | Med | P3 |
| Technical | バリデーション条件の将来的な変更時の修正漏れ | Low | Low | P3 |
| Security | defense-in-depth設計は適切。リスクは低い | Low | Low | P3 |
| Operational | マイグレーション version 20 の後方互換性 | Low | Low | P3 |

---

## Design Principle Checklist

| Principle | Status | Notes |
|-----------|--------|-------|
| SRP (Single Responsibility) | Pass (with note) | AgentSettingsPane の責務増加は将来課題（S1-002） |
| OCP (Open/Closed) | Pass (with note) | 定数配置場所と個別関数パターンに改善余地（S1-004, S1-008） |
| LSP (Liskov Substitution) | Pass | VibeLocalTool は BaseCLITool を適切に継承 |
| ISP (Interface Segregation) | Pass | ICLITool インターフェースは最小限の契約 |
| DIP (Dependency Inversion) | Conditional | startSession() 内の DB 直接アクセス（S1-005） |
| KISS | Pass | 既存パターン踏襲によるシンプルな設計 |
| YAGNI | Pass (with note) | 下限値128の根拠要確認（S1-007） |
| DRY | Conditional | バリデーションロジック・SELECTマッピングの重複（S1-001, S1-003） |

---

## Improvement Recommendations

### Must Fix (1 item)

1. **S1-005**: vibe-local.ts 内の DB 直接アクセスについて、既存パターン踏襲で進める場合は設計方針書に将来のリファクタリング方針を明記する。テスタビリティ向上のために startSession() の引数拡張を検討する。

### Should Fix (3 items)

1. **S1-001**: バリデーション関数 `isValidVibeLocalContextWindow()` を types.ts に定義し、API 層・CLI 層で共有する。
2. **S1-004**: VIBE_LOCAL_CONTEXT_WINDOW_MIN/MAX の JSDoc に vibe-local 固有であることを明記する。
3. **S1-007**: 下限値 128 の根拠を調査し、実用的な値に調整するか JSDoc で根拠を明記する。

### Consider (4 items)

1. **S1-002**: AgentSettingsPane の将来的な VibeLocalSettingsSection 分割の方針をメモする。
2. **S1-003**: mapWorktreeRow() ヘルパー関数の将来的な抽出を検討する。
3. **S1-006**: Props 伝播チェーンの構造化を将来課題として認識する。
4. **S1-008**: 個別 update 関数が4つ以上になった場合の汎用化を技術的負債として追跡する。

---

## Approval Status

**Conditionally Approved** -- S1-001（バリデーション関数化）と S1-005（DB直接アクセスの方針明記）を対応した上で、実装に進むことを推奨する。残りの指摘事項は既存パターンとの一貫性を考慮して、将来の改善課題として扱うことが妥当。

---

*Reviewed by architecture-review-agent for Issue #374, Stage 1 (Design Principles)*
