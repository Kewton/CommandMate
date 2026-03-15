# Issue #499 仮説検証レポート

## 検証日時
- 2026-03-15

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | stripBoxDrawingの二重呼び出し | Confirmed | L244でstrip済み→L318で再度呼び出し |
| 2 | Thinking検出時のポーリング間隔が通常と同じ | Confirmed | L407でscheduleNextPollに間隔指定なし→2s |
| 3 | stopPattern未設定時も5000行キャプチャ | Confirmed | L243で常に5000行、検出は末尾50行のみ使用 |
| 4 | split('\n')が3回以上実行 | Confirmed | L405, prompt-detector L189, L747で各回split |
| 5 | 連続エラーでの自動停止なし | Confirmed | backoffのみ（max 60s）、停止ロジックなし |
| 6 | キャッシュTTL=ポーリング間隔(2s) | Confirmed | tmux-capture-cache L39=2000, auto-yes-state L311=2000 |
| 7 | validatePollingContextの冗長チェック | Partially Confirmed | getAutoYesStateで期限切れ処理済み→再チェックは冗長 |

## 詳細検証

### 仮説 1: stripBoxDrawingの二重呼び出し

**Issue内の記述**: `captureAndCleanOutput`で既にstrip済みの出力に対し、`detectAndRespondToPrompt`内で再度`stripBoxDrawing`を呼んでいる

**検証手順**:
1. `src/lib/auto-yes-poller.ts` L244: `return stripBoxDrawing(stripAnsi(output));` - captureAndCleanOutputでstrip済み
2. `src/lib/auto-yes-poller.ts` L318: `detectPrompt(stripBoxDrawing(cleanOutput), ...)` - 再度strip呼び出し
3. L417でpollAutoYesからdetectAndRespondToPromptにcleanOutputとして渡される

**判定**: Confirmed

**根拠**: captureAndCleanOutput()の戻り値は既にstripBoxDrawing適用済み。detectAndRespondToPrompt()内で再度stripBoxDrawingを呼ぶのは完全に冗長。

**Issueへの影響**: 記載通り。毎ポーリングで5000行分の不要な文字列処理が発生。

---

### 仮説 2: Thinking検出時のポーリング間隔延長

**Issue内の記述**: Thinking検出時も通常間隔(2秒)で再スケジュールされる

**検証手順**:
1. `src/lib/auto-yes-poller.ts` L403-409: Thinking検出時のコード確認
2. L407: `scheduleNextPoll(worktreeId, cliToolId)` - 間隔オーバーライドなし
3. `scheduleNextPoll` L450: `pollerState.currentInterval`（デフォルト2000ms）を使用

**判定**: Confirmed

**根拠**: scheduleNextPollに間隔パラメータを渡していないため、デフォルトの2秒間隔でポーリング継続。

**Issueへの影響**: 記載通り。Thinking中は応答不要なため、長い間隔が適切。

---

### 仮説 3: stopPattern未設定時のキャプチャ行数削減

**Issue内の記述**: 毎回5000行キャプチャしているが、プロンプト検出は末尾50行程度しか使用しない

**検証手順**:
1. `src/lib/auto-yes-poller.ts` L243: `captureSessionOutput(worktreeId, cliToolId, 5000)`
2. `src/lib/detection/prompt-detector.ts` L757-759: `scanStart = Math.max(0, effectiveEnd - 50)` - 末尾50行のみスキャン

**判定**: Confirmed

**根拠**: 5000行キャプチャは存在するが、プロンプト検出には末尾50行のみ使用。stopPatternがない場合は大部分が無駄。

**Issueへの影響**: 記載通り。stopPattern未設定時は200行程度で十分。

---

### 仮説 4: split('\n')結果の再利用

**Issue内の記述**: 毎ポーリングで同一出力に対してsplit('\n')が3回以上実行される

**検証手順**:
1. `src/lib/auto-yes-poller.ts` L405: `cleanOutput.split('\n').slice(-THINKING_CHECK_LINE_COUNT)`
2. `src/lib/detection/prompt-detector.ts` L189: `const lines = output.split('\n')` (detectPrompt内)
3. `src/lib/detection/prompt-detector.ts` L747: `const lines = output.split('\n')` (detectMultipleChoicePrompt内)

**判定**: Confirmed

**根拠**: 同一のcleanOutput文字列に対して少なくとも3回split('\n')が実行される。5000行出力での配列生成・GC負荷が無駄。

**Issueへの影響**: 記載通り。

---

### 仮説 5: 連続エラー上限での自動停止

**Issue内の記述**: セッションが壊れていても有効期限(最大8時間)まで60秒毎にポーリングし続ける

**検証手順**:
1. `src/lib/auto-yes-poller.ts` L165: `calculateBackoffInterval(pollerState.consecutiveErrors)`
2. `src/lib/auto-yes-state.ts` L293-303: exponential backoff max 60000ms
3. `src/lib/auto-yes-state.ts` L331: `MAX_CONSECUTIVE_ERRORS = 5` (backoffトリガー閾値)

**判定**: Confirmed

**根拠**: exponential backoffは実装済みだが、自動停止ロジックは存在しない。壊れたセッションは最大8時間、60秒間隔でポーリング継続。

**Issueへの影響**: 記載通り。閾値（例: 20回）での自動停止が必要。

---

### 仮説 6: キャッシュTTLとポーリング間隔のずらし

**Issue内の記述**: キャッシュTTL(2秒)とポーリング間隔(2秒)が同一のため、キャッシュが効いていない

**検証手順**:
1. `src/lib/tmux/tmux-capture-cache.ts` L39: `CACHE_TTL_MS = 2000`
2. `src/lib/auto-yes-state.ts` L311: `POLLING_INTERVAL_MS = 2000`

**判定**: Confirmed

**根拠**: TTLとポーリング間隔が同値のため、次のポーリング時点でキャッシュはほぼ期限切れ。singleflightパターンでの同時リクエスト重複排除は機能するが、Auto-Yesと通常APIキャプチャの同時アクセスではキャッシュヒットしない。

**Issueへの影響**: 記載通り。TTLを3秒に変更すれば改善。

---

### 仮説 7: validatePollingContextの冗長チェック除去

**Issue内の記述**: `getAutoYesState`内で既に`isAutoYesExpired`チェック→disabled化が行われるため再チェックは冗長

**検証手順**:
1. `src/lib/auto-yes-poller.ts` L217: `if (!autoYesState?.enabled || isAutoYesExpired(autoYesState))`
2. `src/lib/auto-yes-state.ts` L90-92: `getAutoYesState()`内で`isAutoYesExpired()`→`disableAutoYes()`実行

**判定**: Partially Confirmed

**根拠**: `getAutoYesState()`は期限切れ時に自動でdisableするため、直後の`isAutoYesExpired()`チェックは冗長。ただし`!autoYesState?.enabled`チェックで既にカバーされるため害はないが、コード明確さの観点で除去は妥当。

**Issueへの影響**: 記載通り。微小な処理削減とコード明確さ向上。

---

## Stage 1レビューへの申し送り事項

- 全7仮説がConfirmed/Partially Confirmedであり、Rejectedな仮説はない
- 仮説2「Thinking検出時のポーリング間隔」の記述は正確だが、具体的な推奨間隔(5-10秒)の根拠がIssueに記載されていない点は補足が望ましい
- 仮説6のキャッシュTTL変更(2s→3s)の影響範囲を確認すべき（通常APIキャプチャへの影響）
