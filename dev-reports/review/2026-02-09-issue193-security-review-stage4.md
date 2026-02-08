# Issue #193 セキュリティレビュー (Stage 4)

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue | #193 Claude Code複数選択肢プロンプト検出 |
| レビューステージ | Stage 4: セキュリティレビュー |
| レビュー日 | 2026-02-09 |
| 設計書 | dev-reports/design/issue-193-multiple-choice-prompt-detection-design-policy.md |
| 総合評価 | 条件付き承認 (conditionally_approved) |
| スコア | 4/5 |
| リスク評価 | 技術: low / セキュリティ: medium / 運用: low |

---

## エグゼクティブサマリー

Issue #193の設計方針書をOWASP Top 10準拠およびユーザー指定の7つのセキュリティ観点でレビューした。全体として設計のセキュリティ考慮は適切であり、重大な脆弱性は検出されなかった。ただし、`requireDefaultIndicator=false`時のAuto-Yes誤検出による意図しないコマンド実行リスクについて、既存の多層防御の残存層（Layer 1, Layer 3）だけでは一部のエッジケースで防御が不十分となる可能性があり、追加の防御策を検討すべきである。

---

## 詳細レビュー結果

### 1. ReDoS対策: 正規表現パターンの安全性

**判定: PASS**

対象パターン:

| パターン | 定義 | 安全性 |
|---------|------|--------|
| `DEFAULT_OPTION_PATTERN` | `/^\s*\u276F\s*(\d+)\.\s*(.+)$/` | 両端アンカー付き。繰り返し量指定子の入れ子なし。ReDoS安全。 |
| `NORMAL_OPTION_PATTERN` | `/^\s*(\d+)\.\s*(.+)$/` | 両端アンカー付き。繰り返し量指定子の入れ子なし。ReDoS安全。 |
| `TEXT_INPUT_PATTERNS` | 各パターン (`/type\s+here/i` 等) | 量指定子は`\s+`のみ。入れ子なし。安全。 |
| `ANSI_PATTERN` | `/\x1b\[[0-9;]*[a-zA-Z]\|\x1b\][^\x07]*\x07\|\[[0-9;]*m/g` | 量指定子は`[0-9;]*`と`[^\x07]*`。文字クラスが限定的で入れ子なし。安全。 |

設計書のセクション6で`S4-001`タグが付与され、明示的にReDoS安全である旨がコメントされている。

**追加確認**: `isContinuationLine()`内のパターン（`/^\s{2,}[^\d]/`, `/^\s*\d+\./`, `/^[\/~]/`, `/^[a-zA-Z0-9_-]+$/`）も全てアンカー付きまたは限定的な文字クラスであり、ReDoS安全である。

**結論**: 全正規表現パターンはReDoS攻撃に対して安全である。

---

### 2. コマンドインジェクション: detectPrompt()の入力経路

**判定: PASS**

`detectPrompt()`の入力は全て`tmux capture-pane`コマンドの標準出力に由来する。データフローは以下の通り:

```
tmux capture-pane -t "${sessionName}" -p -e -S ... -E ...
  |
  v
capturePane() [src/lib/tmux.ts L263-297]
  |
  v
captureSessionOutput() [src/lib/cli-session.ts L38-60]
  |
  v
stripAnsi() -> detectPrompt()
```

攻撃面の分析:

| 経路 | リスク | 理由 |
|------|--------|------|
| tmux capture-pane出力 | なし | ローカルプロセスの標準出力。外部ユーザーが直接制御不可。 |
| sessionName | 低 | `validateSessionName()`（`/^[a-zA-Z0-9_-]+$/`）で検証済み。`capturePane()`のexecAsync呼び出しではdouble quote内に展開。 |
| answer (prompt-response API) | 低 | `sendKeys()`でsingle quoteエスケープ済み。ただしtmuxのsend-keys経由であり、シェルコマンドとしては実行されない。 |

**注意点**: `tmux.ts`の`sendKeys()`関数は`execAsync()`を使用しており、sessionNameとkeysをシェルコマンド文字列に埋め込む。sessionNameは検証済みだが、`sendKeys()`自身は検証を行わず、呼び出し元の責任で検証する設計となっている。Issue #193の変更ではこの部分は変更されないが、Auto-YesパスでのsendKeys呼び出しにおいてsessionNameがCLIToolManager経由で取得されることを確認した。

**結論**: 外部入力経由のコマンドインジェクション攻撃面は存在しない。

---

### 3. 信頼境界: buildDetectPromptOptions()のcliToolId検証

**判定: PASS**

`buildDetectPromptOptions(cliToolId: CLIToolType)`の入力であるcliToolIdの検証状況を各呼び出し元で確認した:

| 呼び出し元 | cliToolId取得方法 | 検証 |
|-----------|-----------------|------|
| `prompt-response/route.ts` | リクエストボディ `cliTool` || DB `worktree.cliToolId` || `'claude'` | `CLIToolManager.getTool(cliToolId)`が不正IDに対してエラースロー |
| `current-output/route.ts` | クエリパラメータ `cliTool` | `isCliTool()`関数で`SUPPORTED_TOOLS`（'claude','codex','gemini'）に含まれるか検証 |
| `auto-yes-manager.ts` | `startAutoYesPolling()`の引数（APIルートから伝搬） | `isValidWorktreeId()`でworktreeId検証。cliToolIdはCLIToolType型制約 |
| `status-detector.ts` | `detectSessionStatus()`の引数（APIルートから伝搬） | CLIToolType型制約 |
| `response-poller.ts` | `startPolling()`の引数 | CLIToolType型制約 |

TypeScriptの型システムによるコンパイル時チェックに加え、APIルートでのランタイム検証が適切に行われている。

**結論**: 信頼境界は適切に設定されている。

---

### 4. 誤検出による意図しないコマンド実行リスク (SEC-001)

**判定: CONDITIONALLY PASS -- Must Fix**

これが本レビューにおける最も重要なセキュリティ項目である。

#### リスクシナリオ

`requireDefaultIndicator=false`が設定されるのはClaude Codeコンテキストのみであり、`buildDetectPromptOptions()`で制御される。この場合、以下の多層防御の状態は:

| Layer | 防御内容 | 状態 |
|-------|---------|------|
| Layer 1 | thinking状態スキップ | 維持（thinking=trueならスキップ） |
| Layer 2 Pass 1 | ❯存在チェック | **スキップ** |
| Layer 3 | 連番検証 | 維持 |
| Layer 4 | hasDefaultIndicator + options >= 2 | hasDefaultIndicatorは**スキップ**、options >= 2は維持 |
| Pass 2逆スキャン | 質問行検出 | 維持だが**不完全** |

**問題のエッジケース**:

Claude Codeがidle状態（thinking=false、❯プロンプト表示中）で、前回のレスポンスにtmuxバッファ上に残存する番号付きリストが存在する場合:

```
前回のレスポンスの末尾部分:

手順は以下の通りです:

1. src/lib/foo.tsを作成
2. tests/unit/foo.test.tsを作成
3. npm run test:unitを実行

─────────────────────────────────────
❯
```

この場合:
- Layer 1: thinking=false -> スキップされない
- Pass 1: `requireDefaultIndicator=false`でスキップ -> 通過
- Pass 2: `NORMAL_OPTION_PATTERN`で1, 2, 3を収集。逆スキャンで「手順は以下の通りです:」をquestionとして検出
- Layer 3: 1, 2, 3は連番 -> 通過
- Layer 4: options.length=3 >= 2 -> 通過
- 結果: `isPrompt: true`、Auto-Yesが「1」を自動送信

ただし、`detectPrompt()`は`detectSessionStatus()`のL87で`lastLines`（最後の15行）に対して呼ばれる場合と、`current-output/route.ts`のL88で`cleanOutput`（全出力）に対して呼ばれる場合がある。15行ウィンドウでは❯プロンプトラインが含まれるため、`detectPrompt()`内の他のパターン（Pattern 1-5）にマッチせず、`detectMultipleChoicePrompt()`に進む。

`status-detector.ts`では15行ウィンドウに❯プロンプトが含まれるため、Priority 3の「input_prompt」として`ready`ステータスが返される前に、Priority 1のprompt検出が実行される。しかし、15行ウィンドウ内に番号リストと質問行が収まっている場合、プロンプトとして誤検出される。

**既存の緩和要因**:

1. `detectMultipleChoicePrompt()`のPass 2逆スキャンでは、非オプション行（質問行の候補）を検出した時点でスキャンを停止する。質問行が見つかった場合、questionEndIndexが設定され、質問テキストが抽出される。
2. ただし、`questionEndIndex = -1`の場合（質問行が見つからない場合）、ジェネリックな質問文`'Please select an option:'`が使用されて**isPromptがtrueで返る**。これは番号リストのみの出力でもプロンプトとして検出されることを意味する。

**設計書の記載**: セクション6.1の「追加防御」にPass 2の逆スキャンが既存動作で維持されると記載されているが、`questionEndIndex = -1`のケースでisPrompt=trueとなる動作が防御として不十分であることの分析が欠落している。

**推奨対応**: `requireDefaultIndicator=false`かつ`questionEndIndex === -1`の場合、`isPrompt: false`を返す追加条件の導入を検討する。これにより、質問行を伴わない孤立した番号リストの誤検出を防止できる。

#### 影響度

Auto-Yesが有効な場合に「1」が自動送信される。Claude CLIのプロンプトに「1」が入力されるため:
- Claude CLIが入力待ち状態の場合: 「1」がメッセージとして送信される（無害だが意図しない動作）
- Claude CLIが処理中の場合: 入力は無視される（無害）

直接的なセキュリティ上の重大な影響（データ損失、権限昇格等）は低いが、意図しないコマンド実行の間接的リスクがある。

---

### 5. ANSIエスケープシーケンスを利用したパターンバイパス (SEC-002)

**判定: PASS WITH NOTES**

#### stripAnsi()の適用状況

設計書のIA-001方針（セクション4.5, 6.3）により、`response-poller.ts`の`detectPromptWithOptions()`ヘルパー内で`stripAnsi()`を一律適用する構造的な対策が設計されている。各呼び出し箇所の状況:

| 呼び出し箇所 | stripAnsi適用 | 状態 |
|-------------|-------------|------|
| prompt-response/route.ts L75 | L74でstripAnsi(currentOutput) | 適用済み |
| auto-yes-manager.ts L290 | L279でstripAnsi(output) | 適用済み |
| status-detector.ts L87 | L81でstripAnsi(output) | 適用済み |
| response-poller.ts L248 | L247でstripAnsi(fullOutput) + ヘルパー内で二重適用 | 適用済み（冪等で無害） |
| response-poller.ts L442 | ヘルパー内でstripAnsi適用 | **設計で解消予定** |
| response-poller.ts L556 | ヘルパー内でstripAnsi適用 | **設計で解消予定** |
| current-output/route.ts L88 | L77でstripAnsi(output) | 適用済み |
| claude-poller.ts L164, L232 | stripAnsi未適用 | 到達不能コード（P2） |

**バイパスシナリオの分析**:

ANSIエスケープシーケンスが`stripAnsi()`で除去されずに残存した場合、以下のパターンバイパスが理論的に可能:

```
ESC[31m1ESC[0m. Yes   ->  stripAnsi後: "1. Yes"  (正常検出)
ESC[31m1ESC[0m. Yes   ->  stripAnsi未適用: "\x1b[31m1\x1b[0m. Yes"  (パターン不一致)
```

しかし、`response-poller.ts` L442/L556のANSI未ストリップ問題は設計書のIA-001方針で解消される予定であり、設計通り実装されればバイパスリスクは解消される。

#### ANSI_PATTERNの網羅性

`/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g`

カバーされるパターン:
- CSI sequences: `ESC[...letter` (SGR, cursor movement, etc.)
- OSC sequences: `ESC]...BEL`
- Bare SGR: `[...m` (tmux出力の一部で出現)

カバーされないパターン:
- 8-bit CSI: `0x9B` (C1 control code)
- DEC private modes: `ESC[?25h` (疑問符がパターンで`[0-9;]*`にマッチしない)
- Character set switching: `ESC(0`, `ESC(B`
- 一部のSGR拡張: 理論的にはカバー済み（`[0-9;]*[a-zA-Z]`が`[38;2;r;g;bm`にマッチ）

**実運用上のリスク**: tmux capture-paneの`-e`オプションは主にSGR（色・スタイル）シーケンスを出力する。DEC private modesやC1制御コードが出力されることは稀であり、実運用上のバイパスリスクは非常に低い。

**結論**: 設計書のIA-001方針が実装されれば、ANSIバイパスリスクは構造的に解消される。ANSI_PATTERNの網羅性に関する制限事項はドキュメント化が望ましい。

---

### 6. 情報漏洩: ログ出力の機密情報

**判定: PASS**

ログ出力の分析:

| モジュール | ログ出力内容 | 機密情報リスク |
|-----------|------------|-------------|
| `prompt-detector.ts` L58-62 | `question`, `optionsCount` | questionはtmux出力由来。機密情報の可能性は低いが、ゼロではない |
| `prompt-detector.ts` L45 | `outputLength` | 安全 |
| `auto-yes-manager.ts` L323 | worktreeId | 安全 |
| `auto-yes-manager.ts` L330 | worktreeId, errorMessage | errorMessageにはスタックトレースが含まれる可能性あるが、Error.messageのみ |
| `response-poller.ts` L649 | worktreeId, errorMessage | 同上 |

`logger.ts`は構造化ログユーティリティであり、`[MF-1] Sensitive data filtering (sanitize)`機能を持つ。`detectPrompt()`のlogger.info()出力はlogger経由であるため、sanitize対象に設定可能。

**Issue #193固有のリスク**: `buildDetectPromptOptions()`はcliToolIdのみを処理し、機密情報は含まない。新規のログ出力は追加されない。

**結論**: 情報漏洩リスクは低い。既存のログ出力に関する制限事項であり、Issue #193の変更に固有のリスクではない。

---

### 7. stripAnsi()のパターン網羅性

**判定: PASS WITH NOTES** (SEC-002と同一の分析結果)

詳細はセクション5を参照。

補足として、`ESC[?25h`（カーソル表示）のようなDEC private modesが`ANSI_PATTERN`の`\x1b\[[0-9;]*[a-zA-Z]`にマッチするかの検証:
- `ESC[?25h` -> `\x1b[` は `\x1b\[` にマッチ。`?25` は `[0-9;]*` にマッチ**しない**（`?`が含まれるため）。
- したがって、DEC private modesはカバーされない。

ただし、tmux capture-pane出力にDEC private modesが含まれることは一般的ではなく、実運用上の影響は限定的。

---

## OWASP Top 10 チェックリスト

| # | カテゴリ | 判定 | 備考 |
|---|---------|------|------|
| A01 | Broken Access Control | N/A | 認可ロジックへの変更なし |
| A02 | Cryptographic Failures | N/A | 暗号化処理への変更なし |
| A03 | Injection | PASS | detectPrompt()入力はtmux出力由来。ReDoS安全。コマンドインジェクション対策済み |
| A04 | Insecure Design | CONDITIONAL | SEC-001: requireDefaultIndicator=false時の誤検出リスクに追加防御策が望ましい |
| A05 | Security Misconfiguration | PASS | デフォルト値true（既存動作維持）。buildDetectPromptOptions()で一元管理 |
| A06 | Vulnerable Components | N/A | 新規依存ライブラリの追加なし |
| A07 | Auth Failures | N/A | 認証ロジックへの変更なし |
| A08 | Software/Data Integrity | PASS | type-only importによる循環依存なし。コード整合性は維持 |
| A09 | Logging/Monitoring | PASS | 機密情報のログ出力なし。構造化ログ使用 |
| A10 | SSRF | N/A | サーバーサイドリクエスト処理への変更なし |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | requireDefaultIndicator=false時のAuto-Yes誤検出によるCLI入力送信 | Medium | Low | P1 (Must Fix) |
| セキュリティ | ANSI_PATTERNの網羅性制限によるパターンバイパス | Low | Very Low | P2 (Should Fix) |
| セキュリティ | getAnswerInput()エラーメッセージへのユーザー入力反映 | Low | Low | P2 (Should Fix) |
| 技術 | stripAnsi()二重適用のパフォーマンス影響 | Low | Medium | P3 (Consider) |
| 運用 | detectPrompt()ログのquestionフィールドに機密情報が含まれる可能性 | Low | Very Low | P3 (Consider) |

---

## 改善推奨事項

### 必須改善項目 (Must Fix)

#### SEC-001: requireDefaultIndicator=false時のquestionEndIndex防御

**問題**: `requireDefaultIndicator=false`かつ`questionEndIndex === -1`（質問行なし）の場合、番号リストのみの出力がプロンプトとして誤検出され、Auto-Yesが「1」を自動送信するリスク。

**推奨対応**: `detectMultipleChoicePrompt()`のLayer 4ブロック内（セクション4.3のL196-200付近）に、以下の追加条件を設計書に追加:

```
// Layer 4 変更（追加防御）
} else {
  // requireDefaultIndicator = false: options.length >= 2 のみ
  if (collectedOptions.length < 2) {
    return { isPrompt: false, cleanContent: output.trim() };
  }
  // 追加防御: 質問行がない場合はプロンプトとして検出しない
  if (questionEndIndex === -1) {
    return { isPrompt: false, cleanContent: output.trim() };
  }
}
```

この防御により、質問テキストを伴わない孤立した番号リスト（前回レスポンスの残存テキスト等）の誤検出を防止できる。

**対応箇所**: 設計書セクション4.3のLayer 4変更箇所、セクション6.1の防御層テーブル

### 推奨改善項目 (Should Fix)

#### SEC-002: ANSI_PATTERNの制限事項ドキュメント化

`cli-patterns.ts`の`stripAnsi()`関数のJSDocに、カバーされないANSIパターン（DEC private modes、C1 control codes）を記載し、将来のstrip-ansiパッケージ採用検討を記録する。

#### SEC-003: getAnswerInput()のエラーメッセージサニタイズ

`prompt-detector.ts` L418, L430のエラーメッセージからユーザー入力の直接埋め込みを排除するか、入力値のトランケート・サニタイズを行う。

### 検討事項 (Consider)

#### SEC-004: sendKeys()のsessionName検証の統合テスト

Auto-Yesパスでの`sendKeys()`呼び出しにおいて、sessionNameの検証チェーンが正しく機能することを統合テストで確認する。

#### SEC-005: cliToolIdの信頼境界は適切であり、追加対応不要

#### SEC-006: ログ出力のquestionフィールドのマスク検討

---

## 承認状況

**条件付き承認 (Conditionally Approved)**

SEC-001（requireDefaultIndicator=false時のquestionEndIndex防御）の設計反映を条件として承認する。この条件が満たされれば、本設計はセキュリティ観点で適切である。

SEC-002, SEC-003は推奨改善項目であり、実装時に対応することが望ましいが、承認の必須条件ではない。
