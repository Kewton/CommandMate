# Issue #393 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目
**仮説検証**: 全7仮説 Confirmed

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 5 |

**総合評価**: 高

Issue #393 は技術的に正確で、全 7 仮説がコードベースで確認済みである。Root Cause 分析、PoC、影響範囲の記述は概ね的確。推奨方向性（CLIToolManager 経由への統一、exec() から execFile() への移行、cliToolId のバリデーション）は既存の安全モデルと整合しており適切である。

---

## Must Fix（必須対応）

### F008: terminal/route.ts に worktreeId の存在確認（DB ルックアップ）がない

**カテゴリ**: 完全性
**場所**: Root Cause セクション / Affected Code セクション

**問題**:
terminal/route.ts は `params.id`（worktreeId）の DB 存在確認を一切行っていない。他のルート（respond/route.ts:126-131, kill-session/route.ts:28-34）は `getWorktreeById()` で worktree の存在を確認してから処理を進めるが、terminal/route.ts は任意の worktreeId で tmux セッションを作成・操作できる。

これにより、DB に登録されていない任意のセッション名でシェルが起動可能という問題が、セッション名インジェクションとは独立して存在する。

**証拠**:
- `terminal/route.ts` には `getWorktreeById`, `getDbInstance` のインポートが存在しない
- `respond/route.ts:126`: `const worktree = getWorktreeById(db, params.id);` -- 他のルートは DB 確認を実施
- `kill-session/route.ts:28`: `const worktree = getWorktreeById(db, params.id);` -- 同様

**推奨対応**:
Root Cause に「The endpoint does not verify that the worktreeId corresponds to a registered worktree in the database」を追加する。Recommended Direction に「Verify worktreeId exists in the database before any tmux operation」を追加する。

---

## Should Fix（推奨対応）

### F001: capture/route.ts が同一の脆弱性パターンを持つが Affected Code に未記載

**カテゴリ**: 完全性
**場所**: Affected Code セクション

**問題**:
`src/app/api/worktrees/[id]/capture/route.ts` は terminal/route.ts と全く同じ `getSessionName()` 関数（バリデーションなし）と `cliToolId as CLIToolType` のキャストパターンを使用している。`capturePane()` も `exec()` 経由でセッション名を文字列補間するため、同じシェルインジェクション脆弱性が存在する。

**証拠**:
```typescript
// capture/route.ts:11-13 -- terminal/route.ts と同一
function getSessionName(worktreeId: string, cliToolId: CLIToolType): string {
  return `mcbd-${cliToolId}-${worktreeId}`;
}

// capture/route.ts:29 -- 同一の unsafe キャスト
const sessionName = getSessionName(params.id, cliToolId as CLIToolType);

// capture/route.ts:32 -- hasSession も exec() 経由
const sessionExists = await tmux.hasSession(sessionName);
```

**推奨対応**:
Affected Code セクションに `src/app/api/worktrees/[id]/capture/route.ts` を追加する。

---

### F002: Issue 記載の行番号の一部が実コードとずれている

**カテゴリ**: 正確性
**場所**: Affected Code セクション / Key references

**問題**:
Issue 本文の行番号参照の一部が実際のコードとわずかにずれている。

| Issue 記載 | 実際の内容 | 正確な行 |
|-----------|-----------|---------|
| tmux.ts:153 | createSession オーバーロード定義 | exec() 呼び出しは tmux.ts:175-176 |
| tmux.ts:207 | sendKeys 関数定義 | exec() 呼び出しは tmux.ts:220 |

**推奨対応**:
行番号参照を更新して、exec() の実際の呼び出し行を指すようにする。

---

### F006: workingDirectory パラメータの shell injection リスクへの言及不足

**カテゴリ**: 完全性
**場所**: Root Cause セクション / Recommended Direction セクション

**問題**:
Issue は `sessionName` の shell injection に焦点を当てているが、`tmux.ts:176` の `createSession()` は `workingDirectory` も `exec()` 経由で文字列補間する:

```typescript
// tmux.ts:175-176
await execAsync(
  `tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`,
  { timeout: DEFAULT_TIMEOUT }
);
```

terminal/route.ts では `process.cwd()` を使用しているため現時点では安全だが、`createSession()` の他の呼び出し元や将来の変更で `workingDirectory` に攻撃者制御の値が渡される可能性がある。

**推奨対応**:
Recommended Direction セクションに、`workingDirectory` パラメータも同様に `exec()` の文字列補間で使用されており、`execFile()` への移行で同時に保護されることを追記する。

---

### F010: Severity 'Critical' の根拠として攻撃前提条件の明確化がない

**カテゴリ**: 整合性
**場所**: Severity セクション

**問題**:
Issue は Severity を「Critical」としているが、攻撃前提条件が明確でない。CommandMate はローカル/LAN 内で動作するツールであり、認証が有効な場合は攻撃者が認証トークンを取得する必要がある。

- **認証無効時（デフォルト）**: ローカルアクセスで RCE 可能。ただし tmux セッション管理はツールの設計上の機能に近い
- **認証有効時**: トークン漏洩またはセッションハイジャックが前提
- **Case 1 vs Case 2**: Case 1（意図的動作の悪用）は設計上の境界問題、Case 2（シェルインジェクション）は明確な脆弱性

**証拠**:
- middleware.ts:99-101: `CM_AUTH_TOKEN_HASH` 未設定時は認証スキップ
- Issue 本文の Severity セクションには「Critical」のみ記載

**推奨対応**:
Severity セクションに攻撃前提条件の区分を追記する。Case 2（シェルインジェクション）は Critical、Case 1（任意コマンド実行）は設計上の制限として区別すると、修正優先度の判断が明確になる。

---

## Nice to Have（あれば良い）

### F003: Case 2 の PoC における cliToolId のルーティング制約の曖昧さ

**カテゴリ**: 正確性

Issue は「Exact exploitability depends on routing constraints and how params.id is parsed」と但し書きを付けているが、`cliToolId` は JSON ボディから取得されるため（route.ts:20）、ルーティング制約は無関係。但し書きを明確化すると良い。

---

### F004: sendSpecialKeys / sendSpecialKey のセッション名インジェクションリスクへの言及

**カテゴリ**: 完全性

tmux.ts の全関数で `sessionName` が `exec()` 経由で補間されている。`execFile()` への移行推奨に、影響を受ける全関数を列挙すると修正漏れを防止できる:
- `hasSession` (tmux.ts:70)
- `createSession` (tmux.ts:175-176, 181-183)
- `sendKeys` (tmux.ts:220)
- `sendSpecialKeys` (tmux.ts:267)
- `sendSpecialKey` (tmux.ts:440)
- `capturePane` (tmux.ts:338)
- `killSession` (tmux.ts:368)

---

### F005: 安全パターンを使用している他ルートの具体例

**カテゴリ**: 整合性

「Why This Is Different From Other CLI Routes」セクションに CLIToolManager 経由の安全パターンを使用しているルートの具体例を追加すると、修正方針の根拠が強化される:
- `respond/route.ts:142`
- `kill-session/route.ts:65`
- `prompt-response/route.ts:88`
- `interrupt/route.ts:71`

---

### F007: historyLimit パラメータの数値 injection

**カテゴリ**: 完全性

tmux.ts:181-183 で `historyLimit` も `exec()` で文字列補間されている。現在は number 型の固定値だが、`execFile()` への包括的移行の一環として対象になる。

---

### F009: CSRF 対策の具体策

**カテゴリ**: 提案

Issue の Security Boundary Broken セクションで CSRF リスクを言及しているが、Recommended Direction に具体的な CSRF 対策がない。Origin ヘッダー検証やカスタム CSRF トークンの推奨を含めると良い。

---

## 参照ファイル

### コード（脆弱性対象）
| ファイル | 関連性 |
|---------|--------|
| `src/app/api/worktrees/[id]/terminal/route.ts` | 主要な脆弱性を含むエンドポイント |
| `src/app/api/worktrees/[id]/capture/route.ts` | 同一の脆弱性パターン（Issue 未記載） |
| `src/lib/tmux.ts` | exec() 文字列補間の tmux ヘルパー |

### コード（安全パターン比較）
| ファイル | 関連性 |
|---------|--------|
| `src/lib/cli-tools/base.ts` | getSessionName + validateSessionName の安全パターン |
| `src/lib/cli-tools/validation.ts` | SESSION_NAME_PATTERN バリデーション |
| `src/lib/cli-tools/types.ts` | CLI_TOOL_IDS / isCliToolType() 型ガード |
| `src/app/api/worktrees/[id]/respond/route.ts` | CLIToolManager 経由の安全パターン |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | CLI_TOOL_IDS バリデーション + CLIToolManager |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成の整合性確認 |
