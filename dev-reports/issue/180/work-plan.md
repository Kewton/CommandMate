# 作業計画書: Issue #180 ステータス表示の不整合修正

## Issue: fix: ステータス表示の不整合 - CLIがidle状態でもrunning/waitingと誤表示
**Issue番号**: #180
**サイズ**: S（3ソースファイル + 1テストファイル変更）
**優先度**: High（ユーザー体験に直接影響するバグ修正）
**依存Issue**: なし
**設計方針書**: `dev-reports/design/issue-180-status-display-inconsistency-design-policy.md`

---

## 詳細タスク分解

### Phase 1: status-detector.ts 型・契約更新

- [ ] **Task 1.1**: `StatusDetectionResult`インターフェースに`hasActivePrompt: boolean`フィールド追加
  - 成果物: `src/lib/status-detector.ts`
  - 依存: なし
  - 詳細:
    - `hasActivePrompt: boolean` フィールド追加（JSDocコメント付き）
    - `detectPrompt()`結果をboolean変換して各return文に`hasActivePrompt`を設定
    - 設計参照: Section 5-1, DR-002

- [ ] **Task 1.2**: `detectSessionStatus()` JSDoc更新（入力契約の明確化）
  - 成果物: `src/lib/status-detector.ts`
  - 依存: Task 1.1
  - 詳細:
    - `@param output` のJSDocに「Raw tmux output (including ANSI escape codes)」を明記
    - 既存のシグネチャ（`cliToolId: CLIToolType`, `lastOutputTimestamp?: Date`）はそのまま維持
    - 設計参照: Section 5-1, DR-001, C-001, C-002

### Phase 2: テスト追加（Red）

- [ ] **Task 2.1**: Issue #180固有テストケース追加
  - 成果物: `src/lib/__tests__/status-detector.test.ts`
  - 依存: Task 1.1
  - 詳細（8テストケース）:
    1. 過去のy/nプロンプト + 末尾入力プロンプト → ready
    2. 過去のmultiple choice + 末尾入力プロンプト → ready
    3. 末尾にy/nプロンプト → waiting
    4. 末尾にmultiple choice → waiting
    5. StatusResult → isWaitingForResponse/isProcessing マッピング検証
    6. hasActivePrompt: true/false 検証
    7. 末尾空行テスト（3サブシナリオ: 5行空行、20行空行[SEC-009]、10行空行+y/n）
    8. 生出力（ANSIコード含む）テスト [DR-001]
  - 設計参照: Section 8-2

### Phase 3: テスト通過確認（Green）

- [ ] **Task 3.1**: 新規テストの通過確認
  - 成果物: テスト全パス
  - 依存: Task 2.1
  - 詳細:
    - `npx vitest run src/lib/__tests__/status-detector.test.ts`
    - 既存ロジック（15行ウィンドウイング）で大部分のテストは通過するはず
    - SEC-009テスト（20行空行パディング）の結果に基づき、空行フィルタリング追加を判断

### Phase 4: route.ts インラインロジック統合

- [ ] **Task 4.1**: `src/app/api/worktrees/route.ts` の修正
  - 成果物: `src/app/api/worktrees/route.ts`
  - 依存: Task 3.1
  - 詳細:
    - 行56-99のインラインステータス検出ロジックを`detectSessionStatus(output, cliToolId)`呼び出しに置き換え
    - `captureSessionOutput()`の生の戻り値をそのまま渡す（`stripAnsi`不要）
    - `isWaitingForResponse = statusResult.status === 'waiting'`
    - `isProcessing = statusResult.status === 'running'`
    - stale prompt cleanup: `!statusResult.hasActivePrompt`条件で`worktree.id`使用
    - 設計参照: Section 3, 5-2, C-004, C-005

- [ ] **Task 4.2**: `src/app/api/worktrees/[id]/route.ts` の修正
  - 成果物: `src/app/api/worktrees/[id]/route.ts`
  - 依存: Task 3.1
  - 詳細:
    - Task 4.1と同等の修正（`params.id`使用）
    - 設計参照: Section 3, 5-2, C-005

- [ ] **Task 4.3**: import文の更新
  - 成果物: `src/app/api/worktrees/route.ts`, `src/app/api/worktrees/[id]/route.ts`
  - 依存: Task 4.1, Task 4.2
  - 詳細:
    - 削除: `import { detectThinking, stripAnsi, getCliToolPatterns } from '@/lib/cli-patterns'`
    - 削除: `import { detectPrompt } from '@/lib/prompt-detector'`
    - 追加: `import { detectSessionStatus } from '@/lib/status-detector'`
    - 注: `stripAnsi`, `detectThinking`, `getCliToolPatterns`, `detectPrompt` が他の箇所で使われていないか確認後に削除

### Phase 5: 回帰テスト・全体検証

- [ ] **Task 5.1**: status-detector テスト全パス
  - コマンド: `npx vitest run src/lib/__tests__/status-detector.test.ts`
  - 依存: Task 4.3

- [ ] **Task 5.2**: 関連テスト全パス
  - コマンド:
    ```bash
    npx vitest run tests/unit/prompt-detector.test.ts
    npx vitest run tests/unit/lib/auto-yes-manager.test.ts
    npx vitest run tests/unit/api/prompt-response-verification.test.ts
    npx vitest run src/lib/__tests__/cli-patterns.test.ts
    npx vitest run tests/unit/lib/cli-patterns.test.ts
    ```
  - 依存: Task 4.3

- [ ] **Task 5.3**: 品質チェック
  - コマンド:
    ```bash
    npx tsc --noEmit
    npm run lint
    npm run test:unit
    ```
  - 依存: Task 5.1, Task 5.2

---

## タスク依存関係

```mermaid
graph TD
    T11[Task 1.1<br/>StatusDetectionResult<br/>hasActivePrompt追加] --> T12[Task 1.2<br/>JSDoc更新]
    T11 --> T21[Task 2.1<br/>テストケース追加<br/>Red]
    T21 --> T31[Task 3.1<br/>テスト通過確認<br/>Green]
    T31 --> T41[Task 4.1<br/>route.ts修正]
    T31 --> T42[Task 4.2<br/>[id]/route.ts修正]
    T41 --> T43[Task 4.3<br/>import整理]
    T42 --> T43
    T43 --> T51[Task 5.1<br/>status-detectorテスト]
    T43 --> T52[Task 5.2<br/>関連テスト]
    T51 --> T53[Task 5.3<br/>品質チェック]
    T52 --> T53
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| ESLint | `npm run lint` | エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 成果物チェックリスト

### コード
- [ ] `src/lib/status-detector.ts` — `hasActivePrompt: boolean`フィールド追加、JSDoc更新
- [ ] `src/app/api/worktrees/route.ts` — インラインロジック→`detectSessionStatus()`呼び出し
- [ ] `src/app/api/worktrees/[id]/route.ts` — 同上

### テスト
- [ ] `src/lib/__tests__/status-detector.test.ts` — 8テストケース追加（Issue #180固有）

### ドキュメント
- [ ] README更新不要（内部バグ修正のため）

---

## Definition of Done

Issue完了条件：
- [ ] すべてのタスクが完了
- [ ] Issue #180固有の8テストケース全パス
- [ ] 既存の回帰テスト全パス（prompt-detector, auto-yes-manager, cli-patterns, status-detector）
- [ ] CIチェック全パス（lint, type-check, test:unit, build）
- [ ] 不要なimport削除完了
- [ ] 受け入れ条件（Issue #180の14項目）の機能要件・テスト要件をコードレベルで達成

---

## 次のアクション

作業計画承認後：
1. **ブランチ**: `feature/180-worktree`（既存）
2. **TDD実装**: `/pm-auto-dev 180`で自動実装
3. **進捗報告**: `/progress-report`で定期報告
4. **PR作成**: `/create-pr`で自動作成

---

*Generated by work-plan command for Issue #180*
