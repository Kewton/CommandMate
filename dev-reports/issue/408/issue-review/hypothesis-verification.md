# Issue #408 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `current-output/route.ts` L87で`detectSessionStatus()`を呼び出し（内部で`detectPrompt()`実行） | Confirmed | L87で呼び出し確認、status-detector.ts L145で内部呼び出し確認 |
| 2 | L100-101で再度`detectPrompt()`を直接呼び出し | Confirmed | L101で直接呼び出し確認（`!thinking`条件付き） |
| 3 | 同一出力に対してregexパターンマッチングが2回実行される | Partially Confirmed | `!thinking`かつ非プロンプト状態の時のみ2回実行（thinking時はスキップ） |
| 4 | このAPIはクライアントから2-5秒ごとに呼ばれるホットパス | Unverifiable | コードからは確認不可（UIポーリング間隔はクライアント側実装に依存） |

## 詳細検証

### 仮説 1: `detectSessionStatus()`内部で`detectPrompt()`が呼ばれる

**Issue内の記述**: `current-output/route.ts` (L87) で`detectSessionStatus()`を呼び出し（内部で`detectPrompt()`実行）

**検証手順**:
1. `src/app/api/worktrees/[id]/current-output/route.ts` L87確認
2. `src/lib/status-detector.ts` L145確認

**判定**: Confirmed

**根拠**:
- `current-output/route.ts` L87: `const statusResult = detectSessionStatus(output, cliToolId);`
- `status-detector.ts` L145: `const promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);`
- `detectSessionStatus()`は常に`detectPrompt()`を最初に呼ぶ（Priority 1: Interactive prompt detection）

---

### 仮説 2: L100-101で再度`detectPrompt()`を直接呼び出し

**Issue内の記述**: (L100-101) で再度`detectPrompt()`を直接呼び出し

**検証手順**:
1. `src/app/api/worktrees/[id]/current-output/route.ts` L98-101確認

**判定**: Confirmed（行番号は若干ずれあり）

**根拠**:
```typescript
// L98-101
let promptDetection: { isPrompt: boolean; cleanContent: string; promptData?: unknown } = { isPrompt: false, cleanContent: cleanOutput };
if (!thinking) {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
}
```
- Issue本文のL100-101は実際にはL101-102付近（ファイル変更で行番号ずれの可能性）
- `!thinking`という条件付きで呼び出されている（Issue記載に条件の言及なし）

---

### 仮説 3: 同一出力に対してregexパターンマッチングが2回実行される

**Issue内の記述**: 結果として同一出力に対してregexパターンマッチングが2回実行される

**検証手順**:
1. 両呼び出しの引数を比較
2. `thinking`条件の影響を分析

**判定**: Partially Confirmed

**根拠**:
- 両呼び出しともに`stripBoxDrawing(cleanOutput)`（同一内容）を引数に使用
- しかし `!thinking` 条件により:
  - `thinking === true`の場合: `detectSessionStatus()`内部で呼ばれ、promptなしで即返却。route.tsでの2回目呼び出しはスキップ → **1回のみ**
  - `thinking === false`の場合: `detectSessionStatus()`内部で1回 + route.tsで1回 → **2回実行**（重複）
- 実際に重複が発生するのは thinking でない場合（通常動作時の大部分）

**コードに明記された設計根拠** (`status-detector.ts` L12-21):
```
// Architecture note (SF-001 tradeoff):
// This controlled DRY violation is accepted because:
//   - StatusDetectionResult maintains SRP (status + confidence, not prompt details)
//   - detectPrompt() is lightweight (regex-based, no I/O), so the cost is negligible
```

---

### 仮説 4: このAPIはホットパス（2-5秒ごとに呼ばれる）

**Issue内の記述**: このAPIはクライアントから2-5秒ごとに呼ばれるホットパス

**検証手順**:
1. サーバー側コードからポーリング間隔を確認しようとしたが、クライアント側実装に依存

**判定**: Unverifiable（コードベースからは検証不可）

**根拠**:
- `current-output/route.ts`はGETエンドポイントとして定義されており、ポーリングに適した構造
- ポーリング間隔はクライアント実装に依存（`src/hooks/`等を確認が必要）
- 設計上ホットパスであることは合理的な主張

---

## 追加観察事項（Issue未記載）

### `detectSessionStatus()`の他の呼び出し元

他に2箇所で`detectSessionStatus()`が使用されているが、いずれも`detectPrompt()`を別途呼び出していない：

- `src/app/api/worktrees/route.ts` L58: `statusResult.hasActivePrompt`のみ使用
- `src/app/api/worktrees/[id]/route.ts` L68: `statusResult.hasActivePrompt`のみ使用

`current-output/route.ts`のみが`promptData`を必要とするため、`detectPrompt()`の2回呼び出しが発生している。

### 設計変更の注意点

Issueの提案（`detectSessionStatus()`の戻り値に`promptDetection`結果を追加）は実装可能だが、以下の考慮が必要：

1. **SRP観点**: `StatusDetectionResult`に`PromptDetectionResult`を含めることで型間の結合が発生
2. **他の呼び出し元への影響**: `worktrees/route.ts`と`worktrees/[id]/route.ts`は`promptData`不要なため、オプショナルフィールドとして追加するか、新しい関数を作成するかの選択が必要
3. **`thinking`時の二重ガード**: `detectSessionStatus()`内の実装上、`thinking`状態（thinking indicator検出）はprompt検出の後に評価されるため、实は`thinking`時は`detectPrompt()`が1回しか呼ばれない（route.tsのガードは重複防止として正しい）

---

## Stage 1レビューへの申し送り事項

- 仮説の本質（二重呼び出し）は正確だが、**条件付き（`!thinking`の場合のみ）である**という重要な詳細がIssue記載にない
- `thinking`時は現状でも1回のみ呼ばれている点を明確化する必要がある
- 解決策として `detectSessionStatus()` の戻り値型変更を提案しているが、SRPへの影響と他の呼び出し元（`worktrees/route.ts`、`worktrees/[id]/route.ts`）への影響を受入条件・影響範囲に追記すべき
- 「Partially Confirmed」: Issue記載の問題は実在するが、「常に2回」ではなく「`thinking === false`時に2回」という正確な記述が必要
