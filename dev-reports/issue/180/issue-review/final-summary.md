# Issue #180 Final Review Summary

**Issue Title**: fix: モバイルステータス表示の不整合 - CLIがidle状態でもrunning/waitingと誤表示
**Review Date**: 2026-02-07
**Review Type**: Multi-Stage Issue Review

---

## Overall Assessment

| Aspect | Rating | Notes |
|--------|--------|-------|
| Problem Definition | Good | 問題と再現手順が明確 |
| Root Cause Analysis | Good | 原因分析は概ね正確だが細部に不正確な点あり |
| Solution Proposal | Fair | 方向性は妥当だが具体的実装が不足 |
| Impact Analysis | Poor | 影響範囲が不完全 |
| Acceptance Criteria | Missing | 受け入れ条件が未定義 |

**Overall Score**: 3/5 - 実装には追加情報が必要

---

## Issues Summary

### Stage 1: Content Review

| ID | Category | Severity | Issue |
|----|----------|----------|-------|
| MF-1 | 完全性 | Must Fix | 修正案のコードが不完全（具体的実装が省略） |
| SF-1 | 正確性 | Should Fix | 問題3の記載が実装と矛盾（空行フィルタの言及なし） |
| SF-2 | 正確性 | Should Fix | detectPromptの検索範囲記載が不正確（10-50行は曖昧） |
| SF-3 | 受け入れ条件 | Should Fix | 受け入れ条件が未定義 |
| NTH-1 | 完全性 | Nice to Have | デスクトップでの動作確認の記載なし |
| NTH-2 | 完全性 | Nice to Have | 関連IssueにIssue #161が未記載 |

### Stage 2: Impact Review

| ID | Category | Severity | Issue |
|----|----------|----------|-------|
| MF-1 | 影響ファイル | Must Fix | 影響ファイルの列挙が不完全 |
| SF-1 | テスト範囲 | Should Fix | テスト戦略が未特定 |
| SF-2 | 破壊的変更 | Should Fix | 動作変更による影響が未記載 |
| NTH-1 | ドキュメント | Nice to Have | ドキュメント更新リストなし |

---

## Improvement Recommendations

### Priority 1: Must Fix Items

#### 1. 修正案に具体的な実装コードを追加

```typescript
// 提案: 最終行優先の検出ロジック
const lines = cleanOutput.split('\n');
const nonEmptyLines = lines.filter(line => line.trim() !== '');
const lastFewLines = nonEmptyLines.slice(-3).join('\n');

// Step 1: 入力プロンプトチェック（最優先）
const { promptPattern } = getCliToolPatterns(cliToolId);
if (promptPattern.test(lastFewLines)) {
  // ready: 新しいメッセージ入力可能
  return { isWaitingForResponse: false, isProcessing: false };
}

// Step 2: インタラクティブプロンプトチェック
const interactivePrompt = detectPromptFromLastLines(lastFewLines);
if (interactivePrompt.isPrompt) {
  return { isWaitingForResponse: true, isProcessing: false };
}

// Step 3: thinking indicatorチェック
if (detectThinking(cliToolId, lastFewLines)) {
  return { isWaitingForResponse: false, isProcessing: true };
}

// Step 4: いずれにも該当しない = processing
return { isWaitingForResponse: false, isProcessing: true };
```

#### 2. 影響範囲の完全化

```markdown
## 影響範囲

### 直接影響（修正対象）
- `src/app/api/worktrees/route.ts` - ステータス検出ロジック
- `src/lib/prompt-detector.ts` - プロンプト検出関数

### 間接影響（確認必要）
- `src/app/api/worktrees/[id]/route.ts` - 個別ステータス取得
- `src/app/api/worktrees/[id]/current-output/route.ts` - リアルタイム出力
- `src/lib/cli-patterns.ts` - パターン定義
- `src/types/sidebar.ts` - deriveCliStatus関数

### 表示影響
- `src/components/sidebar/BranchStatusIndicator.tsx`
- `src/components/worktree/WorktreeDetailRefactored.tsx`
```

### Priority 2: Should Fix Items

#### 3. 受け入れ条件の追加

```markdown
## 受け入れ条件

- [ ] AC1: `❯`プロンプトのみが最終行に表示されている場合、ステータスが「ready」（緑）になること
- [ ] AC2: `(y/n)`プロンプトが最終行に表示されている場合のみ、ステータスが「waiting」（黄）になること
- [ ] AC3: thinking indicator（`✻ Processing...`）が最終行に表示されている場合のみ、ステータスが「running」（青スピナー）になること
- [ ] AC4: 過去のプロンプトパターンがスクロールバックに存在しても、最終行の状態に基づいて正しいステータスが表示されること
- [ ] AC5: モバイル・デスクトップ両方で正しく動作すること
```

#### 4. テスト戦略の追加

```markdown
## テスト戦略

### Unit Tests
- `tests/unit/lib/prompt-detector.test.ts`
  - 最終行のみに(y/n)がある場合
  - スクロールバックに(y/n)があり最終行に❯がある場合
  - 複数選択プロンプトの正確な検出

### Integration Tests
- `tests/integration/api/worktrees.test.ts`
  - ready状態の正確な検出
  - waiting状態の正確な検出
  - running状態の正確な検出
  - ステータス遷移シナリオ
```

#### 5. 記載の正確性向上

```markdown
## 根本原因

### 問題1: 過去のプロンプト誤検出
- `detectPrompt()`の検索範囲:
  - yes/noパターン: 最後10行
  - 複数選択パターン: 最後50行
- 過去の`(y/n)`や選択肢プロンプトがスクロールバックに残っていると誤検出

### 問題3: thinking検出の範囲が広すぎる
- `detectThinking()`が最後15行（空行除くフィルタリング後）を検索
- 空行フィルタにより、視覚的な行数よりも広い範囲を実質的に検索
```

---

## Related Issues & Documentation

### Related Issues
- Issue #4 (CLIツールサポート)
- Issue #31 (サイドバーUX改善)
- Issue #161 (複数選択プロンプト誤検出問題) - **追加推奨**

### Documentation Updates Required
- `docs/features/sidebar-status-indicator.md` - 検出優先順位の更新

---

## Implementation Guidance

### 推奨実装順序

1. `prompt-detector.ts`に`detectPromptFromLastLines()`関数を追加
2. `route.ts`の検出優先順位を変更
3. 単体テストを追加・更新
4. 結合テストを追加
5. ドキュメントを更新

### 注意点

- 既存の`detectPrompt()`関数は下位互換性のため残す
- 新しい関数を作成し、段階的に移行する
- パフォーマンス影響は軽微（検索範囲が狭まるため）

---

## Conclusion

Issue #180は問題の本質を正確に捉えており、修正の方向性も妥当である。しかし、以下の点で補完が必要:

1. **具体的な実装コード**が不足しており、実装者の解釈に依存する余地がある
2. **影響範囲**が不完全で、関連ファイルの見落としリスクがある
3. **受け入れ条件**がなく、完了判定が曖昧
4. **テスト戦略**がなく、回帰テストの漏れリスクがある

これらを補完することで、より品質の高い実装が可能になる。
