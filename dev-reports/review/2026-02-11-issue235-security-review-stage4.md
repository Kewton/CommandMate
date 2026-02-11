# Issue #235 セキュリティレビュー (Stage 4)

**レビュー日**: 2026-02-11
**対象Issue**: #235 プロンプト検出時の指示メッセージ保持（rawContent導入）
**レビュー種別**: セキュリティレビュー
**ステータス**: 条件付き承認 (Conditionally Approved)
**スコア**: 4/5

---

## 1. エグゼクティブサマリー

Issue #235 の設計方針書をOWASP Top 10準拠、XSS対策、入力バリデーション、データサニタイズ、情報漏洩リスク、Denial of Serviceリスクの観点からセキュリティレビューを実施した。

**結論**: 設計方針書のセキュリティ設計は概ね適切であり、重大な脆弱性は検出されなかった。`dangerouslySetInnerHTML`を使用しないReactプレーンテキスト表示、`stripAnsi()`によるANSIエスケープコード除去、`truncateRawContent()`によるサイズ制限の3層防御が設計されている。SQLインジェクションについてもbetter-sqlite3のパラメタライズドクエリにより防御されている。ただし、`stripAnsi()`の既知の制限（SEC-002）とrawContentの大容量化に伴う残留制御文字リスクの分析が不足しており、設計書への追記を推奨する。

---

## 2. OWASP Top 10 チェックリスト

| # | カテゴリ | 判定 | 詳細 |
|---|---------|------|------|
| A01 | Broken Access Control | N/A | 本変更はアクセス制御に関与しない |
| A02 | Cryptographic Failures | N/A | 暗号化処理の変更なし |
| A03 | Injection | PASS | `createMessage()`はパラメタライズドクエリを使用（`db.prepare()` + `?`プレースホルダ）。rawContentがSQL文に直接組み込まれることはない |
| A04 | Insecure Design | PASS | rawContentのサイズ制限、stripAnsiサニタイズ、Reactデフォルトエスケープの3層防御 |
| A05 | Security Misconfiguration | N/A | 設定変更なし |
| A06 | Vulnerable Components | N/A | 新規依存パッケージの追加なし |
| A07 | Auth Failures | N/A | 認証・認可の変更なし |
| A08 | Software/Data Integrity | PASS | rawContentのソースはtmux captureSession出力のみ。外部ユーザー入力を直接受け付けるパスはない |
| A09 | Logging/Monitoring | PASS | 既存のlogger機構を継承。rawContentはDB保存で監査証跡あり |
| A10 | SSRF | N/A | サーバーサイドリクエストの変更なし |

---

## 3. セキュリティ観点別の詳細分析

### 3.1 XSS対策

**評価: 良好**

設計方針書Section 8.1で明記されている以下の対策は適切である。

1. **`dangerouslySetInnerHTML`不使用**: `PromptMessage.tsx`の現行実装を確認し、JSXテキストノードによるプレーンテキスト表示を使用していることを確認した。設計書のJSX変更概要（Section 4.3.2）でも`{displayContent}`としてテキストノードでレンダリングしており、HTMLインジェクションのリスクはない。

2. **Reactデフォルトエスケープ**: Reactは`<`, `>`, `&`, `"`, `'`をHTMLエンティティにエスケープする。rawContentにこれらの文字が含まれていても安全にテキストとして表示される。

3. **stripAnsi()適用**: rawContentのソースとなる`detectPromptWithOptions()`（`response-poller.ts` L100）で`stripAnsi()`が適用される。これによりANSIエスケープシーケンスの大部分が除去される。

**懸念事項（MF-S4-001）**: `stripAnsi()`にはSEC-002として文書化された既知の制限がある（8-bit CSI、DEC private modes等）。rawContentはcleanContentよりもデータ量が大きい（最大5000文字 vs 通常数行）ため、残留制御文字が含まれる確率が相対的に高くなる。ただし、Reactのテキストノードレンダリングでは制御文字はDOMテキストとして扱われ、HTMLタグ生成には至らないため、XSSリスクには発展しない。

### 3.2 入力バリデーション

**評価: 良好**

1. **rawContentのソース**: rawContentは外部ユーザー入力ではなく、tmux captureSession出力（`captureSessionOutput()`）からのみ生成される。攻撃者が直接rawContentの値を制御することはできない。

2. **サイズ制限**: `truncateRawContent()`により200行/5000文字に制限される（MF-001対応済み）。Yes/No・Approveパターンは元々末尾20行に制限されており、追加のバリデーション不要。

3. **型安全性**: `rawContent?: string`はoptionalフィールドとして定義されており、TypeScriptの型システムにより未定義時のフォールバック（`rawContent || cleanContent`）が型安全に実装される。

4. **getDisplayContent()のバリデーション**: `content?.trim()`による空文字チェック、`content.trim() === question.trim()`による重複チェックが設計されている。

### 3.3 データサニタイズ

**評価: 良好（注記あり）**

サニタイズパイプライン:

```
tmux output -> stripAnsi() -> truncateRawContent() -> DB保存 -> WebSocket送信 -> Reactエスケープ表示
```

1. **stripAnsi()**: ANSIエスケープコードの除去は`response-poller.ts`の`detectPromptWithOptions()`内で実行される（L100: `detectPrompt(stripAnsi(output), promptOptions)`）。`stripAnsi()`はidempotentであり、多重適用は安全。

2. **truncateRawContent()**: 末尾切り出し方式（`lines.slice(-200)`, `result.slice(-5000)`）を採用。`String.prototype.split()`と`String.prototype.slice()`のみ使用しており、正規表現は含まれない。

3. **DB保存**: `createMessage()`はbetter-sqlite3の`prepare()`/`run()`を使用。全パラメータがプレースホルダ（`?`）経由で渡され、SQLインジェクションのリスクはない。

### 3.4 情報漏洩リスク

**評価: 概ね良好（SF-S4-001）**

rawContentはtmux出力の末尾最大200行/5000文字を保持する。tmux出力には以下の情報が含まれうる:

- ファイルパス（ユーザーのホームディレクトリ構造）
- ユーザー名（シェルプロンプト由来）
- リポジトリ構成情報

これらはDBに保存され、WebSocket経由でブラウザクライアントにブロードキャストされる。ただし:

- **既存リスクの延長**: 従来のcleanContentやnormalメッセージでも同様の情報がDB保存・ブロードキャストされている
- **ローカル開発ツール**: CommandMateはローカルマシン上でのみ動作し、ネットワーク越しの情報漏洩リスクは限定的
- **エクスポート時のサニタイズ**: `log-export-sanitizer.ts`の`sanitizeForExport()`が既存で提供されている

### 3.5 Denial of Service リスク

**評価: 良好**

1. **サイズ制限**: `truncateRawContent()`による200行/5000文字の制限により、メモリ・DBの膨張を防止。

2. **ReDoSリスク**: `truncateRawContent()`は正規表現を使用しないため、ReDoSリスクなし。既存の`detectPrompt()`内のパターンにはReDoSセーフのアノテーション（S4-001）が付与されており、rawContent導入による新たなReDoSリスクは発生しない。

3. **ポーリング頻度**: `response-poller.ts`のポーリング間隔（2秒）および最大ポーリング時間（5分）は変更なし。rawContent処理による追加のCPU負荷は`truncateRawContent()`の`split()`/`slice()`程度であり、無視できるレベル。

4. **WebSocket帯域**: rawContent（最大5000文字）のブロードキャストは、プロンプトメッセージの発生頻度が低い（ユーザーの操作に依存）ため、帯域への影響は最小限。

---

## 4. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| XSS | stripAnsi()残留制御文字によるUI表示の乱れ | Low | Low | P2 |
| 情報漏洩 | rawContentに含まれるファイルパス等のクライアント露出 | Low | Medium | P3 |
| SQLインジェクション | rawContent経由のDB書き込み | None | None | N/A |
| DoS | rawContentサイズによるメモリ・DB膨張 | Low | Low | P3 |
| ReDoS | truncateRawContent内の処理 | None | None | N/A |

---

## 5. 指摘事項

### 5.1 Must Fix (1件)

#### MF-S4-001: stripAnsi()の既知の制限によるANSIエスケープコード残留リスクの分析不足

**重要度**: medium
**カテゴリ**: XSS対策

設計方針書Section 8.2では「rawContentはstripAnsi()済みのため追加のサニタイズ不要」と記載しているが、`cli-patterns.ts`のstripAnsi()にはSEC-002として8-bit CSI (0x9B)、DEC private modes等の既知の制限が文書化されている。rawContentはcleanContent（質問テキストのみ数行）と比べて大幅に大きなデータ量（最大5000文字）を扱うため、残留制御文字が含まれる確率が相対的に高くなる。

**推奨対応**:

設計書Section 8.2に以下を追記すること:

1. `stripAnsi()`のSEC-002制限を明示的に参照し、rawContentに残留する可能性のある制御文字の種類を列挙する
2. C1制御文字（0x80-0x9F）がHTML出力に含まれた場合の影響分析を記載する（結論：Reactのテキストノードレンダリングでは制御文字はDOMテキストとして扱われ、HTMLタグ生成には至らないため、XSSリスクは発生しない。ただし表示の乱れは起こりうる）
3. 将来的にstrip-ansiパッケージの採用を検討する旨を記載する

### 5.2 Should Fix (3件)

#### SF-S4-001: rawContent経由のログインジェクション・情報漏洩リスクの評価不足

**重要度**: low
**カテゴリ**: 情報漏洩

rawContentはtmux出力の末尾最大200行/5000文字を保持し、ファイルパス・ユーザー名等の情報が含まれうる。これがDBに保存されWebSocket経由でクライアントにブロードキャストされる。設計書にはこのリスクの分析が不足している。

**推奨対応**:

設計書Section 8に「8.4 情報漏洩リスク」を新設し、以下を記載:
- rawContentに含まれうる情報の列挙
- 既存のcleanContentでも同様のリスクが存在すること
- ローカル開発ツールとしてのリスク限定性
- log-export-sanitizer.tsによるエクスポート時のサニタイズ

#### SF-S4-002: truncateRawContent関数のセキュリティアノテーション欠如

**重要度**: low
**カテゴリ**: Denial of Service

既存コードベースではRegExp使用箇所にReDoSセーフのアノテーション（S4-001）が付与されているが、`truncateRawContent()`にはセキュリティ関連のアノテーションがない。

**推奨対応**:

Section 4.1.5のtruncateRawContent定義に「ReDoSリスク: 正規表現を使用しないため該当なし」のコメントを追加。

#### SF-S4-003: getDisplayContent関数の文字列比較におけるエッジケース

**重要度**: low
**カテゴリ**: 入力バリデーション

`getDisplayContent()`の`content.trim() === question.trim()`による等価比較は、stripAnsi残留文字やUnicode正規化差異がある場合に、目視上同一でも一致しないケースが生じうる。

**推奨対応**:

Section 4.3.1に注記を追加し、比較不一致の可能性と、その場合はcontent全体が表示される（情報欠落なし）ことを明記。

### 5.3 Consider (3件)

#### C-S4-001: rawContentの将来的なサニタイズパイプライン拡張

現在はプレーンテキスト表示のみのため対策不要だが、将来的にReactMarkdownでのレンダリング等を検討する場合は追加サニタイズが必要。PromptMessage.tsxのJSDocに「dangerouslySetInnerHTMLやReactMarkdownを使用しない方針」を明示することを検討。

#### C-S4-002: WebSocket broadcast経由でのrawContent送信サイズ

rawContent（最大5000文字）のWebSocket送信は1クライアントあたり問題ないが、マルチユーザー対応を将来検討する場合に再評価が必要。

#### C-S4-003: DB contentカラムのサイズ上限制約

SQLiteのTEXT型に制約がないため、将来的にtruncateロジックにバグが混入した場合に備えて`CHECK(length(content) <= 10000)`等のDB制約追加を検討。現時点ではtruncateRawContentのユニットテストが防御ラインとして十分。

---

## 6. 既存セキュリティ対策の評価

| 対策 | 該当コード | 評価 |
|------|-----------|------|
| パラメタライズドクエリ | `db.ts` L475-493 `createMessage()` | 適切: `db.prepare()` + `?`プレースホルダ |
| ANSIエスケープ除去 | `cli-patterns.ts` L248 `stripAnsi()` | 概ね適切: SEC-002の既知制限あり |
| サイズ制限 | 設計書 Section 3.2 `truncateRawContent()` | 適切: 200行/5000文字 |
| Reactエスケープ | 設計書 Section 4.3.2 JSXテキストノード | 適切: `dangerouslySetInnerHTML`不使用 |
| ログインジェクション対策 | `prompt-detector.ts` L538, L551 SEC-003 | 適切: エラーメッセージにユーザー入力を含めない |

---

## 7. 総合評価

設計方針書のセキュリティ設計は、ローカル開発ツールとしての脅威モデルに照らして適切なレベルである。XSS対策（React エスケープ + dangerouslySetInnerHTML不使用）、SQLインジェクション対策（パラメタライズドクエリ）、DoS対策（truncateRawContent）の3つの主要な防御ラインが確立されている。

Must Fix 1件（stripAnsi制限の分析追記）は設計書の文書化レベルの問題であり、実装レベルでの脆弱性ではない。Reactのテキストノードレンダリングが最終防御ラインとして機能するため、実際のXSSリスクは発生しない。

**承認条件**: MF-S4-001（stripAnsi制限の分析追記）を設計書に反映すること。

---

*Generated by architecture-review-agent (Stage 4: Security Review)*
*Date: 2026-02-11*
