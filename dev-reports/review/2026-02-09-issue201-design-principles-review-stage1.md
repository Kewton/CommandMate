# Architecture Review: Issue #201 - 設計原則 (Design Principles)

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue | #201: 信頼性確認ダイアログ自動応答 |
| レビュー種別 | 設計原則 (Design Principles) |
| ステージ | Stage 1 (通常レビュー) |
| ステータス | **Approved** |
| スコア | **5/5** |
| レビュー日 | 2026-02-09 |
| 対象設計書 | `dev-reports/design/issue-201-trust-dialog-auto-response-design-policy.md` |

---

## Executive Summary

Issue #201の設計方針書は、SOLID、KISS、YAGNI、DRY全ての設計原則に高い水準で準拠している。変更範囲が2ファイル（`cli-patterns.ts`へのパターン定数追加、`claude-session.ts`のポーリングループへの条件追加）に限定されており、既存アーキテクチャを尊重した最小限の修正で問題を解決する方針が明確である。

特筆すべき点は以下の通り:
- 既存の設計パターン（パターン定数外部化、ポーリングループ内条件分岐）を一貫して踏襲
- 代替案4つを比較検討し、最もシンプルかつ堅牢な方式を選択
- 将来の拡張性に関するトレードオフを設計書内で明示的に記載
- 後方互換性の保証が明確

必須改善項目は検出されなかった。推奨改善項目2件、検討事項2件を以下に記載する。

---

## 設計原則チェックリスト

### SOLID原則

#### [PASS] S - Single Responsibility Principle (単一責任原則)

**評価**: 責務分離が適切に保たれている。

- `cli-patterns.ts`: パターン定義の責務を維持。`CLAUDE_TRUST_DIALOG_PATTERN`は既存の`CLAUDE_PROMPT_PATTERN`、`CLAUDE_THINKING_PATTERN`と同一の管理単位に配置される。
- `claude-session.ts`: セッション管理（ライフサイクル制御）の責務を維持。ダイアログ応答ロジックは`startClaudeSession()`のCLI初期化フロー内に自然に統合される。
- テストもモジュール単位で分離: `cli-patterns.test.ts`でパターンマッチ、`claude-session.test.ts`でセッション動作をそれぞれ独立テスト。

**コード上の根拠**:
```
cli-patterns.ts (L48付近) - パターン定数のみを定義
claude-session.ts (L292-365) - startClaudeSession()のポーリングループ内でパターンを参照
```

#### [PASS] O - Open/Closed Principle (開放閉鎖原則)

**評価**: 既存コードを変更せず、拡張で対応。

設計書の方針は明確:
- `cli-patterns.ts`に新規export `CLAUDE_TRUST_DIALOG_PATTERN` を**追加**（既存exportに変更なし）
- `claude-session.ts`の`startClaudeSession()`内ポーリングループに新しいif分岐を**追加**（既存のCLAUDE_PROMPT_PATTERNチェックは変更なし）
- 条件分岐の順序: CLAUDE_PROMPT_PATTERN（既存）を先にチェック、CLAUDE_TRUST_DIALOG_PATTERN（新規）を後にチェック。正常フローの最短パスを維持。

**設計書の記載** (L138):
> **OCP準拠**: 既存の条件分岐を変更せず、新しい条件を追加する形式

この記載は実装方針と一致しており、適切である。

#### [N/A] L - Liskov Substitution Principle (リスコフの置換原則)

本修正は関数レベルの変更であり、クラス継承関係に影響しない。`ClaudeTool`クラスは`BaseCLITool`を継承しているが、`startClaudeSession()`は`ClaudeTool.startSession()`から委譲されており、内部実装の変更はインターフェース契約に影響しない。

#### [N/A] I - Interface Segregation Principle (インターフェース分離原則)

本修正でインターフェースの変更は行わない。`ClaudeSessionOptions`の拡張も不要。関数シグネチャの変更なし。

#### [PASS] D - Dependency Inversion Principle (依存性逆転原則)

**評価**: 依存方向が適切に維持されている。

```
claude-session.ts ──imports──> cli-patterns.ts (CLAUDE_TRUST_DIALOG_PATTERN)
claude-session.ts ──imports──> cli-patterns.ts (CLAUDE_PROMPT_PATTERN, stripAnsi) [既存]
```

高レベルモジュール（`claude-session.ts`、セッション管理）が低レベルモジュール（`cli-patterns.ts`、パターン定義）に依存する構造は既存アーキテクチャと一致。パターン定数の抽象化レベルが適切であり、正規表現の詳細をセッション管理ロジックから分離している。

---

### KISS原則 (Keep It Simple, Stupid)

**評価**: [PASS]

設計は必要最小限の複雑さに抑えられている。

1. **パターンマッチ**: `/Yes, I trust this folder/m` -- 固定文字列の部分一致。正規表現の複雑さは最小。
2. **二重送信防止**: `trustDialogHandled` boolean フラグ -- 状態管理の最もシンプルな形式。StateパターンやEventEmitterなどの過剰な抽象化を避けている。
3. **ポーリングループ統合**: 既存ループに条件分岐を追加するのみ。新しいループや並列処理の導入なし。
4. **Enter送信**: `sendKeys(sessionName, '', true)` -- 既存のtmux API呼び出し。新規APIの導入不要。

設計書で検討された4つの代替案のうち、採用案が最もシンプルである:

| 案 | 複雑度 | 判定 |
|---|--------|------|
| A: ポーリングループ内Enter送信 (採用) | 低 | 既存フローに自然に統合 |
| B: `--trust-workspace`フラグ | - | フラグが存在しない |
| C: settings.json事前設定 | 高 | CLI内部形式に依存 |
| D: UI通知+手動操作 | 中 | UX悪化 |

---

### YAGNI原則 (You Aren't Gonna Need It)

**評価**: [PASS]

設計書は以下の項目を明示的に「含めない」と宣言している:

1. **多言語対応**: 英語UIのみ。多言語対応時は別Issueで対応 (設計書 L211)
2. **複数ダイアログ対応**: 将来のダイアログ種類追加は含まない (設計書 L194)
3. **settings.json事前設定**: CLI内部設定への介入は行わない (設計書 L204)
4. **sendMessageToClaude()での検出**: 不要と判断 (設計書 L195)

各項目について、YAGNI判断の根拠がトレードオフ表で明示されており、意思決定の過程が追跡可能である。

特に、`trustDialogHandled`フラグが単一ダイアログ向けの設計であることを認識した上で、複数ダイアログ対応の拡張性をトレードオフとして記載している点は、YAGNI原則を意識的に適用した証拠として評価できる。

---

### DRY原則 (Don't Repeat Yourself)

**評価**: [PASS]

1. **パターン定数の集約**: `CLAUDE_TRUST_DIALOG_PATTERN`を`cli-patterns.ts`に配置。既存の`CLAUDE_PROMPT_PATTERN`、`CLAUDE_THINKING_PATTERN`等と同じ管理単位。テスト容易性とパターン変更時の1箇所修正を保証。

2. **stripAnsi()の再利用**: `startClaudeSession()`内で既に`const cleanOutput = stripAnsi(output)`が存在（L343）。新規のダイアログ検出も同じ`cleanOutput`変数を使用してパターンテストを行うため、ANSI除去処理の重複なし。

3. **sendKeys()の再利用**: Enter送信に`sendKeys(sessionName, '', true)`を使用。tmuxへのキー送信を直接実装するのではなく、既存のtmuxラッパー関数を経由。

4. **テストパターンの踏襲**: 設計書に明記されている通り、既存テストの`vi.useFakeTimers()`と`vi.mocked(capturePane)`パターンを踏襲。テストユーティリティの再利用。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | Claude CLIのダイアログ文言変更でパターンマッチが失敗 | Low | Low | P3 |
| 技術的リスク | ダイアログ応答のタイムアウト共有制約 | Low | Low | P3 |
| セキュリティ | ダイアログ誤検出による意図しないEnter送信 | Low | Low | P3 |
| 運用リスク | 英語以外のLocaleでのClaude CLI使用 | Low | Low | P3 |

**総合リスク評価**: 全て Low。設計方針自体にリスクは極めて少ない。

---

## 詳細所見

### 推奨改善項目 (Should Fix)

#### SF-001: CLAUDE_TRUST_DIALOG_PATTERN正規表現のアンカリング意図の明示

**原則**: KISS / Consistency

設計書ではパターンを `/Yes, I trust this folder/m` と定義している。既存のパターン定数を確認すると:

| パターン | 行頭アンカー | mフラグ |
|---------|------------|--------|
| `CLAUDE_PROMPT_PATTERN` | `^` あり | `/m` |
| `CLAUDE_SEPARATOR_PATTERN` | `^` あり | `/m` |
| `CODEX_PROMPT_PATTERN` | `^` あり | `/m` |
| `CLAUDE_TRUST_DIALOG_PATTERN` | なし | `/m` |

部分一致方式（アンカーなし）はtrust dialogの場合に正しい選択である。ダイアログ内の選択肢テキストは行頭ではなくインデント付きで表示されるため、`^`アンカーは不適切。ただし、他のパターンとの一貫性の観点から、意図的に部分一致とした理由をコード内コメントで明示することを推奨する。

**推奨対応**:
```typescript
/**
 * Claude CLI trust dialog pattern.
 * Intentionally uses partial match (no ^ anchor) because the dialog text
 * appears within indented option lines, not at line start.
 */
export const CLAUDE_TRUST_DIALOG_PATTERN = /Yes, I trust this folder/m;
```

#### SF-002: console.logとcreateLogger()の混在に関する注記

**原則**: DRY / Consistency

`cli-patterns.ts`は`createLogger('cli-patterns')`を使用してログ出力を行っている（L10）が、`claude-session.ts`は`console.log`を直接使用している（L308, L347, L361等）。設計書ではログ出力にconsole.logを採用し、既存のclaude-session.ts内の方式に合わせるとしている。

これ自体は短期的に正しい判断である。しかし、プロジェクト全体でログ方式が2種類混在していることを認識した上で、将来のログ統一化に向けたコメントを残すことを推奨する。

**推奨対応**: claude-session.ts内のconsole.log使用箇所にTODOコメントを追加するか、別Issueとして追跡する。本Issue #201の範囲では対応不要。

---

### 検討事項 (Consider)

#### C-001: 初期化ダイアログ検出の拡張性

**原則**: OCP / YAGNI

現在のフラグベース設計（`trustDialogHandled`）は1種類のダイアログに最適化されている。Claude CLIが将来追加のダイアログ（例: ライセンス更新確認、セキュリティポリシー同意等）を導入する可能性がある。

現時点ではYAGNI原則に従い、フラグベース設計を維持することが正しい。設計書のトレードオフ表にこの判断が記載されている点は高く評価できる。

将来2種類以上のダイアログ対応が必要になった場合の移行パス:
```typescript
// 現在: フラグベース（1ダイアログ）
let trustDialogHandled = false;

// 将来: ハンドラー配列（複数ダイアログ）
const dialogHandlers = [
  { pattern: CLAUDE_TRUST_DIALOG_PATTERN, handled: false, action: () => sendKeys(...) },
  { pattern: CLAUDE_LICENSE_DIALOG_PATTERN, handled: false, action: () => sendKeys(...) },
];
```

#### C-002: タイムアウト共有制約のドキュメント補強

**原則**: KISS

設計書の制約セクション（L223-224）に記載されている通り、ダイアログ応答と通常のプロンプト待機は同一の`CLAUDE_INIT_TIMEOUT`（15秒）を共有する。実運用ではダイアログ応答の所要時間は1秒未満と予測されるため十分なマージンがある。

ただし、将来`CLAUDE_INIT_TIMEOUT`定数の値を短縮する場合に本制約を考慮する必要がある。定数のJSDoc（claude-session.ts L39-48）にダイアログ応答分の時間消費について追記することを検討する。

---

## 後方互換性の検証

| 項目 | 評価 |
|------|------|
| 関数シグネチャの変更 | なし |
| エクスポートの変更 | 新規追加のみ（`CLAUDE_TRUST_DIALOG_PATTERN`） |
| 既存動作への影響 | なし（ダイアログ非表示時はパターンがマッチしない） |
| テスト回帰リスク | なし（既存テストケースは変更不要） |

---

## 既存コードベースとの整合性

### パターン管理の一貫性

| 既存パターン | 定義場所 | 使用場所 |
|-------------|---------|---------|
| `CLAUDE_PROMPT_PATTERN` | cli-patterns.ts:48 | claude-session.ts, status-detector.ts, 他 |
| `CLAUDE_THINKING_PATTERN` | cli-patterns.ts:27-30 | cli-patterns.ts (detectThinking), auto-yes-manager.ts |
| `CLAUDE_SEPARATOR_PATTERN` | cli-patterns.ts:53 | response-poller.ts, cli-patterns.ts |
| **`CLAUDE_TRUST_DIALOG_PATTERN`** (新規) | cli-patterns.ts (追加) | claude-session.ts (startClaudeSession) |

新規パターンは既存の管理体系に自然に統合される。

### 初期化フローの一貫性

`startClaudeSession()`のポーリングループ構造:

```
ポーリングループ開始
  |-- capturePane() でtmux出力取得
  |-- stripAnsi() でANSI除去
  |-- CLAUDE_PROMPT_PATTERN チェック (既存)
  |     |-- マッチ: POST_PROMPT_DELAY後に初期化完了
  |-- CLAUDE_TRUST_DIALOG_PATTERN チェック (新規)
  |     |-- マッチ && !trustDialogHandled: Enter送信、フラグセット
  |-- 次のポーリングへ (POLL_INTERVAL待機)
ポーリングループ終了（タイムアウト時Error）
```

この構造は、Issue #187で確立された「CLAUDE_SEPARATOR_PATTERNを初期化判定から除外」した設計と整合する。初期化完了判定はCLAUDE_PROMPT_PATTERNのみが担い、CLAUDE_TRUST_DIALOG_PATTERNは中間状態の処理に使用される。

---

## 承認ステータス

**Status: Approved**

設計方針書はSOLID、KISS、YAGNI、DRY全ての設計原則に準拠している。変更範囲が最小限に抑えられ、既存アーキテクチャとの一貫性が高い。必須改善項目はなく、推奨改善項目もコメント追加レベルの軽微なものにとどまる。

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0件 |
| Should Fix | 2件 |
| Consider | 2件 |

---

*Generated by architecture-review-agent for Issue #201 Stage 1*
