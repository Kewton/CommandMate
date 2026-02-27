# Issue #374 Stage 4 Security Review

## Executive Summary

Issue #374は、Vibe Local CLIツールに `--context-window` パラメータ（整数値、128-2097152）を追加する機能である。値はDBに格納され、tmuxセッションでのCLIコマンド実行時にテンプレートリテラルで `--context-window ${ctxWindow}` として展開される。

本セキュリティレビューでは、OWASP Top 10準拠の観点およびプロジェクト固有のコマンドインジェクションリスクを評価した。設計方針書は多層防御（defense-in-depth）を適切に設計しており、重大なセキュリティ欠陥は検出されなかった。

**判定: conditional_pass**（should-fix 2件の対応を推奨）

---

## Review Details

| 項目 | 内容 |
|------|------|
| Issue | #374 |
| Stage | 4 (Security) |
| 設計方針書 | `dev-reports/design/issue-374-vibe-local-context-window-design-policy.md` |
| レビュー日 | 2026-02-28 |
| 判定 | conditional_pass |

---

## 1. OWASP Top 10 Checklist

### A03:2021 - Injection (Command Injection)

**評価: PASS**

設計方針書セクション5で定義された多層防御は以下の構成:

| レイヤー | バリデーション | 実装 |
|---------|-------------|------|
| API層 | `isValidVibeLocalContextWindow()` | typeof number + Number.isInteger + 範囲チェック |
| DB層 | SQLite INTEGER型制約 | カラム定義 `INTEGER DEFAULT NULL` |
| CLI層 | `isValidVibeLocalContextWindow()` 再検証 | 使用時点での最終防御 |

`isValidVibeLocalContextWindow()` の型ガード関数は以下の4段階チェックを行う:

```typescript
typeof value === 'number' &&
Number.isInteger(value) &&
value >= VIBE_LOCAL_CONTEXT_WINDOW_MIN &&   // 128
value <= VIBE_LOCAL_CONTEXT_WINDOW_MAX      // 2097152
```

このバリデーションチェーンにより:
- 文字列 (`"'; rm -rf /"`) は `typeof` チェックで排除
- NaN / Infinity は `Number.isInteger()` で排除
- 負数 / 0 は範囲チェックで排除
- 小数 (128.5) は `Number.isInteger()` で排除
- Number.MAX_SAFE_INTEGER は範囲チェックで排除

**注意点**: 値は `tmux send-keys` 経由で `exec()` に渡されるため（`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/tmux.ts` L207-225のsendKeys関数）、シェルインジェクションの攻撃面が存在する。ただし、バリデーション通過後の値は確実に整数型であるため、実害のリスクは極めて低い。

### A04:2021 - Insecure Design

**評価: PASS**

防衛的設計の適用状況:

- **入力バリデーションのタイミング**: API受信時（第一防衛線）とCLI使用時（最終防衛線）の2箇所で適切
- **共有バリデーション関数**: `isValidVibeLocalContextWindow()` をDRY原則で共有し、条件の不一致リスクを排除
- **フェイルセーフ設計**: DB接続失敗時は `--context-window` フラグ省略（try-catch内、L264-266）

### A05:2021 - Security Misconfiguration

**評価: PASS**

- デフォルト値 `NULL` は `--context-window` フラグ自体の省略を意味し、vibe-local CLIの組み込みデフォルトに委ねる安全な設計
- 新規の環境変数は追加されない
- `src/lib/env-sanitizer.ts` の `SENSITIVE_ENV_KEYS` への追加は不要

---

## 2. 数値型バリデーション分析

`isValidVibeLocalContextWindow(value: unknown)` の各入力値に対する動作:

| 入力値 | typeof check | Number.isInteger | 範囲チェック | 結果 |
|--------|-------------|-----------------|------------|------|
| `8192` | number: pass | true: pass | 128-2097152: pass | **PASS** |
| `128` (下限) | number: pass | true: pass | 128: pass | **PASS** |
| `2097152` (上限) | number: pass | true: pass | 2097152: pass | **PASS** |
| `null` | object: **fail** | - | - | **REJECT** (API層でnull分岐により許容) |
| `127` | number: pass | true: pass | < 128: **fail** | **REJECT** |
| `2097153` | number: pass | true: pass | > 2097152: **fail** | **REJECT** |
| `128.5` | number: pass | false: **fail** | - | **REJECT** |
| `-1` | number: pass | true: pass | < 128: **fail** | **REJECT** |
| `NaN` | number: pass | false: **fail** | - | **REJECT** |
| `Infinity` | number: pass | false: **fail** | - | **REJECT** |
| `"128"` (string) | string: **fail** | - | - | **REJECT** |
| `true` (boolean) | boolean: **fail** | - | - | **REJECT** |
| `{}` (object) | object: **fail** | - | - | **REJECT** |
| `Number.MAX_SAFE_INTEGER` | number: pass | true: pass | > 2097152: **fail** | **REJECT** |

全ケースで期待通りの動作が確認された。

---

## 3. SQLインジェクション分析

設計方針書セクション3のDB関数パターン:

```typescript
export function updateVibeLocalContextWindow(
  db: Database.Database,
  id: string,
  contextWindow: number | null
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET vibe_local_context_window = ?
    WHERE id = ?
  `);
  stmt.run(contextWindow, id);
}
```

**評価: 安全**

- `db.prepare()` + `stmt.run()` のプリペアドステートメントパターンを使用
- パラメータはバインド変数 (`?`) で渡される
- 既存の `updateVibeLocalModel()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/db.ts` L1004-1016) と同一パターン
- SELECT文修正（6箇所）も既存のプリペアドステートメント内のカラム追加であり、動的SQL構築ではない

---

## 4. DoS防御分析

### 超大値入力への対策

- `VIBE_LOCAL_CONTEXT_WINDOW_MAX = 2097152` により、最大7桁の数値に制限
- CLI引数 `--context-window 2097152` は22文字であり、tmux sendKeysのバッファに影響なし
- `Number.MAX_SAFE_INTEGER` (9007199254740991) は範囲チェックで排除

### DB格納サイズ

- SQLite INTEGER型は最大8バイト（符号付き64ビット整数）
- 2097152は問題ないサイズ

### 上限値2097152の妥当性

- 現時点のOllamaモデルの実用的コンテキストウィンドウ範囲（2048-131072）を十分にカバー
- 将来の大規模モデル（1M+ tokens）にも対応可能な余裕
- 極端に大きな値（Number.MAX_SAFE_INTEGER等）は確実に排除

---

## 5. 環境変数・シークレットへの影響

- 新規の環境変数は追加されない
- `src/lib/env-sanitizer.ts` の `SENSITIVE_ENV_KEYS` に追加は不要
- `context-window` の値はセンシティブ情報ではない（整数値のみ）
- ログ出力にコンテキストウィンドウ値が含まれる可能性があるが、セキュリティリスクなし

---

## 6. 既存実装との比較分析

### vibeLocalModel（既存パターン）のセキュリティ対策

`/Users/maenokota/share/work/github_kewton/commandmate-issue-374/src/lib/cli-tools/vibe-local.ts` L89-94:

```typescript
if (wt?.vibeLocalModel && OLLAMA_MODEL_PATTERN.test(wt.vibeLocalModel)) {
  vibeLocalCommand = `vibe-local -y -m ${wt.vibeLocalModel}`;
}
```

- **正規表現ホワイトリスト** (`/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/`) でモデル名の文字種を制限
- 文字列型のため、正規表現によるサニタイズが必須

### vibeLocalContextWindow（新規パターン）のセキュリティ対策

設計方針書セクション5:

```typescript
if (isValidVibeLocalContextWindow(ctxWindow)) {
  vibeLocalCommand += ` --context-window ${ctxWindow}`;
}
```

- **型ガード関数** (`typeof === 'number' + Number.isInteger + 範囲チェック`) で数値型を保証
- 数値型のため、正規表現は不要だが、テンプレートリテラル埋め込み時の明示的キャストは追加防御として推奨

**両パターンの共通点**: tmux `sendKeys()` (`exec()` 経由) に渡される文字列に対して、使用時点でのバリデーション（defense-in-depth）を適用

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| コマンドインジェクション | テンプレートリテラルでのCLI引数構築 | High | Very Low (型ガードで防御) | P3 |
| SQLインジェクション | プリペアドステートメント使用 | High | Negligible | N/A |
| DoS (超大値) | 上限2097152で制限 | Low | Very Low | P3 |
| プロトタイプ汚染 | JSON.parse後のbodyキー | Medium | Very Low (型ガードで排除) | P3 |
| セキュリティ設定ミス | デフォルトNULL, 環境変数影響なし | Low | Negligible | N/A |

---

## Findings

### Should Fix (2件)

#### S4-001: テンプレートリテラルでのCLI引数構築に関する追加防御

**場所**: 設計方針書 セクション5 / `src/lib/cli-tools/vibe-local.ts` startSession()

`vibeLocalCommand += ` --context-window ${ctxWindow}`` のテンプレートリテラル埋め込みにおいて、`isValidVibeLocalContextWindow()` 通過後の値に対する追加のサニタイズとして、`Number(ctxWindow)` による明示的な数値キャストを推奨する。`sendKeys()` -> `exec()` というシェル実行パスにおける追加のdefense-in-depthレイヤーとなる。

**推奨修正**:
```typescript
vibeLocalCommand += ` --context-window ${Number(ctxWindow)}`;
```

#### S4-002: プロトタイプ汚染耐性に関する設計文書への記載

**場所**: 設計方針書 セクション4-5

API層での `request.json()` (JSON.parse) 後のbodyに `__proto__` 等のプロトタイプ汚染キーが含まれる可能性について、`isValidVibeLocalContextWindow()` の `typeof === 'number'` チェックで非数値型が排除されるため実害はないが、セキュリティ設計の網羅性として設計文書に一文記載を推奨する。

### Nice to Have (2件)

#### S4-003: クライアント側バリデーションの位置づけの明示

HTMLの `type=number` / `min` / `step` 属性はUX向上目的であり、セキュリティバリデーションの信頼ポイントではないことをセクション6に明示する。

#### S4-004: 上限値の見直しトリガー条件の明示

`VIBE_LOCAL_CONTEXT_WINDOW_MAX = 2097152` の将来的な見直し基準（例: Ollamaが2M超のcontext windowをサポートした場合）をセクション9のトレードオフ表に追記する。

---

## Overall Assessment

**conditional_pass**

設計方針書のセキュリティ設計は堅牢であり、OWASP Top 10の主要リスク（Injection, Insecure Design, Security Misconfiguration）に対して適切な対策が講じられている。`isValidVibeLocalContextWindow()` 型ガード関数による多層防御は、NaN/Infinity/文字列/オブジェクト型など全ての異常入力を確実に排除する。プリペアドステートメントによるSQLインジェクション対策も適切である。

should-fix 2件は設計の堅牢性を更に高めるための推奨事項であり、セキュリティ上の致命的な問題ではない。実装フェーズでの反映を推奨する。

---

*Reviewed by Architecture Review Agent (Stage 4: Security)*
*2026-02-28*
