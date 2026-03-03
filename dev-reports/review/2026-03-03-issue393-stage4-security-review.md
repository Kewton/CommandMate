# Issue #393 Stage 4 セキュリティレビュー

## レビュー概要

| 項目 | 内容 |
|------|------|
| **Issue** | #393: security: authenticated RCE and shell injection via /api/worktrees/[id]/terminal |
| **ステージ** | Stage 4: セキュリティレビュー |
| **レビュー対象** | 設計方針書（Stage 1-3 反映済み） |
| **レビュー日** | 2026-03-03 |
| **ステータス** | 条件付き承認 |
| **スコア** | 4/5 |

---

## OWASP Top 10 準拠評価

### A03:2021-Injection -- 準拠

設計方針書のインジェクション対策は、OWASP A03 に対して強固な多層防御を提供している。

**SEC-001 多層防御の評価:**

| レイヤー | 防御策 | 評価 | 根拠 |
|---------|--------|------|------|
| Layer 1 | `isCliToolType()` ホワイトリスト | 準拠 | `CLI_TOOL_IDS` 定数（5値: claude, codex, gemini, vibe-local, opencode）ベースの完全ホワイトリスト。既存パターン（`kill-session/route.ts` line 41）と一致 |
| Layer 2 | `getWorktreeById()` DB確認 | 準拠 | 既存パターン（`respond/route.ts` line 126, `kill-session/route.ts` line 28）と完全一致 |
| Layer 3 | `validateSessionName()` 正規表現 | 準拠 | `/^[a-zA-Z0-9_-]+$/` パターンで全てのシェルメタ文字を排除 |
| Layer 4 | `execFile()` シェル非経由実行 | 準拠 | 根本防御。引数配列方式によりシェル解釈を完全回避。`opencode.ts` の既存 `execFileAsync` パターンとも一致 |

**command パラメータの扱い:**

`terminal/route.ts` の `command` パラメータは tmux `send-keys` の引数として渡される。`execFile()` 移行後はシェル経由でないため OS コマンドインジェクションは防止されるが、長さ制限が未定義である点は改善が必要（R4F001 参照）。

**lines パラメータの扱い:**

設計方針書 D1-005 の4段階バリデーション（`typeof` 型チェック、`Number.isInteger()` 整数チェック、範囲チェック 1-100000、`Math.floor()` defense-in-depth）は適切であり、A03 に準拠している。

### A01:2021-Broken Access Control -- 部分的準拠

**認証チェック:**

`middleware.ts` は以下の順序でアクセス制御を実施:
1. IP 制限チェック（line 70-78）: `isIpRestrictionEnabled()` → `getClientIp()` → `isIpAllowed()`
2. WebSocket upgrade チェック（line 84-96）
3. 認証有効性チェック（line 99-101）: `CM_AUTH_TOKEN_HASH` 未設定時はスキップ
4. パス除外チェック（line 106-108）: `AUTH_EXCLUDED_PATHS` 完全一致
5. Cookie ベーストークン検証（line 112-113）

`terminal/route.ts` と `capture/route.ts` は `AUTH_EXCLUDED_PATHS` に含まれていないため、認証有効時は middleware でカバーされる。

**worktreeId アクセス制御:**

`getWorktreeById()` は DB 上の存在確認のみであり、所有権チェックは行わない。CommandMate はシングルユーザーのローカル開発ツールとして設計されているため、現時点では妥当な設計判断である。

**認証無効時のリスク:**

`CM_AUTH_TOKEN_HASH` 未設定時は全リクエストが通過するが、これは意図的な後方互換性設計である。`execFile()` 移行 + バリデーション追加により、認証無効時でもインジェクション攻撃は防止される。

### A05:2021-Security Misconfiguration -- 部分的準拠

**エラーメッセージの情報漏洩:**

現在の `terminal/route.ts` と `capture/route.ts` は 500 エラー時に `(error as Error).message` をそのままクライアントに返却している（line 46）。これにはファイルパスや内部モジュール情報が含まれる可能性がある。

対照的に、`kill-session/route.ts`（line 122）は固定文字列 `'Failed to kill sessions'` を返しており、プロジェクトのセキュリティ標準に準拠している。設計方針書はこの差異に言及していない（R4F002 参照）。

---

## 指摘事項詳細

### Must Fix (1件)

#### R4F006: エラーメッセージへのユーザー入力値埋め込みによるログインジェクション/XSS リスク

- **OWASP カテゴリ**: A03 Injection
- **影響度**: Medium
- **該当箇所**: 設計方針書 D1-001 のコード例

**問題:**

設計方針書 D1-001 のバリデーションエラーレスポンスのコード例:
```typescript
return NextResponse.json(
  { error: `Invalid cliTool: '${cliToolId}'. Valid values: ${CLI_TOOL_IDS.join(', ')}` },
  { status: 400 }
);
```

`cliToolId` はユーザー入力であり、制御文字やHTMLタグを含む値を送信可能である。エラーメッセージにサニタイズなしで埋め込まれると:
1. サーバーログビューアでのログインジェクション
2. フロントエンドが error メッセージを安全でない方法で表示した場合の XSS リスク

既存の `kill-session/route.ts`（line 43）も同じパターンを使用しているが、新規修正で同じ問題を再現すべきではない。

**推奨対応:**

エラーレスポンスにユーザー入力値を含める場合は、制御文字除去と長さ制限を適用する:
```typescript
const safeCli = String(cliToolId).replace(/[\x00-\x1f]/g, '').slice(0, 50);
```
あるいは、ユーザー入力値をエラーメッセージに含めず固定文字列のみ返す方式がより安全である。

---

### Should Fix (3件)

#### R4F001: command パラメータの長さ制限が設計方針書に未定義

- **OWASP カテゴリ**: A03 Injection / DoS
- **影響度**: Low-Medium
- **該当箇所**: 設計方針書 SEC-002

**問題:**

`terminal/route.ts` の `command` パラメータに長さ制限が定義されていない。`execFile()` 移行により OS インジェクションは防止されるが、巨大な文字列（例: 100MB）送信による DoS 攻撃のリスクがある。プロジェクトの他箇所では `MAX_MESSAGE_LENGTH=10000`（`claude-executor.ts`）のような上限が存在しており、一貫性が必要である。

**推奨対応:**

`MAX_COMMAND_LENGTH=10000` を定義し、超過時は 400 Bad Request を返す。

---

#### R4F002: 500 エラーレスポンスで error.message をそのまま返却 - 情報漏洩リスク

- **OWASP カテゴリ**: A05 Security Misconfiguration
- **影響度**: Low-Medium
- **該当箇所**: `terminal/route.ts` line 44-48, `capture/route.ts` line 44-48

**問題:**

現在のコード:
```typescript
// terminal/route.ts line 44-48
return NextResponse.json(
  { error: (error as Error).message },
  { status: 500 }
);
```

`error.message` にはファイルパス、DB 接続情報等が含まれる可能性がある。`kill-session/route.ts` は固定文字列 `'Failed to kill sessions'` を返しており、この方がセキュアなパターンである。

**推奨対応:**

500 エラーレスポンスを固定文字列に変更する:
```typescript
return NextResponse.json(
  { error: 'Failed to send command to terminal' },
  { status: 500 }
);
```

---

#### R4F007: capture/route.ts のセッション不在時レスポンスに cliToolId が未サニタイズで含まれる

- **OWASP カテゴリ**: A03 Injection
- **影響度**: Low
- **該当箇所**: `capture/route.ts` line 35-37

**問題:**

```typescript
// 現在のコード（バリデーション前のコードパス）
return NextResponse.json({
  output: `Session not running. Starting ${cliToolId} session...\n`
});
```

設計方針書 D1-001 のバリデーション追加後は、このパスに到達する cliToolId は検証済みとなるが、セッション不在時のレスポンスを 404 に統一すべきである。

**推奨対応:**

`terminal/route.ts` と同様にセッション不在時は 404 を返し、固定メッセージを使用する。

---

### Nice to Have (4件)

#### R4F003: terminal/capture エンドポイントにレートリミットが未適用

- **OWASP カテゴリ**: Other (DoS Prevention)
- **判断**: スコープ外として妥当。別 Issue で全エンドポイントのレートリミット戦略を検討することを推奨。

#### R4F004: lines パラメータ上限 100000 の妥当性

- **OWASP カテゴリ**: A05
- **判断**: `historyLimit=50000` の2倍だが、`maxBuffer=10MB` による二重防御があるため技術的に安全。変更は必須ではない。

#### R4F005: 認証無効時のアクセス制御がスキップされる設計

- **OWASP カテゴリ**: A01
- **判断**: 意図的な後方互換性設計。`execFile()` + バリデーション追加により認証無効時もインジェクションは防止される。

#### R4F008: worktreeId DB 確認のみでは所有権チェックが不在

- **OWASP カテゴリ**: A01
- **判断**: シングルユーザーのローカル開発ツールとして妥当。既存全エンドポイントと一貫性がある。

---

## 既存プロジェクトセキュリティパターンとの整合性

| パターン | 設計方針書の対応 | 整合性 |
|---------|----------------|--------|
| SEC-001: `execFile()` 使用 | D2 で全面移行 | 準拠 -- `opencode.ts` の既存パターンと一致 |
| `isCliToolType()` ホワイトリスト | D1-001 で適用 | 準拠 -- `kill-session/route.ts` line 41 と同一パターン |
| `getWorktreeById()` DB 確認 | D1-002 で適用 | 準拠 -- `respond/route.ts` line 126, `kill-session/route.ts` line 28 と同一パターン |
| `CLIToolManager` 経由 | D1-003 で統一 | 準拠 -- `respond/route.ts` line 138-142 と同一パターン |
| `validateSessionName()` | BaseCLITool.getSessionName() 経由 | 準拠 -- `validation.ts` の `SESSION_NAME_PATTERN` 適用 |
| 固定文字列エラーレスポンス | **未準拠** | `kill-session/route.ts` は固定文字列、設計方針書のコード例はユーザー入力埋め込み |
| `ALLOWED_SPECIAL_KEYS` ランタイム検証 | D2-005/D2-006 で追加 | 準拠 -- `sendSpecialKeys()` の既存パターンを `sendSpecialKey()` にも拡張 |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| インジェクション | `execFile()` 移行により根本的に解消 | Low | Very Low | P1 (設計済み) |
| 情報漏洩 | エラーメッセージに内部情報が含まれる | Low | Medium | P2 |
| DoS | command 長さ無制限 | Low | Low | P2 |
| ログインジェクション | エラーメッセージにユーザー入力埋め込み | Medium | Low | P1 |
| 認証バイパス | 認証無効時の全通過 | Medium | N/A (仕様) | N/A |

---

## Stage 1-3 指摘事項のセキュリティ観点での再評価

| Stage | ID | セキュリティ関連度 | 評価 |
|-------|----|--------------------|------|
| S1 | R1F004 | 高 -- sendSpecialKey() ランタイムバリデーション | D2-005 で設計反映済み。defense-in-depth として適切 |
| S1 | R1F010 | 高 -- lines パラメータ型安全性 | D1-005 で設計反映済み。4段階バリデーションは堅牢 |
| S2 | R2F003 | 中 -- sanitizeSessionEnvironment() の exec() | 非スコープ理由が文書化済み。固定文字列のみでリスクなし |
| S3 | R3F008 | 中 -- maxBuffer 互換性 | D2-001 に引き継ぎ方針追記済み。技術的に問題なし |
| S3 | R3F010 | 中 -- エラーメッセージ形状差異 | D4-003 にテスト方針追記済み。killSession() のパターンマッチに影響なし |

---

## 結論

設計方針書は OWASP A03:2021-Injection に対して、`execFile()` 全面移行を軸とした4層の defense-in-depth を設計しており、セキュリティ姿勢は**強固 (strong)** と評価する。

must_fix は1件（エラーメッセージへのユーザー入力値埋め込み: R4F006）のみであり、実装上の軽微な改善で対処可能である。should_fix 3件（command 長さ制限、500 エラー情報漏洩、capture セッション不在レスポンス）もセキュリティ品質の向上に寄与するが、インジェクション防止の本質には影響しない。

既存プロジェクトのセキュリティパターン（`kill-session/route.ts`, `respond/route.ts`, `opencode.ts`）との整合性は高く、SEC-001 パターンに準拠している。

**条件付き承認**: R4F006 の対応を条件として承認する。

---

*Generated by Stage 4 Security Review for Issue #393 (2026-03-03)*
