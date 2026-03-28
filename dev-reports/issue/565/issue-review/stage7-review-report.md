# Issue #565 レビューレポート（Stage 7）

**レビュー日**: 2026-03-28
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 1 |

## 前回指摘（Stage 3）の反映状況

Stage 3の全10件の指摘は、Stage 4で全て反映済みであることを確認した。

| ID | 重要度 | ステータス |
|----|--------|-----------|
| F3-001 | must_fix | resolved -- accumulateTuiContent()のcliToolIdシグネチャ拡張方式が必須1に明記 |
| F3-002 | must_fix | resolved -- isFullScreenTui共通フラグとcliToolId === 'copilot'個別分岐の方針が影響範囲に明記 |
| F3-003 | should_fix | resolved -- 3箇所の遅延値統一（copilot.tsの2段階遅延含む）が必須3に明記 |
| F3-004 | should_fix | resolved -- TuiAccumulator/cleanCopilotResponseのテスト要件が受け入れ条件に追加 |
| F3-005 | should_fix | resolved -- Copilot完了検出の判断基準（A/B案）が推奨4に明記 |
| F3-006 | should_fix | resolved -- インメモリキャッシュ2層方式が必須2に明記 |
| F3-007 | should_fix | resolved -- メッセージ送信パス統一方針（A/B案）が必須3に明記 |
| F3-008 | nice_to_have | resolved -- cleanCopilotResponseのテスト要件が受け入れ条件に追加 |
| F3-009 | nice_to_have | resolved -- extractResponse L518のcopilotスキップ条件が影響範囲に追記 |
| F3-010 | nice_to_have | resolved -- CLAUDE.md更新はIssue完了後対応（レビュー履歴に記録） |

---

## Should Fix（推奨対応）

### F7-001: resolveExtractionStartIndex()にCopilot用ブランチが存在しない

**カテゴリ**: 波及効果
**場所**: 影響範囲セクション

**問題**:
`src/lib/response-extractor.ts` の `resolveExtractionStartIndex()` は5分岐の決定木を持ち、OpenCodeにはBranch 2a（`cliToolId === 'opencode'`）で専用処理が実装されている。しかしCopilotに対する分岐は存在しない。

Copilotもalternate screenモードで動作するため、OpenCodeと同様に `lastCapturedLine` が固定バッファサイズに制約される。Copilotの場合、Branch 1（bufferWasReset）またはBranch 4（通常ケース）に到達するが、Branch 1の `findRecentUserPromptIndex(40)` は一般プロンプトパターン（`/^[>|>]\s+\S/`）で探索する。CopilotのTUI画面にこのパターンが存在するかは未検証であり、`startIndex=0` にフォールバックする可能性が高い。

影響範囲セクションに `resolveExtractionStartIndex()` のCopilot対応が記載されていない。

**推奨対応**:
影響範囲に `src/lib/response-extractor.ts` の `resolveExtractionStartIndex()` へのCopilot分岐追加の検討を追記する。Copilotのalternate screen動作に応じた専用処理（OpenCodeのBranch 2a相当）が必要かどうかを実装時に検証する方針を記載する。

---

### F7-002: extractResponse内のCopilotレスポンス抽出ループに終了条件が未定義

**カテゴリ**: 互換性
**場所**: 必須1 / 影響範囲セクション

**問題**:
`extractResponse()` L390-421のレスポンス抽出ループでは、以下のようにツール固有の終了条件が定義されている:

- **codex**: `^> ` パターンでbreak（L395-398）
- **gemini**: シェルプロンプトパターンでbreak（L401-404）
- **opencode**: プロンプト/ステータスバーパターンでbreak（L407-412）

しかし **copilot** には終了条件がない。Copilotは `isCodexOrGeminiComplete`（L372）で完了判定されるためループに到達するが、ループ内でCopilotのTUI要素（ステータスバー「shortcuts...」、セパレーター等）がそのまま `response` に含まれてしまう。

`cleanCopilotResponse()` で後からフィルタリングする方針であれば動作上は問題ないが、この設計判断がIssueに明記されていない。

**推奨対応**:
必須1または影響範囲に、extractResponseのレスポンス抽出ループでCopilot固有の終了条件を追加するか、`cleanCopilotResponse()` でのフィルタリングに委ねるかの設計判断を明記する。

---

## Nice to Have（あれば良い）

### F7-003: メッセージ送信パス統一後のterminal/route.tsとの整合性確認

**カテゴリ**: テスト
**場所**: 必須3

**問題**:
必須3でメッセージ送信パスの統一方針（A: copilot.ts sendMessage()修正 / B: send/route.tsインライン実装を正）が記載されているが、どちらを選択しても `terminal/route.ts`（L83-89）のCopilot分岐との整合性を保つ必要がある。`terminal/route.ts` は `send/route.ts` とほぼ同一のインライン実装を使用しており、統一時に漏れる可能性がある。

**推奨対応**:
受け入れ条件または必須3に、送信パス統一後に `terminal/route.ts` のCopilotコマンド送信経路にも同じ方式が適用されていることの確認を追加する。

---

## 参照ファイル

### コード
- `src/lib/response-extractor.ts`: resolveExtractionStartIndex()の5分岐決定木にCopilot用ブランチが不在
- `src/lib/polling/response-poller.ts`: extractResponse() L390-421のレスポンス抽出ループにCopilot終了条件が未定義
- `src/lib/cli-tools/copilot.ts`: sendMessage()統一方針の対象
- `src/app/api/worktrees/[id]/terminal/route.ts`: L83-89のCopilot分岐、送信パス統一時の整合性確認対象

---

## 総合評価

Stage 3で指摘した10件の影響範囲の懸念は全てIssue本文に適切に反映されている。Issue全体として、Copilot TUI対応に必要な変更箇所、設計判断、テスト要件が網羅的に記載されており、実装可能な状態にある。

今回新たに検出した3件の指摘は、いずれもmust_fixではなく、実装時に対応可能な粒度の問題である。特にF7-001（resolveExtractionStartIndex）とF7-002（抽出ループ終了条件）は、Copilotのalternate screen動作がOpenCodeと構造的に類似しているにもかかわらず、extractResponse周辺でCopilot固有の分岐が不足している点を指摘しており、実装着手前に設計方針を固めておくことが望ましい。
