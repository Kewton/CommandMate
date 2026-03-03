# Issue #393 Stage 7 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7/8

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

## 前回指摘事項の反映状況

### Stage 3 影響範囲レビュー（1回目）指摘

| ID | 重要度 | タイトル | 状態 |
|----|--------|---------|------|
| IF001 | Must Fix | tmux.ts の exec() から execFile() への移行は全関数に影響し、全 CLI ツール実装に波及 | **Resolved** |
| IF002 | Must Fix | terminal/route.ts および capture/route.ts のユニットテストが存在しない | **Resolved** |
| IF003 | Should Fix | tmux.ts の API 変更が全ての呼び出し元に影響 | **Resolved** |
| IF004 | Should Fix | codex.ts の直接 exec() 呼び出しが tmux.ts の安全な関数を迂回 | **Resolved** |
| IF005 | Should Fix | tmux.ts のセッション名インジェクション防止テストが存在しない | **Resolved** |
| IF006 | Should Fix | cli-session.ts の getSessionName() が claude-session.ts と独立に存在 | **Resolved** |
| IF007 | Should Fix | terminal/route.ts からの session 自動作成の削除は既存利用者に影響する可能性 | **Resolved** |

### Stage 5 通常レビュー（2回目）指摘

| ID | 重要度 | タイトル | 状態 |
|----|--------|---------|------|
| S5F001 | Should Fix | tmux.ts の対象関数数「8」は不正確 -- 実際は 10 | **Resolved** |
| S5F002 | Should Fix | capture/route.ts の lines パラメータが未検証 | **Resolved** |

**全 9 件の前回指摘が Issue 本文に適切に反映されている。**

---

## Should Fix（推奨対応）

### S7F001: createSession() の historyLimit パラメータが exec() シェルコマンド文字列に直接補間されている件が Issue に未記載

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/tmux.ts`

**問題**:

`tmux.ts:182` で historyLimit が exec() のシェルコマンド文字列に直接補間されている:

```typescript
// tmux.ts:182
`tmux set-option -t "${sessionName}" history-limit ${historyLimit}`
```

Issue の Root Cause や Recommended Direction では `sessionName` と `workingDirectory` の補間リスクに言及しているが、`historyLimit` の補間については触れていない。TypeScript の型定義では `historyLimit` は `number` だが、JavaScript ランタイムでは型強制が行われないため、execFile() 移行時にはこのパラメータも引数配列に含める必要がある。

**現在の呼び出し元**（全てリテラル値 50000 で安全）:
- `src/lib/cli-tools/codex.ts:82`
- `src/lib/cli-tools/gemini.ts:87`
- `src/lib/cli-tools/vibe-local.ts:80`
- `src/lib/claude-session.ts:616`
- `src/lib/cli-tools/opencode.ts:105`

**推奨対応**:

Recommended Direction に以下を追記: 「Additionally, the historyLimit parameter in createSession() (tmux.ts:182) is interpolated into the set-option command string. While all current callers pass literal number 50000, the execFile() migration should include this parameter as an argument array element to maintain comprehensive injection protection.」

---

### S7F002: sendKeys() のシングルクォートエスケープは exec() 前提の防御であり execFile() 移行時に見直しが必要

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/tmux.ts`

**問題**:

`tmux.ts:213` のエスケープロジックと `tmux.ts:216-217` のクォーティング:

```typescript
// tmux.ts:213
const escapedKeys = keys.replace(/'/g, "'\\''");

// tmux.ts:216-217
const command = sendEnter
  ? `tmux send-keys -t "${sessionName}" '${escapedKeys}' C-m`
  : `tmux send-keys -t "${sessionName}" '${escapedKeys}'`;
```

この防御は exec() がシェルを経由する前提で機能している。execFile() に移行した場合:
1. シングルクォートエスケープは不要になる（シェルを経由しない）
2. keys は引数配列の一要素として直接渡せる
3. ただし、tmux の send-keys コマンドでは引数として渡されたテキストの扱いが exec() 経由時と異なる可能性がある（tmux 自体のクォーティング規則）

Issue の Recommended Direction では sendKeys の移行について具体的な注意事項が記載されていない。

**推奨対応**:

Recommended Direction に以下の注記を追加: 「The sendKeys() function (tmux.ts:207-225) currently escapes single quotes and wraps the key text in single quotes for shell-level protection. When migrating to execFile(), this escaping logic should be reviewed: the keys value can be passed directly as an argument array element without shell quoting, but tmux's own argument parsing for send-keys must be verified to ensure equivalent behavior.」

---

### S7F003: sendSpecialKeys() のテストが tmux.test.ts に存在しない

**カテゴリ**: テスト不足
**影響ファイル**: `tests/unit/tmux.test.ts`

**問題**:

`tests/unit/tmux.test.ts` には `sendSpecialKey()`（単数形）のテストは 4 件存在する（402-458行）が、`sendSpecialKeys()`（複数形、配列受け取り）のテストは存在しない。

`sendSpecialKeys()` は `ALLOWED_SPECIAL_KEYS` による allowlist バリデーションを行っている（`tmux.ts:259-263`）:

```typescript
// tmux.ts:259-263
for (const key of keys) {
  if (!ALLOWED_SPECIAL_KEYS.has(key)) {
    throw new Error(`Invalid special key: ${key}`);
  }
}
```

Issue の IF005 で「session name injection prevention tests」の追加を推奨しているが、sendSpecialKeys() 自体のテスト不在は言及されていない。

**推奨対応**:

IF005 のテスト要件に sendSpecialKeys() のテストを追加:
1. 有効なキー配列（`['Down', 'Down', 'Enter']`）が正しく送信される
2. 無効なキー（ALLOWED_SPECIAL_KEYS に含まれない値）で Error がスローされる
3. 空配列で何も実行されない（早期リターン）

---

## Nice to Have（あれば良い）

### S7F004: claude-session.ts:417 の直接 exec() 呼び出し（tmux set-environment）が Issue の Direct exec() Call Sites に未記載

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/claude-session.ts`

**問題**:

`claude-session.ts:417` で以下の直接 exec() 呼び出しがある:

```typescript
await execAsync('tmux set-environment -g -u CLAUDECODE 2>/dev/null || true');
```

これは固定文字列であり sessionName や worktreeId の補間がないため注入リスクはないが、Issue の「Direct exec() Call Sites Bypassing tmux.ts」セクションでは `claude-session.ts:783` のみが記載されている。

**推奨対応**:

Direct exec() Call Sites セクションに低リスクの固定コマンド exec() 呼び出しとして注記を追加する。

---

### S7F005: capturePane() の startLine/endLine パラメータも exec() シェルコマンド文字列に直接補間されている

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/tmux.ts`

**問題**:

`tmux.ts:339` で `startLine` と `endLine` が exec() 文字列に補間されている:

```typescript
`tmux capture-pane -t "${sessionName}" -p -e -S ${startLine} -E ${endLine}`
```

S5F002 で `capture/route.ts` の `lines` パラメータ未検証問題は記載済みだが、execFile() 移行時に capturePane() の全パラメータ（sessionName, startLine, endLine）を引数配列に変換する必要がある点は暗黙的にカバーされるものの、明示的な言及はない。

**推奨対応**:

S5F002 の記述に補足として「The execFile() migration for capturePane() should convert all interpolated parameters to argument array elements.」を追加する。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/tmux.ts` | historyLimit 補間（182行）、sendKeys エスケープ（213-217行）、capturePane パラメータ補間（339行） |
| `src/lib/claude-session.ts` | 固定文字列 exec() 呼び出し（417行）、直接 exec() 呼び出し（783行） |
| `src/lib/cli-tools/codex.ts` | 直接 exec() 呼び出し（102, 104, 139, 170行） |
| `tests/unit/tmux.test.ts` | sendSpecialKeys() テスト不在 |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/tmux.test.ts` | sendSpecialKeys() のテストが不在、sendSpecialKey() のテストは 4 件存在 |

---

## 総合評価

前回の全指摘事項（Stage 3: IF001-IF007、Stage 5: S5F001-S5F002）は Issue 本文に適切に反映されており、解決済みと判定した。

新規の影響範囲指摘として、execFile() 移行の実装時に注意すべき 3 件の Should Fix を特定した:
1. `createSession()` の `historyLimit` パラメータ補間が Issue に未記載
2. `sendKeys()` のシングルクォートエスケープロジックの execFile() 移行時の見直し必要性が未記載
3. `sendSpecialKeys()` のテストが不在

これらは Must Fix レベルではないが、execFile() 移行を包括的に実施する上で実装品質を確保するために対応が望ましい。Issue 全体の影響範囲カバレッジは高い水準に達しており、破壊的変更のリスクは引き続き低い。
