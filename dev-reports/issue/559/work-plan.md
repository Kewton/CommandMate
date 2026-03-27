# 作業計画: Issue #559 - Copilot CLIスラッシュコマンド修正

## Issue: fix: Copilot CLIのスラッシュコマンドがテキストとして処理される場合がある
**Issue番号**: #559
**サイズ**: S
**優先度**: Medium
**依存Issue**: なし（#547, #545は完了済み）

## 設計方針

アプローチC改（全コマンド委譲パターン）を採用。Terminal APIでCopilotの場合のみ`cliTool.sendMessage()`に委譲する。copilot.tsの変更は不要。

---

## 詳細タスク分解

### Phase 1: 実装

- [ ] **Task 1.1**: terminal/route.ts にCopilot委譲ロジック追加
  - 成果物: `src/app/api/worktrees/[id]/terminal/route.ts`
  - 依存: なし
  - 内容:
    - L81付近に `if (cliToolId === 'copilot')` 分岐を追加
    - `cliTool.sendMessage(params.id, command)` に委譲
    - 委譲パスでは早期return（invalidateCacheはsendMessage内で実行済み）

### Phase 2: テスト

- [ ] **Task 2.1**: 既存テストモック修正
  - 成果物: `tests/unit/terminal-route.test.ts`
  - 依存: なし（実装と並行可能）
  - 内容:
    - `isCliToolType`モックに`'copilot'`を追加
    - `getTool()`モックに`sendMessage: vi.fn()`を追加

- [ ] **Task 2.2**: Copilot委譲テスト追加
  - 成果物: `tests/unit/terminal-route.test.ts`
  - 依存: Task 1.1, Task 2.1
  - テストケース:
    - `cliToolId='copilot'`, command='/model' → sendMessage()呼出確認
    - `cliToolId='copilot'`, command='hello' → sendMessage()呼出確認（通常テキストも委譲）
    - `cliToolId='copilot'`, command=' /model' → sendMessage()呼出確認（先頭空白含む）
    - `cliToolId='claude'`, command='/model' → sendKeys()呼出確認（Copilot以外は影響なし）
    - `cliToolId='copilot'`, sendMessage()がthrow → 500エラー返却確認
    - `cliToolId='copilot'` → sendKeys()が呼ばれないこと確認

- [ ] **Task 2.3**: 既存テスト回帰確認
  - 成果物: なし（既存テスト全パス確認）
  - 依存: Task 1.1, Task 2.1
  - 内容: `npm run test:unit` で全テストパス確認

### Phase 3: ドキュメント・検証

- [ ] **Task 3.1**: CLAUDE.md更新
  - 成果物: `CLAUDE.md`
  - 依存: Task 1.1
  - 内容:
    - `terminal/route.ts`エントリにCopilot委譲ロジックの存在を追記

- [ ] **Task 3.2**: 最終品質チェック
  - 依存: Task 2.2, Task 2.3, Task 3.1
  - 内容: TypeScript型チェック + ESLint + 単体テスト + ビルド

---

## タスク依存関係

```
Task 1.1 (terminal/route.ts修正) ──┐
                                    ├── Task 2.2 (Copilot委譲テスト)
Task 2.1 (既存モック修正) ──────────┤
                                    ├── Task 2.3 (回帰テスト)
                                    │
Task 3.1 (CLAUDE.md更新) ──────────── Task 3.2 (最終品質チェック)
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
- [ ] `src/app/api/worktrees/[id]/terminal/route.ts` - Copilot委譲ロジック

### テスト
- [ ] `tests/unit/terminal-route.test.ts` - モック修正 + Copilot委譲テスト追加

### ドキュメント
- [ ] `CLAUDE.md` - terminal/route.tsエントリ更新

---

## Definition of Done

- [ ] terminal/route.tsにCopilot委譲ロジックが実装されている
- [ ] Copilot全コマンド（スラッシュ/通常テキスト両方）がsendMessage()経由で処理される
- [ ] 他CLIツール（claude, codex等）の動作に影響がない
- [ ] 単体テスト全パス
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] CLAUDE.md更新完了

---

## 次のアクション

1. TDD実装開始（/pm-auto-dev）
2. 進捗報告（/progress-report）
3. PR作成（/create-pr）

---

*作成日: 2026-03-27*
*設計方針書: dev-reports/design/issue-559-copilot-slash-cmd-fix-design-policy.md*
