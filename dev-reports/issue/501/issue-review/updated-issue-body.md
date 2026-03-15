## 概要

Auto-Yes有効時にサーバーとクライアントが同じプロンプトに二重応答し、サイドバーのステータスがorange(waiting)のまま更新されない。worktreeをクリックするとポーラーが再作成され、追跡状態がリセットされることで問題が悪化する。

## 背景

Auto-Yesは2つの経路でプロンプトに応答する:
1. **サーバー側**: `auto-yes-poller.ts` が2秒間隔でtmux captureしプロンプト検出→応答
2. **クライアント側**: `useAutoYes` フックがcurrent-output APIのポーリング結果からプロンプト検出→応答

サーバー側応答後にクライアント側が重複送信しないよう `lastServerResponseTimestamp` による3秒ウィンドウ（`DUPLICATE_PREVENTION_WINDOW_MS = 3000`、`useAutoYes.ts` L36で定義）が設計されている（Issue #138）が、実装が不完全で機能していない。

## 根本原因

### 問題A: `lastServerResponseTimestamp` がクライアントに伝播していない

- API (`current-output/route.ts` L139) は `lastServerResponseTimestamp` を返している
- `CurrentOutputResponse` 型 (`WorktreeDetailRefactored.tsx` L116-132) にこのフィールドが**未定義**
- `fetchCurrentOutput()` (L352-398) で値を**保存していない**
- `useAutoYes()` (L961-967) に値を**渡していない**
- 結果: クライアント側の重複送信防止（3秒ウィンドウ）が**完全に無効化**

### 問題B: `startAutoYesPolling()` が毎回ポーラーを破棄・再作成する

- `auto-yes-poller.ts` の `startAutoYesPolling()` 関数内: 既存ポーラーがあっても `stopAutoYesPolling()` で完全破棄（L486-494）
- 新規ポーラー作成時に `consecutiveErrors=0`, `lastAnsweredPromptKey=null`, `stopCheckBaselineLength=-1` にリセット（L496-506）
- 同一 `cliToolId` での再呼び出しでも全追跡状態が失われる

### 問題C: サーバー応答後のステータス検出タイムラグ

- サーバーがプロンプトに応答送信後、tmuxバッファの更新には時間がかかる
- その間 `detectSessionStatus()` は依然としてプロンプトを検出 → `waiting`(orange)を返す
- サイドバーのステータスがorangeのまま更新されない
- 注: `detectSessionStatus()` は既に第3引数として `lastOutputTimestamp?: Date` パラメータを受け付けており（L155）、時間ベースヒューリスティック（`STALE_OUTPUT_THRESHOLD_MS = 5000ms`、L404-417）も実装済みだが、呼び出し側で活用されていない

### 連鎖の流れ

```
サーバーがプロンプトに応答
  ↓
lastServerResponseTimestamp がクライアントに届かない (問題A)
  ↓
クライアントuseAutoYesが同じプロンプトに再応答 (問題B相当)
  ↓
tmuxに重複入力 → セッションが不安定に
  ↓
ステータスがwaitingのまま → サイドバーがorange (問題C)
  ↓
ユーザーがworktreeをクリック → ポーラー再作成 (問題B)
  ↓
追跡状態リセット → 更に重複応答しやすくなる
```

## 対策一覧

### 対策1: `lastServerResponseTimestamp` をクライアントに伝播する（問題A修正）

- **ファイル**: `src/components/worktree/WorktreeDetailRefactored.tsx`
- **変更内容**:
  1. `CurrentOutputResponse` 型に `lastServerResponseTimestamp?: number | null` を追加
  2. `fetchCurrentOutput()` 内で `lastServerResponseTimestamp` をstateに保存
  3. `useAutoYes()` の呼び出しに `lastServerResponseTimestamp` を渡す
- **効果**: クライアント側の3秒重複防止ウィンドウが有効化され、サーバーが応答済みならクライアントはスキップする

### 対策2: `startAutoYesPolling()` で同一cliToolIdなら再作成しない（問題B修正）

- **ファイル**: `src/lib/auto-yes-poller.ts`
- **変更内容**:
  1. 既存ポーラーの `cliToolId` が一致する場合は再作成せず、既存ポーラーをそのまま継続
  2. `cliToolId` が変わった場合のみ停止→再作成
  3. `startAutoYesPolling()` の戻り値に `already_running` 等のreasonを追加
- **呼び出し側の影響**: `auto-yes/route.ts` L170で `result.started` を使って `pollingStarted` を判定しているため、`started: false` かつ `reason: 'already_running'` の場合を正常系として扱うロジック変更が必要（例: `started: true` を返すか、reason による分岐を追加）
- **効果**: ポーラーの追跡状態（エラーカウント、応答済みプロンプトキー、ベースライン等）が保持される

### 対策3: 既存の `lastOutputTimestamp` パラメータを活用したステータス検出改善（問題C修正）

- **ファイル**: `src/app/api/worktrees/[id]/current-output/route.ts`, `src/lib/session/worktree-status-helper.ts`
- **変更内容**:
  1. `detectSessionStatus()` は既に第3引数として `lastOutputTimestamp?: Date` パラメータを受け付けており（`status-detector.ts` L155）、時間ベースヒューリスティック（`STALE_OUTPUT_THRESHOLD_MS = 5000ms`、L404-417）も実装済み
  2. `current-output/route.ts` L86 の `detectSessionStatus()` 呼び出し時に、`lastServerResponseTimestamp` を `Date` に変換して第3引数として渡す
  3. `worktree-status-helper.ts` L91 の `detectSessionStatus()` 呼び出し時にも同様に `lastOutputTimestamp` を渡す
  4. `status-detector.ts` 自体の変更は不要（既存機構を活用）
- **効果**: サーバー応答後、`STALE_OUTPUT_THRESHOLD_MS`（5秒）以内であればステータス検出がプロンプト残留を無視し、サイドバーのorange表示が応答後すぐに解消される

## 受入条件

- [ ] `lastServerResponseTimestamp` が `CurrentOutputResponse` 型に含まれている
- [ ] `fetchCurrentOutput()` で `lastServerResponseTimestamp` がstateに保存されている
- [ ] `useAutoYes()` に `lastServerResponseTimestamp` が渡されている
- [ ] サーバー応答後3秒以内にクライアントが同一プロンプトに応答しないことをテストで確認
- [ ] 同一 `cliToolId` で `startAutoYesPolling()` を再呼び出ししてもポーラーが再作成されないことをテストで確認
- [ ] `cliToolId` が変わった場合はポーラーが正しく再作成されることをテストで確認
- [ ] `already_running` の場合に `auto-yes/route.ts` が正常応答を返すことをテストで確認
- [ ] `current-output/route.ts` で `detectSessionStatus()` に `lastOutputTimestamp` が渡されていることを確認
- [ ] `worktree-status-helper.ts` で `detectSessionStatus()` に `lastOutputTimestamp` が渡されていることを確認
- [ ] サーバー応答後のステータス検出で既存の時間ベースヒューリスティックが機能し、`waiting`がすぐに解消されることを確認
- [ ] 既存のAuto-Yes関連テストが全てパスする
- [ ] `npm run test:unit` パス
- [ ] `npm run lint` パス
- [ ] `npx tsc --noEmit` パス

## 関連ファイル

### 直接変更対象
- `src/components/worktree/WorktreeDetailRefactored.tsx` - 対策1（型追加・state保存・useAutoYes引数追加）
- `src/lib/auto-yes-poller.ts` - 対策2（既存ポーラー再利用ロジック）
- `src/app/api/worktrees/[id]/current-output/route.ts` - 対策3（`detectSessionStatus()` に `lastOutputTimestamp` を渡す）
- `src/lib/session/worktree-status-helper.ts` - 対策3（`detectSessionStatus()` に `lastOutputTimestamp` を渡す）
- `src/app/api/worktrees/[id]/auto-yes/route.ts` - 対策2（`already_running` 時のハンドリング追加）

### 間接影響ファイル
- `src/hooks/useAutoYes.ts` - 対策1により `lastServerResponseTimestamp` が正しく渡されるようになる（フック自体の変更は不要）
- `src/lib/detection/status-detector.ts` - 対策3で活用する既存の `lastOutputTimestamp` パラメータと時間ベースヒューリスティックを持つ（変更不要）

## レビュー履歴

| 段階 | 日付 | 種別 | 主な指摘 |
|------|------|------|----------|
| Stage 1 | 2026-03-16 | 通常レビュー | 行番号ズレ修正(F1-001)、対策3の既存パラメータ活用(F1-002)、変更対象ファイル明確化(F1-003)、API側影響記載(F1-004)、定数値明記(F1-005)、行番号微修正(F1-006) |

## 関連Issue

- Issue #138: Auto-Yesサーバーサイドポーリング導入（`lastServerResponseTimestamp` の設計元）
- Issue #499: Auto-Yesポーリング性能改善（本Issue発見のきっかけ）
