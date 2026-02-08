# Issue #180 Stage 2: Impact Review (影響範囲レビュー)

**Review Date**: 2026-02-07
**Focus Area**: 影響範囲レビュー（Impact Scope）
**Iteration**: 1

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 1 |
| Should Fix | 2 |
| Nice to Have | 1 |

---

## Must Fix (必須対応)

### MF-1: 影響ファイルの不完全な列挙

**Category**: 影響ファイル
**Location**: `## 影響範囲` section

**Issue**:
影響範囲に記載されているファイルが不完全。ステータス検出ロジックの変更は複数のエンドポイントと表示コンポーネントに影響する。

**Evidence**:

**現在の記載**:
- `src/app/api/worktrees/route.ts`
- `src/lib/prompt-detector.ts`

**追加すべきファイル**:

| File | Impact Type | Reason |
|------|-------------|--------|
| `src/app/api/worktrees/[id]/route.ts` | 直接影響 | 個別worktreeのステータス取得にも同様のロジックが使用される可能性 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 直接影響 | リアルタイム出力取得でステータス判定が行われる |
| `src/lib/cli-patterns.ts` | 間接影響 | パターン定義の変更が必要な場合 |
| `src/types/sidebar.ts` | 間接影響 | deriveCliStatus()の入力パラメータが変わる可能性 |
| `src/components/sidebar/BranchStatusIndicator.tsx` | 表示影響 | ステータス表示のUI変更が必要な場合 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 表示影響 | CLI別ステータスドットの表示 |

**Recommendation**:
影響範囲セクションを更新し、直接影響・間接影響・表示影響を分類して記載すること。

---

## Should Fix (推奨対応)

### SF-1: テスト範囲の未特定

**Category**: テスト範囲
**Location**: Issue全体（テスト言及なし）

**Issue**:
ステータス検出ロジックの変更に対する必要なテストケースが特定されていない。回帰を防ぐため、テスト戦略を明示すべき。

**Recommendation**:
以下のテストケースを追加・更新対象として記載すること:

**Unit Tests**:
```
tests/unit/lib/prompt-detector.test.ts
- 最終行のみに(y/n)がある場合のテスト
- スクロールバックに(y/n)があり最終行に❯がある場合のテスト

tests/unit/lib/cli-patterns.test.ts
- detectThinking()の最終行限定テスト
```

**Integration Tests**:
```
tests/integration/api/worktrees.test.ts
- 各ステータス（ready, waiting, running）の正確な検出テスト
- 遷移シナリオ（processing→ready→waiting→ready）
```

---

### SF-2: 破壊的変更の可能性の未記載

**Category**: 破壊的変更
**Location**: Issue全体

**Issue**:
検出ロジックの変更により、現在「waiting」や「running」と表示されているケースが「ready」に変わる可能性がある。これは既存ユーザーの期待と異なる動作となりうる。

**Evidence**:
現在のロジックでは、過去にプロンプトがあった場合でも`waiting`と表示される。修正後は`ready`に変わるため、ユーザーの見慣れた動作が変化する。

**Recommendation**:
- 変更による動作差異を明記すること
- ユーザーへの通知が必要かどうかを検討すること（CHANGELOGへの記載など）

---

## Nice to Have (あれば良い)

### NTH-1: ドキュメント更新の必要性

**Category**: ドキュメント更新
**Location**: Issue全体

**Issue**:
ステータス検出ロジックの仕様変更に伴い、以下のドキュメント更新が必要になる可能性がある。

**Documents to Update**:
| Document | Update Reason |
|----------|---------------|
| `docs/features/sidebar-status-indicator.md` | 検出優先順位の説明を更新 |
| `CLAUDE.md` | 主要モジュール説明に変更があれば更新 |

**Recommendation**:
「ドキュメント更新」セクションを追加し、必要な更新を列挙すること。

---

## Impact Analysis Summary

### 影響レベル評価

| Aspect | Level | Notes |
|--------|-------|-------|
| Code Change Scope | Medium | 2-3ファイルの主要ロジック変更 |
| API Breaking Change | None | APIレスポンス形式は変更なし |
| UI Breaking Change | Low | ステータス表示の改善（修正） |
| Test Impact | Medium | 新規テストケース追加が必要 |
| Documentation Impact | Low | 内部仕様ドキュメントの更新 |

### Dependency Graph

```
src/app/api/worktrees/route.ts
    |
    +-- src/lib/prompt-detector.ts (detectPrompt)
    |       |
    |       +-- Affects: isWaitingForResponse flag
    |
    +-- src/lib/cli-patterns.ts (detectThinking, getCliToolPatterns)
            |
            +-- Affects: isProcessing flag

src/types/sidebar.ts
    |
    +-- deriveCliStatus() uses isWaitingForResponse, isProcessing
            |
            +-- Returns: BranchStatus ('idle'|'ready'|'running'|'waiting')
```

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 他のプロンプトパターンの検出漏れ | Medium | High | 広範なテストケースを作成 |
| パフォーマンス劣化 | Low | Low | 範囲を狭めるため影響なし |
| 既存テストの失敗 | Medium | Low | テストの期待値を更新 |

---

## Code Reference Analysis

### 現在の実装フロー

```typescript
// route.ts (simplified flow)
1. captureSessionOutput(worktree.id, cliToolId, 100)  // 100行取得
2. stripAnsi(output)
3. detectPrompt(cleanOutput)  // 最後10-50行を検索
   -> if isPrompt: isWaitingForResponse = true
4. else:
   nonEmptyLines.slice(-15)  // 最後15行（空行除く）
   detectThinking(lastLines)
   -> if thinking: isProcessing = true
5. else:
   promptPattern.test(lastLines)
   -> if no prompt: isProcessing = true
```

### 提案される実装フロー

```typescript
// 改善案 (proposed flow)
1. captureSessionOutput(worktree.id, cliToolId, 100)
2. stripAnsi(output)
3. 最後2-3行を取得
4. 入力プロンプト(❯)チェック
   -> if found at end: ready
5. インタラクティブプロンプト((y/n)等)チェック
   -> if found at end: waiting
6. thinking indicatorチェック
   -> if found: running
7. else: processing
```

---

## Recommendations Summary

1. **影響ファイル一覧を完全化する**（MF-1）
2. **テスト戦略を追加する**（SF-1）
3. **破壊的変更の可能性を明記する**（SF-2）
4. **ドキュメント更新リストを追加する**（NTH-1）

---

## Conclusion

Issue #180の影響範囲の記載は最小限であり、実装時に追加の調査が必要になる可能性がある。特に、同様のステータス検出を行う他のAPIエンドポイントへの影響と、必要なテストケースの特定が不足している。これらを補完することで、より安全な実装が可能になる。
