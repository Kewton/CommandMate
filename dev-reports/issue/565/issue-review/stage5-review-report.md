# Issue #565 レビューレポート（Stage 5）

**レビュー日**: 2026-03-28
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |
| **合計** | **3** |

## 前回（Stage 1）指摘事項の反映状況

全9件の指摘が適切に反映されていることを確認した。

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| F1-001 | 24行制限はtmuxペインサイズ依存 | **対応済み** |
| F1-002 | 受け入れ条件が未定義 | **対応済み** - 11項目のチェックリストが追加された |
| F1-003 | content hashベース重複防止の設計未記載 | **対応済み** - 2層方式含む具体的設計が記載された |
| F1-004 | cleanCopilotResponseのplaceholder状態が未記載 | **対応済み** - 必須1のスコープに明記された |
| F1-005 | 200ms遅延の検証基準が不明確 | **対応済み** - 検証基準と定数化方針が追加された |
| F1-006 | 暫定対策の「未コミット」記述が不正確 | **対応済み** - コミットハッシュで更新された |
| F1-007 | TuiAccumulatorのCopilot適用方針が不明確 | **対応済み** - 実装アプローチと呼び出し分岐設計が記載された |
| F1-008 | ラベル未設定 | **対応済み** - bugラベル付与済み |
| F1-009 | 事象間の依存関係が未明記 | **対応済み** - 因果関係の注記が追加された |

## 総合評価

Issue #565は4段階のレビュー・反映サイクルを経て、非常に高品質なIssueに仕上がっている。

**優れている点**:

- 事象・根本原因・暫定対策・本対応が明確に分離されている
- 受け入れ条件が具体的かつ検証可能な11項目で定義されている
- 実装方針が具体的（cliToolIdパラメータ追加、2層キャッシュ方式、定数化箇所の特定等）
- 影響範囲が行番号レベルで特定されている
- 事象間の因果関係が明記されている
- レビュー履歴が折りたたみセクションで整理されている
- 関連Issueへのリンクが充実している

**must_fix該当なし**: Stage 1で指摘された唯一のmust_fix（受け入れ条件の欠如）は完全に解消されている。

---

## Should Fix（推奨対応）

### F5-001: 影響範囲セクションのresponse-extractor.tsの行番号参照が不正確

**カテゴリ**: 正確性
**場所**: 影響範囲セクション

**問題**:
影響範囲に「`src/lib/response-extractor.ts` -- extractResponse() L518のプロンプト検出スキップ条件にcopilotを含めるか」と記載されているが、`extractResponse()`関数は `src/lib/polling/response-poller.ts` L260に定義されており、L518もresponse-poller.ts内の行番号である。`response-extractor.ts`は`isOpenCodeComplete()`と`resolveExtractionStartIndex()`のみを含む116行のファイルであり、L518は存在しない。

**証拠**:
- `src/lib/polling/response-poller.ts` L260: `function extractResponse(` -- 実際の関数定義
- `src/lib/polling/response-poller.ts` L518: `if (cliToolId !== 'opencode')` -- 実際のスキップ条件
- `src/lib/response-extractor.ts`: 116行のファイルで、`isOpenCodeComplete()`と`resolveExtractionStartIndex()`のみ

**推奨対応**:
影響範囲の該当エントリを以下に修正:
- `src/lib/response-extractor.ts` -- isOpenCodeComplete()のCopilot版（isCopilotComplete）追加候補
- 既存の `src/lib/polling/response-poller.ts` エントリにL518のプロンプト検出スキップ条件の記述を統合

---

## Nice to Have（あれば良い）

### F5-002: copilot.ts sendMessage()の遅延が2段階構成である点が未記載

**カテゴリ**: 正確性
**場所**: 本対応で必要なこと > 必須 > 3

**問題**:
Issueでは「copilot.ts L278（sendMessage内の200ms遅延）」と1箇所のみ言及しているが、実際のsendMessage()にはL272の100ms遅延（テキスト入力後の待機）とL278の200ms遅延（Enter送信後の処理待ち）の2段階がある。また、copilot.tsでは`sendSpecialKey('C-m')`を使用しているのに対し、send/route.tsでは`sendSpecialKeys(['Enter'])`を使用しており、キーコードも異なる。

**推奨対応**:
定数化スコープの説明に2段階遅延の存在を補足し、どちらを定数化対象とするかを明確にする。

---

### F5-003: isFullScreenTui使用箇所の行番号リストが不完全

**カテゴリ**: 整合性
**場所**: 影響範囲

**問題**:
影響範囲の括弧内に「isFullScreenTui: L637, 重複チェック: L642/L650/L749」と記載されているが、L684（プロンプト検出時ポーリング停止分岐）が括弧内のリストに含まれていない。本文の注記でL684には言及しているが、一見すると行番号が網羅されていないように見える。

**推奨対応**:
行番号リストを整理し、L684を含める。

---

## 参照ファイル

### コード
- `src/lib/polling/response-poller.ts`: extractResponse()関数定義（L260）、L518プロンプト検出スキップ、isFullScreenTui全使用箇所
- `src/lib/response-extractor.ts`: isOpenCodeComplete()とresolveExtractionStartIndex()のみ。extractResponse()は含まない
- `src/lib/cli-tools/copilot.ts`: sendMessage()内の2段階遅延（L272: 100ms、L278: 200ms）
