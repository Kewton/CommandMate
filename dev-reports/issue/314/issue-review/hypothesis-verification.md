# Issue #314 仮説検証レポート

## 検証日時
- 2026-02-19

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | Auto-Yesは時間ベース（1h/3h/8h）でのみ自動停止する | Confirmed | `AutoYesState`に`stopPattern`なし、`isAutoYesExpired()`のみで停止判定 |
| 2 | `pollAutoYes()`処理順序: thinking後・プロンプト検出前にStop条件追加が可能 | Confirmed | 既存コードのステップ順序が一致（line 382-396） |
| 3 | `AutoYesConfirmDialog.onConfirm`は`(duration: AutoYesDuration) => void`型 | Confirmed | line 27で確認 |
| 4 | `AutoYesToggle.onToggle`は`(enabled: boolean, duration?: AutoYesDuration) => Promise<void>`型 | Confirmed | line 24で確認 |
| 5 | APIルートが`stopPattern`を現在受け付けていない | Confirmed | `route.ts`は`enabled/duration/cliToolId`のみ処理 |
| 6 | `auto-yes-resolver.ts`は変更不要 | Confirmed | ロジックはプロンプト検出後の応答のみ、Stop条件と無関係 |
| 7 | `src/config/auto-yes-config.ts`は変更不要 | Partially Confirmed | 期間設定のみ管理。ReDoS対策定数（最大長等）の追加が必要になる可能性あり |
| 8 | i18nファイル変更が影響範囲テーブルに未記載 | Rejected | `locales/ja/autoYes.json`と`locales/en/autoYes.json`が存在するが、変更対象ファイル表に記載なし |

---

## 詳細検証

### 仮説 1: Auto-Yesは時間ベース（1h/3h/8h）でのみ自動停止する

**Issue内の記述**: 「現在のAuto-Yesは時間ベースの期限（1h/3h/8h）でのみ自動停止する」

**検証手順**:
1. `src/config/auto-yes-config.ts` を確認 → `ALLOWED_DURATIONS = [3600000, 10800000, 28800000]`（1h/3h/8h）
2. `src/lib/auto-yes-manager.ts` の`AutoYesState`インターフェース（line 22-29）確認 → `enabled`, `enabledAt`, `expiresAt`のみ
3. `getAutoYesState()`（line 191-206）確認 → `isAutoYesExpired()`（時刻比較のみ）で停止判定

**判定**: Confirmed

**根拠**: `AutoYesState`に`stopPattern`フィールドは存在せず、停止条件は`expiresAt`（時刻）のみ。

---

### 仮説 2: `pollAutoYes()`の処理順序と挿入ポイント

**Issue内の記述**: 「thinking状態チェック後、プロンプト検出前にStop条件チェックを追加（ステップ4）」

**検証手順**:
1. `src/lib/auto-yes-manager.ts` の`pollAutoYes()`（line 344-453）を確認
2. 現在の処理順序:
   - line 358: `captureSessionOutput()`（出力キャプチャ）
   - line 361: `stripAnsi(output)`（ANSIコード除去）
   - line 381: `recentLines`の生成
   - line 382-385: `detectThinking()`チェック（thinking時はreturn）
   - line 387-396: `detectPrompt()`によるプロンプト検出
   - line 399-403: 重複プロンプトチェック
   - line 405-411: `resolveAutoAnswer()`で自動応答
   - line 421-428: `sendPromptAnswer()`で送信

**判定**: Confirmed

**根拠**: 挿入ポイント（line 385と387の間）が技術的に正確であり、`cleanOutput`はstripAnsi済みで再利用可能。

---

### 仮説 3: `AutoYesConfirmDialog.onConfirm`の型

**Issue内の記述**: 「`AutoYesConfirmDialog`の`onConfirm`コールバックにstopPatternを追加」

**検証手順**:
1. `src/components/worktree/AutoYesConfirmDialog.tsx` line 27を確認
2. 現在の型: `onConfirm: (duration: AutoYesDuration) => void`

**判定**: Confirmed

**根拠**: `stopPattern`は存在しない。修正時は`onConfirm: (duration: AutoYesDuration, stopPattern?: string) => void`へ変更が必要。

---

### 仮説 4: `AutoYesToggle.onToggle`の型

**Issue内の記述**: 「`AutoYesToggle`の`onToggle`コールバックにstopPatternを追加」

**検証手順**:
1. `src/components/worktree/AutoYesToggle.tsx` line 24を確認
2. 現在の型: `onToggle: (enabled: boolean, duration?: AutoYesDuration) => Promise<void>`
3. `handleConfirm`（line 88-92）で`onToggle(true, duration)`を呼び出し

**判定**: Confirmed

**根拠**: `stopPattern`は存在しない。修正時は`onToggle: (enabled: boolean, duration?: AutoYesDuration, stopPattern?: string) => Promise<void>`へ変更が必要。

---

### 仮説 5: APIルートの現状

**Issue内の記述**: 「`/api/worktrees/[id]/auto-yes` APIルートでstopPatternの受け渡しを追加」

**検証手順**:
1. `src/app/api/worktrees/[id]/auto-yes/route.ts`のPOSTハンドラーを確認
2. 現在受け付けるパラメータ: `enabled`, `duration`, `cliToolId`
3. `stopPattern`の受け渡し・バリデーションロジックなし

**判定**: Confirmed

**根拠**: `stopPattern`処理は未実装。追加時はSEC-SF-002（バリデーション）と同様のパターンで正規表現妥当性検証が必要。

---

### 仮説 6: `auto-yes-resolver.ts`変更不要

**Issue内の記述**: 「`auto-yes-resolver.ts` — 変更なし（自動応答ロジックは変わらない）」

**検証手順**:
1. `src/lib/auto-yes-resolver.ts`を確認
2. `resolveAutoAnswer()`は`yes_no`→'y'、`multiple_choice`→選択肢番号のみを処理

**判定**: Confirmed

**根拠**: Stop条件チェックはプロンプト検出前に行われるため、`resolveAutoAnswer()`は呼ばれない経路（停止時）となる。ロジック自体への変更は不要。

---

### 仮説 7: `auto-yes-config.ts`変更不要

**Issue内の記述**: 「`src/config/auto-yes-config.ts` — 設定定数（変更不要）」

**検証手順**:
1. `src/config/auto-yes-config.ts`を確認
2. 現在の定数: `ALLOWED_DURATIONS`, `DEFAULT_AUTO_YES_DURATION`, `DURATION_LABELS`, `isAllowedDuration()`, `formatTimeRemaining()`

**判定**: Partially Confirmed

**根拠**: duration設定のみ管理。ただし、Issue本文「セキュリティ考慮」に記載された「stopPatternの最大長制限（例: 500文字）」の定数を`auto-yes-config.ts`に追加するか、`auto-yes-manager.ts`内にローカル定数として定義するかの判断が必要。CLAUDE.mdの設計パターン（定数の一元管理）に従えば`auto-yes-config.ts`への追加が適切。

---

### 仮説 8: i18nファイルの影響範囲テーブル記載漏れ

**Issue内の記述**: 「i18n対応（ja/en: ラベル、プレースホルダー、通知メッセージ）」（実装タスクに記載） / 「変更対象ファイル」テーブルには未記載

**検証手順**:
1. i18nファイルの存在確認: `locales/ja/autoYes.json`, `locales/en/autoYes.json`が存在
2. 現在のキー: `enableTitle`, `featureDescription`, `yesNoAutoResponse`, `duration`, `durations.*`, `riskWarning`, `agreeAndEnable`など
3. Stop条件用のキー（`stopCondition`, `stopConditionPlaceholder`, `stoppedByPattern`等）は未存在

**判定**: Rejected（記載漏れ）

**根拠**: `locales/ja/autoYes.json`と`locales/en/autoYes.json`の両方が存在し、Stop条件UIのテキスト追加が必要。「変更対象ファイル」テーブルへの追記が必要。

**Issueへの影響**: 変更対象ファイル表に以下を追加:
```
| `locales/ja/autoYes.json` | Stop条件ラベル・プレースホルダー・通知メッセージ（ja） |
| `locales/en/autoYes.json` | Stop条件ラベル・プレースホルダー・通知メッセージ（en） |
```

---

## Stage 1レビューへの申し送り事項

1. **「変更対象ファイル」テーブルにi18nファイル2件が未記載**: `locales/ja/autoYes.json`と`locales/en/autoYes.json`の追加が必要。Stage 1でMust Fixとして指摘すること。

2. **`auto-yes-config.ts`の変更要否の明確化**: ReDoS対策の最大長定数（`MAX_STOP_PATTERN_LENGTH`等）の配置先（`auto-yes-config.ts` vs `auto-yes-manager.ts`）をIssueで明示すること。設計一貫性のためShould Fixとして指摘すること。

3. **`useAutoYes.ts`の変更有無が「変更対象ファイル」テーブルに未記載**: `stopPattern`がサーバーサイドのみで管理されるか、クライアント側フックにも影響するか（AutoYesToggle→useAutoYes→APIの伝達経路）を明確にする必要がある。

4. **`WorktreeDetailRefactored.tsx`の伝達経路の明示化**: `stopPattern`がAutoYesToggle→WorktreeDetailRefactored→useAutoYes.ts→APIという伝達経路をたどる可能性があるが、Issueでは「stopPatternの受け渡し追加」のみ。具体的なstate管理の記述が不足している可能性がある。
