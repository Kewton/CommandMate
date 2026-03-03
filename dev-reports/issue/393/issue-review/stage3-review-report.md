# Issue #393 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 2 |

### 破壊的変更リスク: **Low**

Issue #393 の修正影響範囲は、Issue 本文で記載されている 3 ファイルにとどまらず、直接影響 3 ファイル + 間接影響 15 ファイルに波及する。ただし、修正は内部実装の変更が中心であり、公開 API の変更を伴わないため、破壊的変更のリスクは低い。最大の課題はテストカバレッジの不足であり、修正の正しさを検証するためのテスト追加が必須である。

---

## 影響ファイルマップ

### 直接影響（修正必須）

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/terminal/route.ts` | CLIToolManager 経由に修正、cliToolId バリデーション追加、DB 存在確認追加 |
| `src/app/api/worktrees/[id]/capture/route.ts` | 同上 |
| `src/lib/tmux.ts` | 全 8 関数の exec() を execFile() に移行 |

### 間接影響（修正または確認が必要）

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/cli-tools/codex.ts` | 直接 exec() 呼び出し 4 箇所を tmux.ts 関数に統一 |
| `src/lib/claude-session.ts` | 直接 exec() 呼び出し 1 箇所を tmux.ts 関数に統一 |
| `src/lib/cli-session.ts` | tmux.ts の内部変更による動作確認 |
| `src/lib/cli-tools/base.ts` | getSessionName() パターンのリファレンス（変更不要） |
| `src/lib/cli-tools/validation.ts` | isValidWorktreeId() の移動候補 |
| `src/lib/cli-tools/types.ts` | isCliToolType() のリファレンス（変更不要） |
| `src/lib/cli-tools/gemini.ts` | tmux.ts 経由のため内部変更の影響確認 |
| `src/lib/cli-tools/vibe-local.ts` | 同上 |
| `src/lib/cli-tools/opencode.ts` | execFile() のリファレンス実装として参考可能 |
| `src/lib/pasted-text-helper.ts` | tmux.ts 経由のため内部変更の影響確認 |
| `src/lib/prompt-answer-sender.ts` | 同上 |
| `tests/unit/tmux.test.ts` | モック対象変更（exec -> execFile）が必要 |
| `tests/unit/cli-tools/validation.test.ts` | 既存テスト（変更不要、動作確認のみ） |

---

## Must Fix（必須対応）

### IF001: tmux.ts の exec() 移行は全 8 関数に影響し、CLI ツール実装の直接 exec() も修正対象

**カテゴリ**: 影響範囲
**対象ファイル**: `src/lib/tmux.ts`, `src/lib/cli-tools/codex.ts`, `src/lib/claude-session.ts`

**問題**:
Issue の推奨方向性は tmux.ts 内の exec() を execFile() に移行することだが、影響は tmux.ts の 8 関数（hasSession, createSession, sendKeys, sendSpecialKeys, sendSpecialKey, capturePane, killSession, ensureSession）にとどまらない。codex.ts と claude-session.ts が tmux.ts を迂回して直接 exec() で tmux コマンドを実行しており、これらも修正対象に含まれなければ不整合が生じる。

**証拠**:

codex.ts の直接 exec() 呼び出し（4 箇所）:
```typescript
// codex.ts:102
await execAsync(`tmux send-keys -t "${sessionName}" Down`);
// codex.ts:104
await execAsync(`tmux send-keys -t "${sessionName}" Enter`);
// codex.ts:139
await execAsync(`tmux send-keys -t "${sessionName}" C-m`);
// codex.ts:170
await execAsync(`tmux send-keys -t "${sessionName}" C-d`);
```

claude-session.ts の直接 exec() 呼び出し（1 箇所）:
```typescript
// claude-session.ts:783
await execAsync(`tmux send-keys -t "${sessionName}" C-d`);
```

**推奨対応**:
Issue の Affected Code に codex.ts と claude-session.ts の直接 exec() 呼び出し箇所を追記する。修正時にはこれらを tmux.ts の既存関数（sendSpecialKey / sendSpecialKeys）に置き換えるか、execFile() に統一する。

---

### IF002: terminal/route.ts および capture/route.ts のユニットテストが存在しない

**カテゴリ**: テスト不足
**対象ファイル**: tests/ 配下（新規作成が必要）

**問題**:
tests/ 配下を調査した結果、terminal/route.ts と capture/route.ts に対応するテストファイルが存在しない。修正後にリグレッションを防ぐためには、以下のテストケースが必要:

1. cliToolId のバリデーション（CLI_TOOL_IDS 以外を拒否）
2. worktreeId の DB 存在確認（未登録 ID で 404 を返す）
3. セッション名インジェクション防止（shell メタ文字を含む入力でエラーを返す）
4. 正常系: 有効な入力で CLIToolManager 経由のセッション名を使用する

**証拠**:
```bash
# tests/ 配下に terminal/capture 関連テストなし
$ glob tests/**/*terminal* -> No files found
$ glob tests/**/*capture* -> No files found
```

**推奨対応**:
修正と同時に terminal/route.ts と capture/route.ts のユニットテストを作成し、セキュリティ修正の正しさを検証可能にする。

---

## Should Fix（推奨対応）

### IF003: tmux.ts の API 変更が全呼び出し元と既存テストに影響する

**カテゴリ**: 影響範囲
**対象ファイル**: `tests/unit/tmux.test.ts` + tmux.ts をインポートする 13 ファイル

**問題**:
tmux.ts は 13 ファイルからインポートされている。exec() から execFile() への内部実装変更は外部インターフェースを変更しないが、tests/unit/tmux.test.ts は `vi.mock('child_process', ...)` で exec をモックしているため、execFile への移行後にテスト修正が必要。

**証拠**:
```typescript
// tests/unit/tmux.test.ts:21-23
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));
```

**推奨対応**:
tmux.ts のリファクタリング時に tests/unit/tmux.test.ts のモック対象を exec から execFile に変更する。エラーハンドリングの互換性テストも追加する。

---

### IF004: codex.ts の直接 exec() 呼び出しが安全なラッパーを迂回している

**カテゴリ**: 依存関係
**対象ファイル**: `src/lib/cli-tools/codex.ts`, `src/lib/claude-session.ts`

**問題**:
codex.ts は startSession() と sendMessage() で tmux.ts の sendKeys() を使用しつつ、特殊キー送信（Down, Enter, C-m, C-d）については直接 execAsync() を呼び出している。tmux.ts には sendSpecialKey() が存在し、ALLOWED_SPECIAL_KEYS でホワイトリスト検証を行う sendSpecialKeys() も存在する。直接 exec() 呼び出しはこの安全層を迂回している。

**証拠**:
```typescript
// tmux.ts の安全な sendSpecialKeys (ホワイトリスト検証あり)
const ALLOWED_SPECIAL_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right',
  'Enter', 'Space', 'Tab', 'Escape',
  'BSpace', 'DC',
]);

// codex.ts は安全な関数を使わず直接 exec
await execAsync(`tmux send-keys -t "${sessionName}" Down`);   // sendSpecialKeys で代替可能
await execAsync(`tmux send-keys -t "${sessionName}" Enter`);  // 同上
```

**推奨対応**:
codex.ts の直接 exec() 呼び出しを tmux.ts の sendSpecialKey() / sendSpecialKeys() に置き換える。claude-session.ts:783 の C-d 送信も sendSpecialKey(sessionName, 'C-d') に置き換える。

---

### IF005: tmux.ts のセッション名インジェクション防止テストが不足

**カテゴリ**: テスト不足
**対象ファイル**: `tests/unit/tmux.test.ts`

**問題**:
tests/unit/tmux.test.ts にはセッション名にシェルメタ文字が含まれる場合のテストケースがない。tests/unit/cli-tools/validation.test.ts では validateSessionName() の単体テストが充実しているが、tmux.ts の各関数レベルでのインジェクション防止テストがない。

**推奨対応**:
execFile() 移行後に以下のテストを追加:
- hasSession にシェルメタ文字を含む sessionName を渡した場合に引数配列として安全に渡される
- createSession に危険な文字を含む workingDirectory を渡した場合に安全に処理される
- sendKeys にシェルメタ文字を含む sessionName を渡した場合に安全に処理される

---

### IF006: getSessionName() パターンが 4 箇所に分散し統一されていない

**カテゴリ**: 影響範囲
**対象ファイル**: `src/lib/cli-session.ts`, `src/lib/claude-session.ts`, `src/app/api/worktrees/[id]/terminal/route.ts`, `src/app/api/worktrees/[id]/capture/route.ts`

**問題**:
セッション名生成パターンが以下の 4 箇所に分散している:

| 箇所 | バリデーション | 方式 |
|------|--------------|------|
| BaseCLITool.getSessionName() | あり (validateSessionName()) | CLIToolManager 経由 |
| cli-session.ts:81-85 | あり (CLIToolManager 経由) | CLIToolManager 経由 |
| claude-session.ts:454-456 | なし | 直接文字列結合 |
| terminal/route.ts:11-13 | なし | 直接文字列結合 |
| capture/route.ts:11-13 | なし | 直接文字列結合 |

**推奨対応**:
全ての getSessionName() を CLIToolManager 経由に統一し、terminal/route.ts と capture/route.ts のローカル getSessionName() を削除する。claude-session.ts の getSessionName() については、ClaudeTool が claude-session.ts の関数をラップしている構造のため段階的な統一を検討する。

---

### IF007: terminal/route.ts のセッション自動作成削除は破壊的変更の可能性がある

**カテゴリ**: 後方互換性
**対象ファイル**: `src/app/api/worktrees/[id]/terminal/route.ts`, `src/components/Terminal.tsx`

**問題**:
terminal/route.ts:34-37 はセッションが存在しない場合に自動的に新しい tmux セッションを作成する。この動作を制限する場合、外部利用者への影響を考慮する必要がある。

**調査結果**:
src/ 配下に terminal/route.ts を REST API として直接呼び出しているコードは見つからなかった。Terminal.tsx は WebSocket (`ws://localhost:3000/terminal/...`) を使用しており、REST API (`POST /api/worktrees/[id]/terminal`) とは別経路である。

**推奨対応**:
セッション自動作成を制限する場合は、明確なエラーメッセージを返し、正規のセッション起動経路（`/api/worktrees/[id]/send`）への誘導を含める。

---

## Nice to Have（あれば良い）

### IF008: opencode.ts の execFile() パターンをリファレンス実装として活用

**カテゴリ**: 影響範囲
**対象ファイル**: `src/lib/cli-tools/opencode.ts`

opencode.ts:113-117 では既に execFileAsync を使用しており、SEC-001 コメントで injection 防止の意図を明記している。tmux.ts の移行時にこのパターンを参考にできる。

```typescript
// opencode.ts:113-117 -- 既存の安全なパターン
await execFileAsync('tmux', [
  'resize-window', '-t', sessionName,
  '-x', '80', '-y', String(OPENCODE_PANE_HEIGHT),
]);
```

---

### IF009: isValidWorktreeId() の配置が auto-yes-manager.ts に限定されている

**カテゴリ**: 依存関係
**対象ファイル**: `src/lib/auto-yes-manager.ts`, `src/lib/cli-tools/validation.ts`

isValidWorktreeId() は汎用バリデーション関数だが、auto-yes-manager.ts 内に定義されている。terminal/route.ts と capture/route.ts の修正で worktreeId バリデーションを追加する際、validation.ts に移動して共通化するとより適切な配置となる。

---

## テストギャップ一覧

| テスト不足箇所 | 優先度 | 理由 |
|--------------|--------|------|
| terminal/route.ts のユニットテスト | 高 | 脆弱性修正の正しさ検証に必須 |
| capture/route.ts のユニットテスト | 高 | 同上 |
| tmux.ts のインジェクション防止テスト | 中 | exec->execFile 移行の安全性検証 |
| codex.ts の直接 exec() に対するテスト | 中 | 移行漏れ防止 |
| claude-session.ts の直接 exec() に対するテスト | 中 | 同上 |
| exec() -> execFile() 移行後のエラーハンドリング互換テスト | 中 | 既存動作のリグレッション防止 |

---

## 参照ファイル一覧

### 直接修正が必要なファイル
- `src/app/api/worktrees/[id]/terminal/route.ts` -- 主要脆弱性エンドポイント
- `src/app/api/worktrees/[id]/capture/route.ts` -- 同一脆弱性パターン
- `src/lib/tmux.ts` -- exec() -> execFile() 移行対象

### 間接修正が必要なファイル
- `src/lib/cli-tools/codex.ts` -- 直接 exec() 呼び出し 4 箇所
- `src/lib/claude-session.ts` -- 直接 exec() 呼び出し 1 箇所

### 安全パターンのリファレンス
- `src/lib/cli-tools/base.ts` -- getSessionName() + validateSessionName()
- `src/lib/cli-tools/validation.ts` -- SESSION_NAME_PATTERN
- `src/lib/cli-tools/types.ts` -- CLI_TOOL_IDS, isCliToolType()
- `src/lib/cli-tools/opencode.ts` -- execFileAsync() の既存実装例
- `src/app/api/worktrees/[id]/kill-session/route.ts` -- CLI_TOOL_IDS.includes() + CLIToolManager の安全パターン

### テスト関連
- `tests/unit/tmux.test.ts` -- モック変更が必要
- `tests/unit/cli-tools/validation.test.ts` -- 既存テスト（変更不要）
