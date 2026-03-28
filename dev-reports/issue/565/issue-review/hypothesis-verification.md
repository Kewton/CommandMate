# Issue #565 仮説検証レポート

## 検証日時
- 2026-03-28

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | Copilot CLIはalternate screenで24行制限 | Partially Confirmed | tmux historyLimit=50000設定あるが、alternate screen時は無効化される |
| 2 | response-pollerのextractResponseがCopilotで機能しない | Partially Confirmed | プロンプト検出は実装済みだが、capture内容がTUI画面のみの場合機能しない |
| 3 | TuiAccumulatorのOpenCode用パターンがCopilotに合わない | Confirmed | OPENCODE_SKIP_PATTERNS固有、Copilot用未実装 |
| 4 | isFullScreenTui=trueで重複検出スキップ→重複発生 | Confirmed | lineCount重複検出が3箇所スキップされる |
| 5 | sendKeysのマルチラインモード問題 | Confirmed | テキストとC-mが同一コマンドで送信される構造を確認 |
| 6 | 暫定対策: テキストとEnter分離送信（200ms遅延） | Confirmed | send/route.ts:254-264, terminal/route.ts:83-89 |
| 7 | disableAutoFollowのCopilot適用 | Confirmed | WorktreeDetailRefactored.tsx:458 |
| 8 | isFullScreenTuiのCopilot適用 | Confirmed | response-poller.ts:637 |

## 詳細検証

### 仮説 1: Copilot CLIはalternate screenモードで動作し、tmux capture-paneで24行しか取得できない

**Issue内の記述**: 「tmux capture-pane -S -10000 でも現在画面の約24行しか取得できない」「スクロールバックバッファにデータが蓄積されない」

**検証手順**:
1. `src/lib/tmux/tmux.ts:130-173` - createSessionでhistoryLimit: 50000設定を確認
2. `src/lib/polling/response-poller.ts:637` - isFullScreenTuiにCopilotが含まれている

**判定**: Partially Confirmed

**根拠**: tmux自体はhistoryLimit=50000を設定しているが、alternate screenモードではスクロールバックバッファが無効化されるのはtmuxの仕様。コード内に明示的な24行制限はないが、alternate screenモードの動作としては正しい。

**Issueへの影響**: 根本原因の説明は概ね正しいが、「24行」は画面サイズ依存であり固定値ではない点を補足すべき。

### 仮説 2: response-pollerのextractResponseがCopilotで機能しない

**Issue内の記述**: 「extractResponseはキャプチャ内容からレスポンスを抽出するが、Copilotではキャプチャ時点で既にプロンプト画面に戻っており、レスポンス本文が含まれない」

**検証手順**:
1. `src/lib/polling/response-poller.ts:344-358` - Copilotは早期プロンプト検出対象
2. `src/lib/detection/cli-patterns.ts:248` - COPILOT_PROMPT_PATTERN定義済み

**判定**: Partially Confirmed

**根拠**: extractResponseはプロンプト検出で完了判定するが、Copilot TUIではcapture時点で応答内容が画面から消えている可能性が高い。プロンプト検出自体は実装されている。

### 仮説 3: TuiAccumulatorのOpenCode用パターンがCopilotに合わない

**Issue内の記述**: 「extractTuiContentLinesのOPENCODE_SKIP_PATTERNS、box-drawing除去等はCopilotのTUI構造に合わない」

**検証手順**:
1. `src/lib/tui-accumulator.ts:52-57` - normalizeOpenCodeLineでOpenCode固有ボーダー除去
2. `src/lib/tui-accumulator.ts:68-86` - OPENCODE_SKIP_PATTERNSのみ使用
3. `src/lib/detection/cli-patterns.ts:231-239` - OpenCode固有パターン
4. `src/lib/detection/cli-patterns.ts:285-287` - COPILOT_SKIP_PATTERNSはPastedTextPatternのみ

**判定**: Confirmed

**根拠**: TuiAccumulatorはOpenCode専用実装。Copilot用のスキップパターン・正規化関数が未実装。cleanCopilotResponseもplaceholder実装のまま。

### 仮説 4: isFullScreenTui=trueで重複検出スキップ→重複発生

**Issue内の記述**: 「isFullScreenTui=trueでline-based重複検出をスキップすると、同じプロンプトが毎ポーリングで保存される」

**検証手順**:
1. `src/lib/polling/response-poller.ts:637` - isFullScreenTui定義
2. `src/lib/polling/response-poller.ts:642, 650, 749` - 3箇所のlineCount重複検出がスキップ

**判定**: Confirmed

**根拠**: isFullScreenTui=trueの場合、lineCountベースの重複検出が完全にスキップされる。OpenCodeではTuiAccumulatorが適切に機能するため問題ないが、CopilotではTuiAccumulatorが未対応のため重複が発生する。

### 仮説 5: sendKeysのマルチラインモード問題

**Issue内の記述**: 「sendKeysがテキストとC-mを一括送信するため、C-mが改行として扱われ送信不能」

**検証手順**:
1. `src/lib/tmux/tmux.ts:211-228` - sendKeys関数の実装確認

**判定**: Confirmed

**根拠**: sendKeys関数は`['send-keys', '-t', sessionName, keys, 'C-m']`で一括送信。Copilotのマルチラインモードではこれが問題となる。

### 仮説 6-8: 暫定対策の実装

**判定**: すべてConfirmed

**根拠**:
- 仮説6: send/route.ts:254-264, terminal/route.ts:83-89で分離送信実装済み
- 仮説7: WorktreeDetailRefactored.tsx:458でdisableAutoFollow適用済み
- 仮説8: response-poller.ts:637でisFullScreenTui適用済み

---

## Stage 1レビューへの申し送り事項

1. **COPILOT_SKIP_PATTERNSの不完全性**: 現在PastedTextPatternのみ。Copilot固有のTUI要素フィルタリングが未実装
2. **isFullScreenTui適用の妥当性**: OpenCodeとCopilotの技術仕様差異を考慮すべき
3. **重複検出ロジックの欠落**: content hashベースの重複防止が未実装
4. **cleanCopilotResponseがplaceholder実装のまま**
