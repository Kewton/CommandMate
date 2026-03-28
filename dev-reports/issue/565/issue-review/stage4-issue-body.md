## 概要

Copilot CLI（`gh copilot`）はalternate screenモード（全画面TUI）で動作するため、既存のClaude/Codex向けのレスポンス保存・ポーリング・メッセージ送信ロジックが正しく機能しない。OpenCodeも同様のTUIだが、専用の対策（TuiAccumulator、isFullScreenTui等）が実装済み。Copilotにはこれらの対策が未適用、または適用しても構造的に合わない部分がある。

## 事象

> **注**: 事象1と事象2は共通のalternate screen問題に起因する。事象3は暫定対策（isFullScreenTui適用、ポーリング継続）の副作用として発生している。

### 事象1: レスポンス本文が保存されない

- Copilotの応答内容（分析結果など）がMessage Historyに保存されない
- 保存されるのはステータスバー文字列のみ（`shortcuts↵────↵ shift+tab switch mode`、約170文字）
- ユーザーはMessage Historyから過去のCopilotの応答を確認できない

### 事象2: ターミナル表示で過去履歴がスクロールできない

- Copilotタブのターミナル表示エリアに表示されるのはtmuxペインの表示行数分のみ（デフォルト端末サイズでは約24行）
- alternate screenモードではスクロールバックバッファが無効化されるため、`tmux capture-pane -S -10000` でも表示中の行のみ取得可能
- 上にスクロールしても過去のやり取りは見られない
- Claude CLIでは数千行のスクロールバックが確認可能

### 事象3: promptメッセージの大量重複保存

- パーミッションプロンプト（「Do you want to run this command?」等）が検出されると、ポーリングサイクル（2秒）ごとに同一内容のpromptメッセージがDBに保存され続ける
- 実測: 同一内容（984文字）のpromptメッセージが約30件連続保存（10:27:06〜10:28:13）
- **因果関係**: 暫定対策で`isFullScreenTui`を適用しline-based重複検出をスキップしたこと、およびプロンプト検出時にポーリングを継続する対策の副作用として発生

### 事象4: 長いメッセージが送信できない

- テキストがtmuxペインの表示幅（約78文字）を超えると、Copilot CLIが自動的にマルチラインモード（`ctrl+s run command`）に切り替わる
- `sendKeys`がテキストとC-mを一括送信（`tmux send-keys -t session 'text' C-m`）するため、C-mが改行として扱われ送信不能になる
- 短いメッセージ（表示幅以内）は正常に送信可能

## 根本原因

### alternate screenモード

Copilot CLI（`gh copilot`）はink/React CLIベースの全画面TUIで、tmuxのalternate screen（`#{alternate_on}=1`）で動作する。

- alternate screenモードではスクロールバックバッファが無効化されるため、`tmux capture-pane` で取得できるのは表示中の行のみ（tmuxペインの表示行数に依存。デフォルト端末サイズでは約24行）
- レスポンス表示中のテキストは次の画面描画で上書きされ失われる

### response-pollerの不適合

1. **レスポンス抽出**: `extractResponse`はキャプチャ内容からレスポンスを抽出するが、Copilotではキャプチャ時点で既にプロンプト画面に戻っており、レスポンス本文が含まれない
2. **TuiAccumulator**: OpenCode用の`extractTuiContentLines`（`OPENCODE_SKIP_PATTERNS`、box-drawing除去等）はCopilotのTUI構造に合わない
3. **重複検出**: `isFullScreenTui=true`でline-based重複検出をスキップ（response-poller.ts L642, L650, L749の3箇所）すると、同じプロンプトが毎ポーリングで保存される
4. **ポーリング停止**: プロンプト検出時に`stopPolling`を呼ぶと後続レスポンスが保存されない。呼ばないと重複が発生する

### メッセージ送信の不適合

- Issue #559で`CopilotTool.sendMessage()`の`waitForPrompt`がブロッキング問題を起こしたため、send API / terminal APIでは`sendKeys()`を直接使用
- `sendKeys`はテキストとC-mを同一tmuxコマンドで送信するが、マルチラインモードではC-mが改行になる

## 暫定対策（本Issue内で実施済み / コミット7c68640eで適用済み）

| 対策 | ファイル | 効果 | 副作用 |
|------|----------|------|--------|
| テキストとEnterの分離送信（200ms遅延） | `send/route.ts`, `terminal/route.ts` | 事象4を解消 | API応答が200ms遅延 |
| `disableAutoFollow`のCopilot適用 | `WorktreeDetailRefactored.tsx` | TUI上部メニュー表示改善 | なし |
| `isFullScreenTui`のCopilot適用 | `response-poller.ts` | line-based重複検出スキップ | 事象3の重複を悪化させる |
| TuiAccumulator初期化のCopilot適用 | `response-poller.ts` | 蓄積開始 | Copilot用パターンマッチ未実装のため効果限定 |
| プロンプト時ポーリング継続 | `response-poller.ts` | 後続レスポンス保存の可能性 | 事象3の重複を直接引き起こす |

## 本対応で必要なこと

### 必須

1. **Copilot用TuiAccumulator対応**
   - Copilot TUIのコンテンツ抽出パターン定義
   - 実装アプローチ: `extractCopilotContentLines`関数を新設（既存のcli-toolsのStrategyパターンとの整合性を考慮し、OpenCode専用の`extractTuiContentLines`と並列に配置）、またはcli-tools層にStrategy統合
   - Copilot用normalize関数、スキップパターン（TUI装飾・ステータスバー・ショートカットキー表示・セパレーター除去）、完了検出パターンの3点を定義
   - `cleanCopilotResponse`の本実装（現状はCOPILOT_SKIP_PATTERNS=PastedTextPatternのみのplaceholder実装。`src/lib/response-cleaner.ts` L159-176）
   - **呼び出し分岐の設計**: `accumulateTuiContent()`のシグネチャに`cliToolId`パラメータを追加するか、pollerKeyのフォーマット（`'worktreeId:cliToolId'`）からcliToolIdを抽出する方式で、`extractTuiContentLines`（OpenCode用）と`extractCopilotContentLines`（Copilot用）を呼び分ける。response-poller.ts L605-608 の`accumulateTuiContent`呼び出し箇所にcliToolIdを渡す改修が必要。推奨: `accumulateTuiContent(key, lines, cliToolId)`のシグネチャ拡張方式

2. **TUI向けプロンプト重複防止**
   - alternate screenでのpromptメッセージ重複を防ぐロジック
   - 実装方針: promptメッセージ保存前にDB上の直近メッセージとcontentのSHA-256ハッシュを比較
   - **パフォーマンス考慮**: インメモリキャッシュ（直近保存したpromptのハッシュを`Map<pollerKey, string>`で保持）との比較を第一段階とし、キャッシュミス時のみDBクエリする2層方式を採用する。これにより2秒毎のポーリングでDBクエリが毎回発生することを回避する
   - 適用箇所: `response-poller.ts`の`checkForResponse`内、`isFullScreenTui`時にcontent hashで重複チェック（既存のlineCountベース重複チェック L642, L650, L749 とは独立したレイヤー）
   - 対象スコープ: messageType='prompt'を優先的に対応。responseメッセージへの拡張は効果を見て判断
   - chat-db.tsへのハッシュカラム追加は不要（インメモリキャッシュ + 必要時のみDB直近レコード参照で対応）

3. **メッセージ送信のマルチラインモード対策の安定化**
   - 現在の200ms遅延の妥当性を検証
   - 検証基準: 100文字/200文字/500文字のメッセージで送信成功率を計測
   - **遅延値の定数化と統一**: `config/`配下に`COPILOT_SEND_ENTER_DELAY_MS`定数を定義し、以下の3箇所全てで参照する
     - `src/app/api/worktrees/[id]/send/route.ts` L262
     - `src/app/api/worktrees/[id]/terminal/route.ts` L88
     - `src/lib/cli-tools/copilot.ts` L278（sendMessage内の200ms遅延）
   - **メッセージ送信パスの統一方針**: 現在`copilot.ts`の`sendMessage()`と`send/route.ts`のインライン実装で二重実装になっている。本対応では以下の方針とする:
     - (A) `copilot.ts`の`sendMessage()`を修正し、ブロッキング問題（Issue #559）を解消した上で`send/route.ts`から呼び出す方式を優先検討
     - (B) (A)が困難な場合は`send/route.ts`のインライン実装を正とし、`copilot.ts`の`sendMessage()`は非推奨化
     - 長期的にはcli-tools層のStrategyパターンに統合すべき
   - 失敗時のリトライ戦略を検討
   - `sendKeys`第2引数のfalse（C-m付加なし）と`sendSpecialKeys`の組み合わせが正しいことを確認するテストケース策定

### 推奨

4. **Copilotレスポンス完了検出**
   - Copilot固有の完了パターン（プロンプト復帰）の定義
   - **検討事項**: 現在CopilotはextractResponse() L372で`isCodexOrGeminiComplete`の条件（`hasPrompt && !isThinking`）に含まれている。alternate screenモードではプロンプト復帰時にレスポンス本文が既にキャプチャに含まれない可能性があるため、以下を判断する:
     - (A) 現在のプロンプトベース完了検出（hasPrompt && !isThinking）で十分か
     - (B) OpenCodeのように独自完了検出（`isCopilotComplete`）が必要か
   - 判断基準: TuiAccumulatorからの蓄積コンテンツが完了検出時に正しくレスポンスとして取得できるかで判断する。蓄積コンテンツが利用可能であれば(A)で十分、利用できない場合は(B)を検討

5. **暫定対策の整理**: 副作用のある変更（isFullScreenTui、ポーリング継続）の見直し

## 受け入れ条件

- [ ] Copilotの応答内容がMessage Historyに正しく保存されること（ステータスバー文字列ではなく本文が保存される）
- [ ] 同一promptメッセージの重複保存が発生しないこと（content hashベースで一意化）
- [ ] 78文字超のメッセージがCopilotに正常に送信されること（100文字/200文字/500文字で検証）
- [ ] 暫定対策の副作用（isFullScreenTuiによる重複悪化）が解消されていること
- [ ] `cleanCopilotResponse`がCopilot固有のTUI装飾を正しく除去すること
- [ ] Copilot用TuiAccumulatorパターン（スキップ・完了検出）が定義され、コンテンツ抽出が機能すること
- [ ] 200ms遅延値が定数化されconfigに配置され、3箇所（send/route.ts, terminal/route.ts, copilot.ts）で統一参照されていること
- [ ] Copilot用TuiAccumulatorのユニットテストが追加されていること（extractCopilotContentLines、Copilot用skip/normalizeパターンのテスト）
- [ ] 既存のOpenCode用TuiAccumulatorテスト（response-poller-tui-accumulator.test.ts）が壊れないこと
- [ ] cleanCopilotResponseのユニットテストが追加されていること（TUI装飾除去、ステータスバーフィルタリング、正常レスポンス保持の検証）
- [ ] isFullScreenTuiの共通フラグとCopilot固有ロジック（cliToolId === 'copilot'）の分岐が適切に設計されていること

## 再現手順

1. Copilotセッションを起動（anvil-develop等）
2. 長いメッセージを送信（例: 「AnvilのIssue185の根本原因を分析して下さい Issueに追記して下さい」）
3. Copilotが処理完了後、Message Historyを確認
4. -> レスポンス本文が保存されず、ステータスバー文字列のみ表示される
5. パーミッションプロンプトが出た場合、DBに同一promptが大量重複保存される

## 関連

- Issue #559: Copilot sendMessage waitForPrompt ブロッキング問題
- Issue #545: Copilot CLI統合
- Issue #379: OpenCode TUI対応（disableAutoFollow、TuiAccumulator）
- Issue #473: 選択リストナビゲーション

## 影響範囲

- `src/lib/polling/response-poller.ts` -- Copilot向けポーリング・レスポンス抽出（isFullScreenTui: L637, 重複チェック: L642/L650/L749）
  - **注意**: `isFullScreenTui`は共通フラグとして維持するが、Copilot固有のロジック（プロンプト重複防止、ポーリング継続）は`cliToolId === 'copilot'`で個別に分岐する。L684のプロンプト検出時ポーリング停止抑制はCopilot固有の理由（alternate screenでの後続レスポンス保存）によるものであり、OpenCodeへの影響がないことを確認する
- `src/lib/tui-accumulator.ts` -- Copilot用コンテンツ蓄積パターン（現在OpenCode専用）。accumulateTuiContent()にcliToolId分岐を追加
- `src/lib/response-extractor.ts` -- Copilot完了検出の追加候補。extractResponse() L518のプロンプト検出スキップ条件にcopilotを含めるかの判断が必要（現在はopencode のみスキップ。L344の早期プロンプト検出でカバーされているが、L344がfalseの場合にL518に到達する可能性あり）
- `src/lib/detection/cli-patterns.ts` -- Copilot用パターン定義（COPILOT_SKIP_PATTERNS: L285-287、現在placeholder）
- `src/lib/response-cleaner.ts` -- cleanCopilotResponse（L159-176、現在placeholder実装）
- `src/app/api/worktrees/[id]/send/route.ts` -- メッセージ送信（Copilot用200ms遅延: L254-264）。copilot.ts sendMessage()との二重実装の統一
- `src/app/api/worktrees/[id]/terminal/route.ts` -- ターミナルコマンド送信（Copilot用200ms遅延: L83-89）
- `src/lib/cli-tools/copilot.ts` -- sendMessage()内の200ms遅延（L278）。遅延定数の統一参照
- `src/components/worktree/WorktreeDetailRefactored.tsx` -- ターミナル表示
- `tests/unit/lib/response-poller-tui-accumulator.test.ts` -- 既存OpenCode用テスト。Copilot対応時に更新が必要（TEST_KEY='test-worktree:opencode'固定）

---

<details>
<summary>レビュー履歴</summary>

### Stage 1: 通常レビュー（2026-03-28）

- 9件の指摘（must_fix: 1, should_fix: 5, nice_to_have: 3）
- Stage 2で全件反映済み
- 主な改善: 受け入れ条件の追加、実装方針の具体化、事象間の因果関係明記、暫定対策のコミット状態反映、24行制限の記述修正

### Stage 3: 影響範囲レビュー（2026-03-28）

- 10件の指摘（must_fix: 2, should_fix: 5, nice_to_have: 3）
- Stage 4で全件反映済み
- 主な改善:
  - F3-001 [must_fix] accumulateTuiContent()のcliToolId分岐設計を必須1に追加
  - F3-002 [must_fix] isFullScreenTuiとCopilot固有ロジックの分岐方針を影響範囲に追加
  - F3-003 [should_fix] 200ms遅延の3箇所統一（copilot.ts含む）を必須3に追加
  - F3-004 [should_fix] TuiAccumulator/cleanCopilotResponseのテスト要件を受け入れ条件に追加
  - F3-005 [should_fix] Copilot完了検出の判断基準を推奨4に追加
  - F3-006 [should_fix] 重複防止のインメモリキャッシュ2層方式を必須2に追加
  - F3-007 [should_fix] メッセージ送信パスの統一方針（A/B案）を必須3に追加
  - F3-008 [nice_to_have] cleanCopilotResponseのテスト要件を受け入れ条件に追加
  - F3-009 [nice_to_have] extractResponse L518のcopilotスキップ条件検討を影響範囲に追加
  - F3-010 [nice_to_have] CLAUDE.md更新は本Issue完了後に対応（Issue本文への記載は省略）

</details>
