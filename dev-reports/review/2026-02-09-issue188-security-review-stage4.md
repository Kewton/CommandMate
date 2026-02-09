# Architecture Review: Issue #188 - Security Review (Stage 4)

**Issue**: #188 - 応答完了後もスピナーが表示され続ける（thinkingインジケータの誤検出）
**Focus**: セキュリティ (Security)
**Date**: 2026-02-09
**Status**: approved
**Score**: 4/5

---

## 1. Executive Summary

Issue #188 の設計方針書に対するセキュリティレビュー（Stage 4）を実施した。本変更は `current-output/route.ts` のインラインthinking/prompt判定ロジックを `detectSessionStatus()` に統合し、thinking検出ウィンドウを15行から5行に縮小する修正である。

セキュリティ観点では、本変更は既存のセキュリティ防御レイヤー（Issue #161 Layer 1-3、Issue #193 SEC-001/002/003、Issue #191 SF-001、Issue #138 DoS防止）を全て維持しており、新たな重大なセキュリティリスクは導入されない。Must Fix項目はゼロ、Should Fix 2件（いずれもlow severity、既存の問題の確認）、Consider 3件という結果となった。

---

## 2. OWASP Top 10 Compliance Checklist

### 2.1 A01:2021 - Broken Access Control

**Status**: PASS (注意事項あり)

- `params.id` は DB参照のキーとして使用される。`better-sqlite3` のプリペアドステートメントにより SQL インジェクションは防止されている
- `worktreeId` の検証は `auto-yes-manager.ts` の `isValidWorktreeId()` で `WORKTREE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/` を使用して実施されている
- 注意: `current-output/route.ts` L33 でエラーメッセージに `params.id` が含まれている（SF-002-S4として記載）。ただし、これは既存の問題であり本変更で導入されるものではない

### 2.2 A02:2021 - Cryptographic Failures

**Status**: NOT APPLICABLE

本変更は暗号化処理を含まない。

### 2.3 A03:2021 - Injection

**Status**: PASS

- **コマンドインジェクション防止**: tmux操作は `sendKeys()` 関数経由で実行され、`validateSessionName()` でセッション名のフォーマットが検証される（`/^[a-zA-Z0-9_-]+$/`）
- **正規表現インジェクション防止**: `detectThinking()`、`detectPrompt()` で使用される正規表現はモジュールレベルの定数（`CLAUDE_THINKING_PATTERN`、`DEFAULT_OPTION_PATTERN`、`NORMAL_OPTION_PATTERN`等）であり、ユーザー入力から動的に構築されることはない
- **ReDoSリスク評価**: 主要な正規表現パターンを検証した
  - `CLAUDE_THINKING_PATTERN`: `[chars]\\s+.+…|to interrupt\\)` -- `.+` は行内マッチング（`m` フラグ使用、行単位で適用）であり、thinkingLines は最大5行に制限されるためリスクは極めて低い
  - `DEFAULT_OPTION_PATTERN`: `/^\\s*\\u276F\\s*(\\d+)\\.\\s*(.+)$/` -- 両端アンカーでS4-001として明記済み
  - `NORMAL_OPTION_PATTERN`: `/^\\s*(\\d+)\\.\\s*(.+)$/` -- 同上
  - `ANSI_PATTERN`: `/\\x1b\\[[0-9;]*[a-zA-Z]|...` -- 文字クラスベースでバックトラッキングリスクなし
- **パターンインジェクション**: tmux出力内に悪意のあるパターンが含まれることで誤検出が発生するリスクについて検討。thinking検出ウィンドウの縮小（5行）により、攻撃者がthinkingパターンをバッファに注入してステータスを誤認させる攻撃面が縮小される（攻撃者は末尾5行にパターンを配置する必要がある）。これはセキュリティ改善となる

### 2.4 A04:2021 - Insecure Design

**Status**: PASS

- **プロンプト最優先設計**: `detectSessionStatus()` はプロンプト検出を最優先（Step 1）、thinking検出を2番目（Step 2）に配置。これにより、プロンプトが表示されている状態でthinkingインジケータが残存していても、正しく `waiting` ステータスが返される。Auto-Yesが不正に発火するリスクはない
- **Defense-in-Depth 維持**: Issue #161の多層防御（Layer 1: thinkingスキップ、Layer 2: 2パス cursor検出、Layer 3: 連番検証）が全て維持されている
- **ウィンドウサイズの設計根拠**: thinking検出を5行に縮小する設計は、thinkingインジケータが常にバッファ末尾に表示されるというClaude CLIの仕様に基づく合理的な判断

### 2.5 A05:2021 - Security Misconfiguration

**Status**: PASS

- ウィンドウサイズが定数化されている（`STATUS_THINKING_LINE_COUNT=5`、`STATUS_CHECK_LINE_COUNT=15`）ことで、設定ミスのリスクが低減
- `SF-002` リネーム（`STATUS_` プレフィックス追加）により、`auto-yes-manager.ts` の `THINKING_CHECK_LINE_COUNT=50` との混同リスクが排除されている
- 定数間の関連性がコメントで明記されている（SF-003 S3: response-poller.tsの5行チェックにSTATUS_THINKING_LINE_COUNTへの相互参照コメント）

### 2.6 A06:2021 - Vulnerable and Outdated Components

**Status**: NOT APPLICABLE

新規依存ライブラリの追加なし。

### 2.7 A07:2021 - Identification and Authentication Failures

**Status**: NOT APPLICABLE

本変更は認証処理を含まない。

### 2.8 A08:2021 - Software and Data Integrity Failures

**Status**: PASS

- `detectSessionStatus()` の戻り値はメモリ内のみで使用（API JSON応答の構築に使用）。DBへの永続化パスは含まない
- `response-poller.ts` のDB書き込み（`createMessage`）は既存ロジックであり、本変更の対象外

### 2.9 A09:2021 - Security Logging and Monitoring Failures

**Status**: PASS

- 既存のログ出力パターンが維持されている
- `auto-yes-manager.ts` のログは `worktreeId` のみを含み、セッション内容やユーザー入力は記録されない
- エラーハンドリングで `error.message` が使用される箇所があるが、制御された文脈内であり外部への漏洩パスは限定的

### 2.10 A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: NOT APPLICABLE

本変更は外部HTTPリクエストを含まない。

---

## 3. Security-Specific Analysis

### 3.1 Input Validation and Sanitization

| 入力ソース | 検証方法 | 評価 |
|-----------|---------|------|
| `params.id` (worktree ID) | DB参照で存在確認、`auto-yes-manager.ts`では`WORKTREE_ID_PATTERN`で検証 | PASS |
| `cliToolParam` (CLI tool ID) | `SUPPORTED_TOOLS` 配列に対するincludes()チェック | PASS |
| tmux output (raw) | `stripAnsi()` でANSIエスケープ除去後にパターンマッチング | PASS (SEC-002制限事項あり) |
| sessionName | `validateSessionName()` で `/^[a-zA-Z0-9_-]+$/` 検証 | PASS |

**変更による影響**:
- `current-output/route.ts` の修正で、入力検証のフローが変わる。修正前は独自に `stripAnsi()` + 非空行フィルタリングを実行していたが、修正後は `detectSessionStatus()` 内で `stripAnsi()` が一括適用される。これにより入力サニタイゼーションの責任が明確になり、二重stripAnsi()の無駄が除去される
- `detectSessionStatus()` は第一引数として raw tmux output を受け取り、内部で `stripAnsi()` を適用する入力契約が Issue #180 で確立されている。本変更はこの契約を維持する

### 3.2 Pattern Injection Vulnerability Analysis

tmux出力はCLI tool（Claude、Codex、Gemini）からのテキストで構成される。悪意のあるCLI出力が意図的にパターンをインジェクトする可能性について分析する。

**攻撃シナリオ1: Thinkingパターンインジェクション**
- 攻撃: CLI出力にthinkingインジケータパターン（例: `* Planning...`）を含める
- 影響（修正前）: 15行ウィンドウ内にパターンがあればthinking=trueとなり、ステータスがrunningになる
- 影響（修正後）: 5行ウィンドウに縮小されるため、攻撃者は末尾5行にパターンを配置する必要がある。攻撃面は縮小する。更に、プロンプト検出が最優先のため、プロンプトが表示されている場合はthinkingパターンは無視される
- **評価**: 修正後は攻撃面が縮小（セキュリティ改善）

**攻撃シナリオ2: プロンプトパターンインジェクション**
- 攻撃: CLI出力にプロンプトパターン（例: `Do you want to proceed? (y/n)`）を含める
- 影響: Auto-Yesモード有効時に自動応答がトリガーされる
- 防御: Issue #161 Layer 1-3、Issue #193 Layer 5 SEC-001 が多層防御として機能。本変更はこれらを全て維持する
- **評価**: PASS（既存防御維持）

**攻撃シナリオ3: ANSI エスケープシーケンスを使った検出回避**
- 攻撃: プロンプト文字列内にANSIコードを挿入してstripAnsi()後のパターンマッチングを回避
- 影響: プロンプトが検出されず、Auto-Yesが発火しない（安全側にフェイル）
- SEC-002の既知制限（8-bit CSI等）を使えば理論的にstripAnsi()を回避できるが、実用上のリスクは低い
- **評価**: PASS（安全側にフェイル）

### 3.3 Information Disclosure Analysis

| 箇所 | リスク | 重要度 |
|------|-------|--------|
| `current-output/route.ts` L33: `params.id` in error message | 既存の問題。worktree IDがJSON応答に含まれる | low |
| `current-output/route.ts` L130-135: catch block | `error` を `console.error` に出力。JSON応答は固定メッセージ 'Failed to get current output' | low |
| `validation.ts` L38: sessionName in error message | `Invalid session name format: ${sessionName}` でユーザー入力が含まれる | low |
| `response-poller.ts` L664: `errorMessage` in console | error.messageを`console.error`に出力。外部に公開されない | negligible |

### 3.4 Window Size Change Security Implications

thinking検出ウィンドウの15行から5行への縮小がセキュリティに与える影響を分析する。

| 観点 | 評価 |
|------|------|
| Issue #161 Layer 1防御への影響 | `detectSessionStatus()`内でプロンプトが最優先のため、thinking検出の結果がプロンプト検出をブロックすることはない。Layer 1は `auto-yes-manager.ts` で独立して機能し（THINKING_CHECK_LINE_COUNT=50は変更なし）、完全に維持される |
| Auto-Yes誤発火リスク | `auto-yes-manager.ts` のthinking検出ウィンドウ（50行）は変更されないため、thinking中のAuto-Yes誤発火防止は完全に維持。`status-detector.ts`の5行ウィンドウはUI表示専用であり、Auto-Yes動作には影響しない |
| ステータス表示の正確性 | thinkingインジケータがバッファ末尾に表示されるCLI仕様に基づき、5行で十分にキャプチャできる。完了済みthinkingサマリーの誤検出が防止される（これが本修正の目的） |
| プロンプト検出への影響 | プロンプト検出ウィンドウ（15行）は変更なし。`prompt-detector.ts`内部の50行ウィンドウも変更なし |

### 3.5 Maintenance of Existing Security Defenses

| 防御レイヤー | 関連Issue | 維持状態 | 検証方法 |
|------------|---------|---------|---------|
| Layer 1: Thinking中のprompt検出スキップ | #161 | 維持 | `detectSessionStatus()` のプロンプト最優先順序。`auto-yes-manager.ts` の独立したthinkingチェック（50行）は変更なし |
| Layer 2: 2パス cursor検出 | #161 | 維持 | `prompt-detector.ts` は変更なし |
| Layer 3: 連番検証 | #161 | 維持 | `prompt-detector.ts` の `isConsecutiveFromOne()` は変更なし |
| Layer 5 SEC-001: questionEndIndexガード | #193 | 維持 | `prompt-detector.ts` は変更なし |
| SEC-002: stripAnsi() | #193 | 維持 | `detectSessionStatus()` 内で一括適用。カバレッジ限界は既知（JSDoc記載） |
| SEC-003: 固定エラーメッセージ | #193 | 維持 | `getAnswerInput()` のエラーメッセージは変更なし |
| SF-001: THINKING_CHECK_LINE_COUNT=50 | #191 | 維持 | `auto-yes-manager.ts` は変更なし |
| DoS防止: MAX_CONCURRENT_POLLERS=50 | #138 | 維持 | `auto-yes-manager.ts` は変更なし |
| worktreeId検証 | #138 | 維持 | `isValidWorktreeId()` は変更なし |

---

## 4. Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | エラーメッセージへのユーザー入力含有（既存問題） | Low | Low | P3 |
| セキュリティ | stripAnsi()のカバレッジ制限（SEC-002既知） | Low | Low | P3 |
| セキュリティ | L547-554全文thinkingチェック残存（MF-001 S3） | Low | Medium | P3 |
| 技術的リスク | ウィンドウサイズ変更による予期しないthinking検出漏れ | Low | Low | P3 |
| 運用リスク | status-detectorとauto-yes-managerのウィンドウサイズ差異によるUI不整合（C-002 S3） | Low | Low | P3 |

---

## 5. Detailed Findings

### 5.1 Should Fix Items

#### SF-001-S4: validateSessionName() のエラーメッセージにユーザー入力が含まれる

**ファイル**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-188/src/lib/cli-tools/validation.ts` L38

```typescript
export function validateSessionName(sessionName: string): void {
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error(`Invalid session name format: ${sessionName}`);
  }
}
```

**問題**: Issue #193 SEC-003で `getAnswerInput()` のエラーメッセージを固定メッセージに変更する対策が実施されたが、`validateSessionName()` では同様の対策が未適用。この関数は `current-output/route.ts` の呼び出しチェーン内で使用される可能性があり、`error.message` がJSON応答に含まれた場合、入力されたsessionName（=ユーザー制御可能な文字列）が漏洩する。

**重要度**: low -- 現在のルート実装では catch ブロックで固定エラーメッセージを返しており、`error.message` がそのまま JSON 応答に含まれることはない。ただし将来の変更で露出するリスクがある。

**推奨対応**: フォローアップIssueでエラーメッセージを `'Invalid session name format'` に変更する。

#### SF-002-S4: current-output/route.ts の404エラーにユーザー入力が含まれる

**ファイル**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-188/src/app/api/worktrees/[id]/current-output/route.ts` L33

```typescript
return NextResponse.json(
  { error: `Worktree '${params.id}' not found` },
  { status: 404 }
);
```

**問題**: `params.id` がJSON応答のエラーメッセージに含まれている。これは複数のroute.tsに共通するパターンであり、情報漏洩のリスクがある（XSSは React の自動エスケープで防止されているが、IDの存在/非存在の情報が漏洩する）。

**重要度**: low -- URL パスパラメータであり、リクエスト者が既に知っている情報。ただしOWASPベストプラクティスとしては固定メッセージが推奨される。

**推奨対応**: プロジェクト全体のエラーメッセージ標準化Issueで対応。

### 5.2 Consider Items

#### C-001-S4: ウィンドウサイズ縮小によるセキュリティ防御への影響

thinking検出ウィンドウの縮小（15行->5行）は、セキュリティ防御の観点では以下の理由で安全である:

1. `detectSessionStatus()` のプロンプト最優先ロジックにより、プロンプト検出はthinking検出の結果に依存しない
2. Auto-Yes の thinking 防御は `auto-yes-manager.ts` の独立した50行ウィンドウで維持される
3. thinkingインジケータは常にバッファ末尾に表示されるため、5行で十分にキャプチャできる

ただし、将来 CLI ツールの出力形式が変更され、thinkingインジケータが末尾以外に表示されるようになった場合は、再評価が必要。

#### C-002-S4: stripAnsi() のカバレッジ限界

`stripAnsi()` の SEC-002 既知制限事項（8-bit CSI、DEC private modes 等）は文書化されている。本変更で `detectSessionStatus()` を共通パスとして使用することにより、stripAnsi() の品質がステータス検出全体のセキュリティに影響する表面が統一されるが、カバレッジ自体は変わらない。tmux `capture-pane` 出力がこれらの特殊シーケンスを含む可能性は低く、リスクは低い。

#### C-003-S4: response-poller.ts L547-554 の全文thinkingチェック残存

Stage 3 の MF-001 で識別されたこの問題は、セキュリティの観点からも注意が必要。全文thinkingチェックにより、スクロールバックに残存するthinkingサマリーがpending promptの `answered` 判定に影響する可能性がある。Auto-Yesモードでpromptが誤ってanswered扱いされた場合、ユーザーが意図しない自動応答が実行される可能性がある（間接的なリスク）。設計書でフォローアップIssue作成が計画されており、コメントで既知制限が明示される予定。

---

## 6. Security Design Evaluation

### 6.1 設計方針書 Section 5 (セキュリティ設計) の評価

設計方針書の Section 5.1（既存セキュリティ対策の維持）と Section 5.2（新たなリスクと対策）は適切に記載されている。

**良い点**:
- Issue #161/193/191/138 の既存セキュリティ対策の維持方法が明確に記載されている
- 各防御レイヤーの維持メカニズム（プロンプト最優先順序、prompt-detector.ts未変更等）が具体的
- L547-554の既知制限事項がリスクテーブルに含まれている

**改善の余地**:
- OWASP Top 10 に対する明示的なチェックリストは設計書に含まれていない（本レビューで補完）
- パターンインジェクション攻撃シナリオの分析が設計書に明示されていない（ただし、多層防御の設計により実質的に対応されている）

### 6.2 DR-002代替案のセキュリティ評価

`current-output/route.ts` で `detectPrompt()` を個別実行する設計は、セキュリティ観点では以下の特性を持つ:

- `isPromptWaiting` のsource of truthが `statusResult.hasActivePrompt` に統一される。これにより、全文に対する `detectPrompt()` が `isPrompt: true` を返しても、15行ウィンドウ内にプロンプトがなければ `isPromptWaiting: false` となる。スクロールバックの古いプロンプトがアクティブと誤判定されるリスクが排除される（セキュリティ改善）
- `promptData` の取得は `cleanOutput`（全文）に対して行われるが、これは表示用データの取得のみに使用され、Auto-Yesの判定には使用されない

---

## 7. Approval Status

**Status: approved**

本設計方針書はセキュリティ観点から承認する。以下の根拠に基づく:

1. Must Fix 項目が存在しない
2. 既存の全セキュリティ防御レイヤー（Issue #161 Layer 1-3、Issue #193 SEC-001/002/003、Issue #191 SF-001、Issue #138 DoS防止）が維持される
3. thinking検出ウィンドウの縮小はパターンインジェクション攻撃面を縮小するセキュリティ改善である
4. `isPromptWaiting` のsource of truth統一により、スクロールバックの古いプロンプトの誤検出リスクが排除される
5. Should Fix 2件はいずれも既存の問題（low severity）であり、本変更で導入されるものではない
6. OWASP Top 10 の該当項目全てにPASSまたはNOT APPLICABLEの評価

---

## 8. Review Summary

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Consider | 3 |

---

*Generated by architecture-review-agent for Issue #188 Stage 4 Security Review (2026-02-09)*
