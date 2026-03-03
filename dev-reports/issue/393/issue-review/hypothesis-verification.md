# Issue #393 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | 任意の `command` 入力がバリデーションなしで `tmux.sendKeys()` に転送される | Confirmed | route.ts:20→40→tmux.ts:207-225 |
| 2 | セッション不在時、エンドポイントが `tmux.createSession()` でシェルを新規作成する | Confirmed | route.ts:34-37 |
| 3 | セッション名は `mcbd-${cliToolId}-${worktreeId}` で手動構築される | Confirmed | route.ts:11-13 |
| 4 | `cliToolId` は型キャストのみで実行時バリデーションなし | Confirmed | route.ts:29 |
| 5 | tmux ヘルパーは `child_process.exec()` で文字列補間したコマンドを実行する | Confirmed | tmux.ts:6,70,176,216 |
| 6 | 攻撃者制御のダブルクォートがシェルコンテキストを突破できる | Confirmed | tmux.ts:70, 文字列補間でのインジェクション実証 |
| 7 | 他の CLI ルートは `BaseCLITool.getSessionName()` → `validateSessionName()` を経由する | Confirmed | base.ts:46-49, validation.ts:35-39 |

## 詳細検証

### 仮説 1: 任意のコマンドがバリデーションなしで転送される

**Issue内の記述**: "The endpoint accepts arbitrary `command` input and forwards it to `tmux.sendKeys()` without any allowlist or command restrictions."

**検証手順**:
1. `src/app/api/worktrees/[id]/terminal/route.ts:20` - `command` をそのまま JSON から読み取り
2. `route.ts:40` - `sendToTmux(sessionName, command)` に直接転送
3. `route.ts:55-57` - `sendToTmux` は `tmux.sendKeys(sessionName, command)` を呼ぶだけ
4. `src/lib/tmux.ts:207-225` - `sendKeys()` はシングルクォートのエスケープのみ行い、コマンド自体はそのまま tmux セッションへ送信

**判定**: Confirmed

**根拠**:
```typescript
// route.ts:20
const { cliToolId, command } = await req.json();
// 一切のバリデーションなし

// route.ts:40
await sendToTmux(sessionName, command);

// tmux.ts:213-216（sendKeys内）
const escapedKeys = keys.replace(/'/g, "'\\''");  // シングルクォートのみエスケープ
const command = sendEnter
  ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
```
コマンド内容はシングルクォートで囲まれているが、これはあくまで tmux へ渡すコンテンツの保護であり、シェルで実行するコマンド自体の制限にはならない。

---

### 仮説 2: セッション不在時にシェルセッションを新規作成する

**Issue内の記述**: "If the tmux session does not exist, the endpoint creates one via `tmux.createSession(sessionName, process.cwd())`"

**検証手順**:
1. `route.ts:32` - `tmux.hasSession(sessionName)` でセッション存在確認
2. `route.ts:34-37` - 存在しない場合 `tmux.createSession(sessionName, process.cwd())` でシェルセッション作成
3. `tmux.ts:176` - シェルの新規作成が行われる

**判定**: Confirmed

**根拠**:
```typescript
// route.ts:32-37
const sessionExists = await tmux.hasSession(sessionName);
if (!sessionExists) {
  // 認証済みユーザーが任意のシェルセッションを作成可能
  await tmux.createSession(sessionName, process.cwd());
}
```

---

### 仮説 3: セッション名を手動で構築している

**Issue内の記述**: "constructs the session name manually: `mcbd-${cliToolId}-${worktreeId}`"

**判定**: Confirmed

**根拠**:
```typescript
// route.ts:11-13
function getSessionName(worktreeId: string, cliToolId: CLIToolType): string {
  return `mcbd-${cliToolId}-${worktreeId}`;
}
```
バリデーションなしで直接文字列補間している。

---

### 仮説 4: `cliToolId` が型キャストのみ

**Issue内の記述**: "Because `cliToolId` is only cast (`as CLIToolType`) and not validated"

**判定**: Confirmed

**根拠**:
```typescript
// route.ts:29
const sessionName = getSessionName(params.id, cliToolId as CLIToolType);
```
TypeScript の `as CLIToolType` はコンパイル時の型アサーションであり、実行時のランタイムバリデーションは一切行われない。任意の文字列が `CLIToolType` として扱われる。

---

### 仮説 5: `child_process.exec()` で文字列補間コマンドを実行

**Issue内の記述**: "tmux helpers execute shell commands using `child_process.exec()` with interpolated string commands"

**判定**: Confirmed

**根拠**:
```typescript
// tmux.ts:6
import { exec } from 'child_process';
// ...
// tmux.ts:70 - hasSession
await execAsync(`tmux has-session -t "${sessionName}"`, { timeout: DEFAULT_TIMEOUT });

// tmux.ts:176 - createSession
await execAsync(`tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`, ...);

// tmux.ts:216 - sendKeys
`tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
```
全て `exec()` を使用しており、シェル経由で実行される。

---

### 仮説 6: ダブルクォートによるシェルインジェクション

**Issue内の記述**: "attacker-controlled double quotes or other shell syntax in `sessionName` can break out of the quoted context"

**判定**: Confirmed

**根拠**:
`cliToolId` = `x"; touch /tmp/session-name-injection; #` の場合:

```
sessionName = "mcbd-x"; touch /tmp/session-name-injection; #-example"

実行されるシェルコマンド:
tmux has-session -t "mcbd-x"; touch /tmp/session-name-injection; #-example"
                             ^ ここでダブルクォートが閉じる
                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 任意コマンドが実行される
```

`exec()` はシェルを介して実行するため、セッション名内の `"` がクォートコンテキストを突破できる。

---

### 仮説 7: 他の CLI ルートは `validateSessionName()` を経由する

**Issue内の記述**: "Other CLI-tool flows generally go through `CLIToolManager` and `BaseCLITool.getSessionName()`, which validates session names with `validateSessionName()`."

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/cli-tools/base.ts:46-49
getSessionName(worktreeId: string): string {
  const sessionName = `mcbd-${this.id}-${worktreeId}`;
  validateSessionName(sessionName);  // 検証あり
  return sessionName;
}

// src/lib/cli-tools/validation.ts:20,35-39
export const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function validateSessionName(sessionName: string): void {
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error(`Invalid session name format: ${sessionName}`);
  }
}
```

terminal/route.ts の独自 `getSessionName()` 関数はこのバリデーション層を完全にバイパスしている。

---

## Stage 1レビューへの申し送り事項

全仮説がコードベースによって確認された（Confirmed）。Rejected な仮説は存在しない。

以下の点をレビュー時に重点確認すること：

1. **セキュリティの深刻度**: 全 2 種類の攻撃経路（Case 1: 意図的動作の悪用、Case 2: セッション名インジェクション）が実コードで確認済み
2. **修正優先度**: `validateSessionName()` が `validation.ts` に既に存在しており、それを使用していないのが根本原因
3. **`execFile()` への移行**: `exec()` から `execFile()` への移行で shell injection を根本防止できる
4. **既存の安全モデルとの整合性**: `BaseCLITool.getSessionName()` の既存安全モデルを terminal ルートでも利用すべき
