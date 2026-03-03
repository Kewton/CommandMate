# Architecture Review: Issue #393 - Stage 2 整合性レビュー

## 基本情報

| 項目 | 内容 |
|------|------|
| Issue | #393 - security: authenticated RCE and shell injection via /api/worktrees/[id]/terminal |
| Stage | 2 - 整合性レビュー |
| Focus | 設計方針書 vs 実コードベースの整合性検証 |
| Status | 条件付き承認 (Conditionally Approved) |
| Score | 4/5 |
| Date | 2026-03-03 |

---

## Executive Summary

設計方針書（Stage 1 レビュー反映済み）と実際のコードベースを照合した結果、全体的に高い整合性を確認した。主要な設計項目（D1-001 の isCliToolType() 存在確認、D1-003 の CLIToolManager 経由パターン、D2 の exec() 使用箇所特定、D3 の行番号参照）は全て実コードと正確に一致している。

must_fix は1件（claude-session.ts の sanitizeSessionEnvironment() における exec() のスコープ判断根拠の文書化不足）で、これはセキュリティリスクではなく設計文書の明確化の問題。should_fix 5件は実装時の正確性を高めるための補足事項。

---

## 整合性検証結果

### D1: エンドポイントバリデーション

#### D1-001: isCliToolType() の存在確認

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| `isCliToolType()` が `src/lib/cli-tools/types.ts` に存在 | line 100-102 に存在 | なし |
| 型ガード (`value is CLIToolType`) を返す | `return (CLI_TOOL_IDS as readonly string[]).includes(value)` | 一致 |
| `CLI_TOOL_IDS` からのホワイトリスト検証 | `CLI_TOOL_IDS = ['claude', 'codex', 'gemini', 'vibe-local', 'opencode'] as const` (line 10) | 一致 |

**判定: 完全一致**

#### D1-002: getWorktreeById() の存在確認

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| `getWorktreeById()` による DB ルックアップ | `src/lib/db.ts:305` に `getWorktreeById(db: Database.Database, id: string): Worktree \| null` として存在 | インポート元ファイル名が設計書に未記載 |
| 参照: respond/route.ts:126-131 | line 126: `const worktree = getWorktreeById(db, params.id)` -- 正確に一致 | なし |
| 参照: kill-session/route.ts:28-34 | line 28: `const worktree = getWorktreeById(db, params.id)` -- 正確に一致 | なし |

**判定: 概ね一致（インポート元の明記推奨 [R2F001]）**

#### D1-003: CLIToolManager 経由パターン

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| `CLIToolManager.getInstance().getTool(cliToolId).getSessionName(worktreeId)` パターン | respond/route.ts:138-142 で使用 | 一致 |
| `BaseCLITool.getSessionName()` が `validateSessionName()` を呼び出す | base.ts:46-49 で確認 | 一致 |
| terminal/route.ts にローカル getSessionName() が存在 | line 11-13: `function getSessionName(...)` - 存在確認 | 設計書の廃止方針と一致 |
| capture/route.ts にローカル getSessionName() が存在 | line 11-13: `function getSessionName(...)` - 存在確認 | 設計書の廃止方針と一致 |

**判定: 完全一致** -- 廃止対象のローカル関数と参照先の安全パターンの両方が正確に特定されている。

#### D1-004: セッション自動作成の制限

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| terminal/route.ts にセッション不在時の `createSession()` 呼び出しが存在 | line 34-37: `if (!sessionExists) { await tmux.createSession(...) }` | 一致。廃止対象として正確に特定 |
| sendToTmux() プライベート関数の扱い | line 55-58: `async function sendToTmux(...)` | 設計書に未記載 [R2F009] |

**判定: 概ね一致（sendToTmux() の扱いが未定義 [R2F009]）**

---

### D2: tmux.ts exec() -> execFile() 移行

#### D2-002: 対象関数と exec() 箇所の照合

| 関数 | 設計書の行 | 実コードの行 | exec() パターン | 一致 |
|------|-----------|-------------|----------------|------|
| `isTmuxAvailable()` | - | line 47 | `execAsync('tmux -V', ...)` | OK |
| `hasSession()` | - | line 70 | `execAsync(\`tmux has-session -t "${sessionName}"\`, ...)` | OK |
| `listSessions()` | - | line 91-93 | `execAsync('tmux list-sessions -F "..."', ...)` | OK |
| `createSession()` (new-session) | - | line 175-177 | `execAsync(\`tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"\`, ...)` | OK |
| `createSession()` (set-option) | - | line 181-183 | `execAsync(\`tmux set-option -t "${sessionName}" history-limit ${historyLimit}\`, ...)` | OK |
| `sendKeys()` | - | line 220 | `execAsync(command, ...)` (シングルクォートエスケープ付き) | OK |
| `sendSpecialKeys()` | - | line 267 | `execAsync(\`tmux send-keys -t "${sessionName}" ${keys[i]}\`, ...)` | OK |
| `capturePane()` | - | line 338-339 | `execAsync(\`tmux capture-pane -t "${sessionName}" -p -e -S ${startLine} -E ${endLine}\`, ...)` | OK |
| `killSession()` | - | line 368 | `execAsync(\`tmux kill-session -t "${sessionName}"\`, ...)` | OK |
| `sendSpecialKey()` | - | line 440-442 | `execAsync(\`tmux send-keys -t "${sessionName}" ${key}\`, ...)` | OK |

**判定: 完全一致** -- 全11箇所の exec() 呼び出しが正確に特定されている。ただし関数数の表記に曖昧さあり [R2F002]。

#### D2-005: ALLOWED_SPECIAL_KEYS の確認

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| `ALLOWED_SPECIAL_KEYS` に `Down`, `Enter` が含まれる | line 231-235: `new Set(['Up', 'Down', 'Left', 'Right', 'Enter', 'Space', 'Tab', 'Escape', 'BSpace', 'DC'])` | 一致 |
| `SpecialKey` 型: `'Escape' \| 'C-c' \| 'C-d' \| 'C-m' \| 'Enter'` | line 416: `type SpecialKey = 'Escape' \| 'C-c' \| 'C-d' \| 'C-m' \| 'Enter'` | 一致 |
| D2-005 で `ALLOWED_SINGLE_SPECIAL_KEYS = new Set(['Escape', 'C-c', 'C-d', 'C-m', 'Enter'])` を追加する方針 | 未実装（設計方針段階） | 設計は正確。同期保証メカニズム未定義 [R2F007] |

**判定: 一致。SpecialKey 型と Set の同期方法の明確化推奨 [R2F007]**

---

### D3: codex.ts / claude-session.ts の直接 exec() 統一

#### D3-001: codex.ts の修正箇所

| 設計書の行 | 実コードの行 | コード内容 | 所属関数 | 移行先 | 一致 |
|-----------|-------------|-----------|---------|--------|------|
| 102 | 102 | `execAsync(\`tmux send-keys ... Down\`)` | `startSession()` | `tmux.sendSpecialKeys(sessionName, ['Down'])` | OK |
| 104 | 104 | `execAsync(\`tmux send-keys ... Enter\`)` | `startSession()` | `tmux.sendSpecialKeys(sessionName, ['Enter'])` | OK |
| 139 | 139 | `execAsync(\`tmux send-keys ... C-m\`)` | `sendMessage()` | `tmux.sendSpecialKey(sessionName, 'C-m')` | OK |
| 170 | 170 | `execAsync(\`tmux send-keys ... C-d\`)` | `killSession()` | `tmux.sendSpecialKey(sessionName, 'C-d')` | OK |

**判定: 完全一致** -- 全4箇所の行番号、コード内容、移行先が正確。

#### D3-002: claude-session.ts の修正箇所

| 設計書の行 | 実コードの行 | コード内容 | 所属関数 | 移行先 | 一致 |
|-----------|-------------|-----------|---------|--------|------|
| 783 | 783 | `execAsync(\`tmux send-keys ... C-d\`)` | `stopClaudeSession()` | `tmux.sendSpecialKey(sessionName, 'C-d')` | OK |

**判定: 完全一致**

#### D3-003: codex.ts のインポート変更

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| exec/execAsync インポートが不要になるか確認 | line 14: `import { exec } from 'child_process'`, line 18: `const execAsync = promisify(exec)` -- 4箇所修正後は不要 | 一致 |
| 追加インポートの必要性 | 現在 `sendSpecialKeys`, `sendSpecialKey` は未インポート | 設計書に追加インポートが未明記 [R2F012] |

**判定: 概ね一致（追加インポートの明記推奨 [R2F012]）**

---

### D4: テスト設計の整合性

#### D4-003: 既存テストのモック変更

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| tmux.test.ts が `exec` をモックしている | line 21-23: `vi.mock('child_process', () => ({ exec: vi.fn() }))` | 一致 |
| exec -> execFile へのモック変更が必要 | 全テスト（16テストケース）が `exec` ベース | 変更箇所の規模は正確に評価済み |

#### D4-001/D4-002: 新規テストファイル

| 設計書の記載 | 実装状況 | 差異 |
|-------------|---------|------|
| `tests/unit/terminal-route.test.ts` 新規作成 | 現在存在しない | 設計どおり |
| `tests/unit/capture-route.test.ts` 新規作成 | 現在存在しない | 設計どおり |
| 既存 API テストの配置 | `tests/unit/api/` ディレクトリに存在 | 配置場所の不整合 [R2F011] |

**判定: 概ね一致（テスト配置場所の検討推奨 [R2F011]）**

---

### 非スコープ項目の検証

| 設計書の非スコープ | 実コード確認 | リスク評価 |
|------------------|-------------|-----------|
| line 237: `which claude` | 固定文字列、ユーザー入力なし | 低リスク - 判断妥当 |
| line 250: `test -x "${path}"` | path は固定配列の要素 | 低リスク - 判断妥当 |
| line 417: `tmux set-environment -g -u CLAUDECODE 2>/dev/null \|\| true` | 固定引数だがシェル構文依存 | 低リスクだが根拠文書化が必要 [R2F003] |
| line 465: `which claude` | 固定文字列、ユーザー入力なし | 低リスク - 判断妥当 |
| base.ts:29: `which ${this.command}` | this.command はハードコード値 | 低リスク - 判断妥当 |

---

## Findings

### Must Fix (1件)

#### R2F003: sanitizeSessionEnvironment() の exec() スコープ判断根拠の文書化

- **カテゴリ**: 設計漏れ
- **ファイル**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-393/src/lib/claude-session.ts` line 417
- **内容**: `execAsync('tmux set-environment -g -u CLAUDECODE 2>/dev/null || true')` はシェルリダイレクトと OR 演算子に依存しており execFile() に直接移行できない。tmux コマンドであるためスコープ内として検討すべきだが、固定引数のためインジェクションリスクは無い。非スコープとする根拠の文書化が必要。
- **提案**: 非スコープの理由を設計方針書に明記する。代替として `execFileAsync('tmux', ['set-environment', '-g', '-u', 'CLAUDECODE'])` + try-catch パターンへの移行も技術的に可能だが、YAGNI として別 Issue 化が妥当。

### Should Fix (5件)

#### R2F001: getWorktreeById() のインポート元明記

- **カテゴリ**: 参照誤り
- **内容**: 設計方針書 D1-002 に `import { getWorktreeById } from '@/lib/db'` を明記すべき。`src/lib/db-repository.ts` には存在しない。
- **参照コード**:
  ```typescript
  // src/app/api/worktrees/[id]/respond/route.ts:8
  import { getMessageById, updatePromptData, getWorktreeById } from '@/lib/db';

  // src/app/api/worktrees/[id]/kill-session/route.ts:14
  import { getWorktreeById, deleteSessionState, deleteAllMessages, deleteMessagesByCliTool } from '@/lib/db';
  ```

#### R2F002: 関数数と exec() 箇所数の混同

- **カテゴリ**: 設計漏れ
- **内容**: 「全10関数」は不正確。実際は9関数、11箇所の exec() 呼び出し。

#### R2F007: SpecialKey 型と ALLOWED_SINGLE_SPECIAL_KEYS の同期保証メカニズム未定義

- **カテゴリ**: 設計漏れ
- **内容**: TypeScript のリテラルユニオン型はランタイムで列挙できないため、テストでの自動検証方法を明記すべき。
- **提案**: `CLI_TOOL_IDS` / `CLIToolType` パターンに合わせ、`const SPECIAL_KEY_VALUES = ['Escape', 'C-c', 'C-d', 'C-m', 'Enter'] as const; type SpecialKey = typeof SPECIAL_KEY_VALUES[number];` とする。

#### R2F009: terminal/route.ts の sendToTmux() の扱いが未定義

- **カテゴリ**: 設計漏れ
- **内容**: D1-003 で `import * as tmux` を廃止する方針だが、sendToTmux() 内の `tmux.sendKeys()` を何に置き換えるか未明確。
- **関連コード**:
  ```typescript
  // src/app/api/worktrees/[id]/terminal/route.ts:55-58
  async function sendToTmux(sessionName: string, command: string): Promise<void> {
    await tmux.sendKeys(sessionName, command);
  }
  ```

#### R2F012: codex.ts の追加インポート未明記

- **カテゴリ**: 設計漏れ
- **内容**: D3-001 の修正で `sendSpecialKeys` と `sendSpecialKey` のインポート追加が必要だが、設計方針書に未記載。

### Nice to Have (6件)

| ID | カテゴリ | タイトル | 判断 |
|----|---------|---------|------|
| R2F004 | 参照誤り | 行番号参照に関数名ベースの補足 | 現時点の行番号は正確。実装に支障なし |
| R2F005 | 整合性不一致 | codex.ts 行番号は正確（所属関数名の補足推奨） | 実装に支障なし |
| R2F006 | 整合性不一致 | claude-session.ts Line 783 は正確 | 実装に支障なし |
| R2F008 | 整合性不一致 | isCliToolType() 型ナローイングの暗黙的依存 | TypeScript 標準パターン。実装に支障なし |
| R2F010 | 整合性不一致 | listSessions() フォーマット文字列の execFile() 互換性 | 問題なし。設計の記載で十分 |
| R2F011 | 整合性不一致 | テストファイル配置場所の検討 | 既存パターンに厳密な規約なし |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | sendToTmux() の移行方針未確定による実装時の判断遅延 | Low | Medium | P2 |
| セキュリティ | sanitizeSessionEnvironment() の exec() が残留するが固定引数のためリスクなし | Low | Low | P3 |
| 運用リスク | テストファイル配置の不統一 | Low | Low | P3 |

---

## Recommendations

### 設計方針書への反映推奨事項

1. **D1-002**: `getWorktreeById` のインポート元を `'@/lib/db'` と明記
2. **D2-002**: 「全10関数」を「9関数・11箇所」に修正
3. **D2-005/D2-006**: SpecialKey 型を `const SPECIAL_KEY_VALUES = [...] as const` から派生させるパターンを提案
4. **D1-003/D1-004**: sendToTmux() の廃止方針を明記
5. **D3-003**: codex.ts への `sendSpecialKeys`, `sendSpecialKey` インポート追加を明記
6. **Section 8**: line 417 の非スコープ理由（シェル構文依存、固定引数）を明記

---

## Approval

| 項目 | 判定 |
|------|------|
| 設計書 vs コードの整合性 | 高 |
| 行番号・関数参照の正確性 | 高 |
| 安全パターン参照の整合性 | 高 |
| 非スコープの適切性 | 中（文書化不足1件） |
| テスト設計の整合性 | 高 |
| **総合判定** | **条件付き承認 (4/5)** |

条件: R2F003（sanitizeSessionEnvironment の exec() スコープ根拠文書化）を設計方針書に反映すること。

---

*Generated by architecture-review-agent for Issue #393 Stage 2*
*Review date: 2026-03-03*
