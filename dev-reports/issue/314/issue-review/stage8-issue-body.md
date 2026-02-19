> **Note**: このIssueは 2026-02-19 にStage 7影響範囲レビュー（2回目）結果を反映して更新されました。
> 詳細: dev-reports/issue/314/issue-review/

## 概要

Auto-Yesモードに「Stop条件」機能を追加する。ユーザーが正規表現パターンを指定し、ターミナル出力がそのパターンにマッチした場合にAuto-Yesを自動停止する。これにより、意図しない操作（例: ファイル削除確認、危険なコマンド実行）への自動応答を防止できる。

## 背景・課題

- 現在のAuto-Yesは時間ベースの期限（1h/3h/8h）でのみ自動停止する
- ターミナル出力内容に応じた条件付き停止ができないため、危険な操作への自動応答リスクがある
- 例: `rm -rf`、`DROP TABLE`、`force push` などの危険な操作がCLIから提案された場合にも自動でYesしてしまう
- ユーザーが安心してAuto-Yesを利用するためには、出力内容ベースのセーフガードが必要

## 提案する解決策

### UX

Auto-Yes有効化時の確認ダイアログ（`AutoYesConfirmDialog`）に**Stop条件入力フィールド**を追加する。

1. ユーザーがAuto-Yesトグルをクリック
2. 確認ダイアログが表示される（既存）
3. **時間の選択**（既存: 1h/3h/8h）
4. **Stop条件の入力**（新規: テキストフィールド、正規表現、任意入力）
   - プレースホルダー例: `rm -rf|DROP TABLE|force push`
   - 空欄の場合はStop条件なし（従来通りの動作）
   - **リアルタイムバリデーション**: 入力中に `new RegExp(pattern)` で構文検証し、無効な場合はインラインエラーメッセージを入力フィールド下に表示。「同意して有効化」ボタンを無効化する <!-- S1-F010 -->
5. 「同意して有効化」ボタンで確定

> **将来の検討事項**: デフォルトプリセット（`rm -rf|DROP TABLE|force push`）をワンクリックで適用するボタンは初期バージョンではスコープ外とし、将来のエンハンスメントとして検討する <!-- S1-F012 -->

### サーバーサイド

`auto-yes-manager.ts`の`pollAutoYes()`内で、プロンプト検出前にターミナル出力をStop条件パターンと照合する。マッチした場合はAuto-Yesを自動停止する。

#### Stop条件マッチ時の処理フロー <!-- S1-F005 -->

`pollAutoYes()` 内でStop条件がマッチした場合の具体的な処理フロー:

1. `AutoYesState` に `stopReason: 'stop_pattern_matched'` を設定
2. `setAutoYesEnabled(worktreeId, false)` でAuto-Yesを無効化（**disableパスではスプレッド演算子で既存stateを展開し、`stopReason`/`stopPattern`を保持する**） <!-- S5-F001 -->
3. `stopAutoYesPolling(worktreeId)` でポーラーを停止
4. console.warnで停止理由とマッチしたパターンをログ出力

> **設計根拠 (S5-F001)**: `setAutoYesEnabled()` のdisableパスは現在リテラルオブジェクト `{ enabled: false, enabledAt, expiresAt }` で構築しているため、`stopReason`/`stopPattern`フィールドが消失する。disableパスを `{ ...existing, enabled: false }` に変更することで、pollAutoYes()で事前に設定された`stopReason`と`stopPattern`が保持される。

#### setAutoYesEnabled() の disable パス修正 <!-- S5-F001, S7-F001 -->

```typescript
// auto-yes-manager.ts setAutoYesEnabled() 内 disable パスの修正イメージ
// Before: リテラルオブジェクト構築（stopReason/stopPattern消失）
// autoYesStates.set(worktreeId, { enabled: false, enabledAt: existing?.enabledAt ?? 0, expiresAt: existing?.expiresAt ?? 0 });
// After: existing未定義時のフォールバック付きスプレッド演算子
const existing = autoYesStates.get(worktreeId);
autoYesStates.set(worktreeId, {
  enabled: false,
  enabledAt: existing?.enabledAt ?? 0,
  expiresAt: existing?.expiresAt ?? 0,
  ...(existing && { stopReason: existing.stopReason, stopPattern: existing.stopPattern }),
});
```

> **注記 (S7-F001)**: `existing`が`undefined`の場合（事前にsetされていないworktreeIdに対して`setAutoYesEnabled(false)`を呼んだ場合）に`{ ...undefined }`は安全だがフィールドが存在しなくなるため、`enabledAt`/`expiresAt`のフォールバック（`?? 0`）を明示的に保持する。`stopReason`/`stopPattern`はexisting存在時のみ条件付きスプレッドで展開し、existing未定義時はundefined（自然な初期状態）とする。既存テスト `should disable auto-yes even when no prior state exists` (auto-yes-manager.test.ts line 110-116) の `enabledAt: 0, expiresAt: 0` 期待値との互換性を維持する。

#### getAutoYesState()内の期限切れ無効化時のstopPattern保持 <!-- S3-F002 -->

`getAutoYesState()` 内で期限切れによりAuto-Yesを無効化する場合（スプレッド演算子で既存stateを展開している箇所）、`stopPattern` フィールドは自然に保持される。期限切れ無効化時には `stopReason` を `'expired'` に設定する。

```typescript
// auto-yes-manager.ts getAutoYesState() 内 期限切れ処理のイメージ
autoYesStates.set(worktreeId, {
  ...state,           // stopPatternはスプレッド演算子で保持される
  enabled: false,
  stopReason: 'expired',
});
```

#### stopPatternの照合対象範囲 <!-- S1-F009, S3-F009 -->

- `captureSessionOutput()` で取得した直近の出力（最大5000文字分）の `cleanOutput` 全体を照合対象とする
- **初期実装は全文照合を採用する**。5000文字程度のRegExpマッチは数マイクロ秒で完了するため、パフォーマンス上の問題はない <!-- S3-F009 -->
- 差分照合方式（前回キャプチャとの差分のみを照合対象とする `lastCheckedOutput` フィールドをAutoYesPollerStateに保持）は将来の最適化として検討する <!-- S3-F009 -->

### クライアント通知メカニズム <!-- S1-F002 -->

Stop条件によるAuto-Yes停止時にクライアントへ通知するための設計:

1. **AutoYesStateインターフェース拡張**: `stopReason?: 'expired' | 'stop_pattern_matched'` フィールドを追加。**`stopReason`がundefinedの場合は手動OFF（manual）または初期状態を意味する**（`'manual'`を明示的に設定する経路は設けない） <!-- S5-F003 -->
2. **current-output APIレスポンス変更**: `autoYes` オブジェクトに `stopReason` フィールドを含める（`{ enabled, expiresAt, stopReason }` 形式）。**`stopReason`はenabledの値に関わらず`autoYesState?.stopReason`をそのまま返却する**（enabled=false時にこそ必要な情報であり、クライアント側のWorktreeDetailRefactored.tsxでenabled遷移時のみstopReasonをチェックするため、サーバー側でフィルタリングする必要はない） <!-- S7-F004 -->
3. **クライアント側通知**: `WorktreeDetailRefactored.tsx` の autoYes ポーリングで `stopReason === 'stop_pattern_matched'` を検出した場合にトースト通知を表示（「Stop条件にマッチしたためAuto-Yesを停止しました」）。**トースト重複表示防止**: `useRef`で前回のautoYes.enabled状態を保持し、`enabled: true -> false` への遷移時のみstopReasonをチェックしてトースト表示する（ポーリングごとの重複表示を防止）。**`fetchCurrentOutput()`のuseCallback依存配列に`showToast`を追加する**（showToastはuseToastフックの戻り値でありstable referenceのため、レンダリング頻度への影響は最小限） <!-- S5-F004, S7-F006 -->
4. `stopReason` はAuto-Yesが再度有効化された際にクリアされる（`setAutoYesEnabled(true)` でリテラルオブジェクト構築によりstopReason/stopPatternが自然にundefinedとなる）

> **設計根拠 (S5-F003)**: `stopReason`の型を `'expired' | 'stop_pattern_matched' | 'manual'` から `'expired' | 'stop_pattern_matched'` に変更。手動OFF時に `stopReason='manual'` を設定する経路（route.ts POSTハンドラー or setAutoYesEnabled()パラメータ）を新設するコストに対して得られる利益が少ないため、undefinedを手動OFF/初期状態として暗黙的に扱う方針を採用する。

> **設計根拠 (S5-F004)**: `stopReason='stop_pattern_matched'`はAuto-Yesが再有効化されるまでautoYesレスポンスに含まれ続けるため、ポーリングごとにトーストが表示されてしまう問題を防止する。`useRef<boolean>`で`prevAutoYesEnabled`を保持し、`enabled`が`true`から`false`に遷移したタイミングでのみトーストを表示する設計とする。

> **実装注記 (S7-F006)**: `fetchCurrentOutput()`内でshowToastを使用するため、useCallbackの依存配列に`showToast`を追加する必要がある。`showToast`はuseToast()フックの戻り値であり通常stable referenceのため、追加による実際のレンダリング頻度への影響は最小限。代替案として、トースト表示ロジックをfetchCurrentOutput()内ではなくautoYesEnabledのuseEffect監視で実装する方法もあり、実装時にどちらのアプローチを採用するか判断する。

### 判定タイミング

ポーリングの各サイクル（`pollAutoYes()`）内で以下の順序で処理:

> **注記**: 以下の番号はIssue内の参照用であり、コード内のコメント番号とは対応しない <!-- S5-F006 -->

1. ターミナル出力をキャプチャ（既存）
2. ANSIコード除去（既存）
3. thinking状態チェック（既存）
4. **Stop条件チェック（新規）** -- `cleanOutput`（全文照合）をStop条件パターンと照合。マッチ時はstopReasonを設定してAuto-Yesを停止し、ポーリングを終了
5. プロンプト検出（既存）
6. 自動応答（既存）

### stopPatternのデータフロー <!-- S1-F006 -->

クライアントからサーバーへのstopPattern伝達経路:

1. **AutoYesConfirmDialog**: `useState<string>('')` でstopPattern入力を管理。`onConfirm(duration, stopPattern)` で親コンポーネントに渡す
2. **AutoYesToggle**: `handleConfirm` で `onToggle(true, duration, stopPattern)` を呼び出し
3. **WorktreeDetailRefactored**: `handleAutoYesToggle(enabled, duration?, stopPattern?)` でfetch bodyに `stopPattern` を含めてAPIに送信。**Desktop/Mobile両方のAutoYesToggleが同一の`handleAutoYesToggle`を参照するため、両レイアウトでstopPattern伝達が保証される** <!-- S3-F007 -->
4. **auto-yes/route.ts**: `body.stopPattern` を正規表現バリデーション後に `setAutoYesEnabled()` に渡す。**空文字列の正規化**: `body.stopPattern` が空文字列(`''`)またはundefinedの場合はstopPatternなし（undefined）として統一的に扱う（`const stopPattern = body.stopPattern?.trim() || undefined;`）。**`setAutoYesEnabled()`へのstopPattern渡しはenabled=true時のみ**: `setAutoYesEnabled(params.id, body.enabled, body.enabled ? duration : undefined, body.enabled ? stopPattern : undefined)`（enabled=false時はスプレッド演算子で既存stateが保持されるためstopPatternパラメータは不要） <!-- S5-F007, S7-F005 -->

## 実装タスク

- [ ] `AutoYesState`インターフェースに`stopPattern?: string`フィールドと`stopReason?: 'expired' | 'stop_pattern_matched'`フィールドを追加（`auto-yes-manager.ts`）。**`stopReason`がundefinedの場合は手動OFF/初期状態を意味する** <!-- S1-F002, S1-F005, S5-F003 -->
- [ ] `setAutoYesEnabled()`にstopPatternパラメータを追加。**disableパスをexisting未定義時のフォールバック付きスプレッド演算子に変更し、stopReason/stopPatternを保持する**（コードイメージ参照）。**enabledAt/expiresAtのフォールバック（`?? 0`）を明示的に保持し、stopReason/stopPatternはexisting存在時のみ条件付きスプレッドで展開する** <!-- S5-F001, S7-F001 -->
- [ ] `getAutoYesState()` 内の期限切れ無効化時に `stopPattern` をスプレッド演算子で保持し、`stopReason` に `'expired'` を設定する <!-- S3-F002 -->
- [ ] `pollAutoYes()`内にStop条件チェックロジックを追加（thinking状態チェック後、プロンプト検出前。マッチ時: stopReason設定 -> 無効化 -> ポーラー停止 -> ログ出力） <!-- S1-F005 -->
- [ ] `auto-yes-config.ts`にStop条件関連定数を追加（`MAX_STOP_PATTERN_LENGTH = 500`等） <!-- S1-F007 -->
- [ ] `AutoYesConfirmDialog`にStop条件入力フィールドを追加（テキストフィールド、プレースホルダー付き、リアルタイムバリデーション付き） <!-- S1-F010 -->
- [ ] `AutoYesConfirmDialog`の`onConfirm`コールバックにstopPatternを追加
- [ ] `AutoYesToggle`の`onToggle`コールバックにstopPatternを追加
- [ ] `/api/worktrees/[id]/auto-yes` APIルートでstopPatternの受け渡し・サーバーサイドバリデーション追加（Defense in Depth）。**空文字列の正規化処理追加** (`body.stopPattern?.trim() || undefined`)。**`setAutoYesEnabled()`へのstopPattern渡しはenabled=true時のみ**: `setAutoYesEnabled(params.id, body.enabled, body.enabled ? duration : undefined, body.enabled ? stopPattern : undefined)` <!-- S5-F007, S7-F005 -->
- [ ] `current-output/route.ts`のautoYesレスポンスに`stopReason`フィールドを追加。**`stopReason`はenabledの値に関わらず`autoYesState?.stopReason`をそのまま返却する** <!-- S1-F002, S1-F008, S7-F004 -->
- [ ] `CurrentOutputResponse.autoYes` 型に `stopReason` フィールドを追加（`{ enabled: boolean; expiresAt: number | null; stopReason?: 'expired' | 'stop_pattern_matched' }`）（`WorktreeDetailRefactored.tsx`内） <!-- S3-F003, S5-F003 -->
- [ ] 正規表現バリデーション -- クライアント: AutoYesConfirmDialog内で`new RegExp(pattern)` try-catchによるリアルタイム検証、無効時はボタン無効化+インラインエラー表示。サーバー: route.tsで**パターン長制限（`MAX_STOP_PATTERN_LENGTH`）+ `new RegExp(pattern)` try-catchによる構文検証**を実施（400レスポンス） <!-- S1-F010, S5-F005 -->
- [ ] Stop条件でAuto-Yesが停止した際のログ出力とUI通知（`stopReason === 'stop_pattern_matched'` 時のトースト表示）。**トースト重複防止**: `useRef`で前回のautoYes.enabled状態を保持し、`enabled: true -> false`遷移時のみstopReasonチェック+トースト表示。**`fetchCurrentOutput()`のuseCallback依存配列に`showToast`を追加する**（または代替案としてautoYesEnabledのuseEffect監視で実装） <!-- S5-F004, S7-F006 -->
- [ ] i18n対応（`locales/ja/autoYes.json`, `locales/en/autoYes.json`: ラベル、プレースホルダー、停止通知メッセージ、バリデーションエラーメッセージ） <!-- S1-F001, S1-F010 -->
- [ ] ユニットテスト追加:
  - Stop条件マッチ/不マッチ、無効な正規表現、空パターン、stopReason伝達
  - `stopPattern` フィールド追加後の `setAutoYesEnabled` / `getAutoYesState` テスト追加 <!-- S3-F001 -->
  - **`setAutoYesEnabled(true, duration, stopPattern)` 呼び出し時に `stopReason` がクリア（undefined）され、新しい `stopPattern` が設定されることの確認テスト** <!-- S5-F002 -->
  - **`setAutoYesEnabled(false)` 呼び出し時にスプレッド演算子で既存の `stopReason`/`stopPattern` が保持されることの確認テスト** <!-- S5-F001 -->
  - AutoYesConfirmDialog: stopPattern入力フィールドのレンダリング・バリデーションテスト <!-- S3-F005 -->
  - **AutoYesConfirmDialog: 既存テスト修正が必要** -- Interactions セクション（AutoYesConfirmDialog.test.tsx lines 115-143）の3つのテストケース（default/3h/8h duration、line 119, 127, 135）で `toHaveBeenCalledWith(duration)` を `toHaveBeenCalledWith(duration, '')` または `toHaveBeenCalledWith(duration, expect.any(String))` に修正。新規テストとして「stopPatternが入力された場合のonConfirm呼び出し引数検証」を追加 <!-- S7-F002 -->
  - AutoYesToggle: `onToggle` 呼び出し時のstopPattern引数テスト <!-- S3-F006 -->
  - **AutoYesToggle: 既存テスト修正が必要** -- OFF->ONセクション（AutoYesToggle.test.tsx lines 39-62）の2つのテストケース（default/3h duration）で `toHaveBeenCalledWith(true, duration)` を `toHaveBeenCalledWith(true, duration, expect.any(String))` に修正。ON->OFFテスト（line 81-88の`toHaveBeenCalledWith(false)`）はdisable時にstopPatternを渡さないためそのまま通過する <!-- S7-F003 -->
- [ ] 結合テスト追加: `tests/integration/auto-yes-persistence.test.ts` に `stopPattern` フィールドの永続化テスト（globalThis経由の永続化をIssue #225のdurationテストと同様のパターンで検証） <!-- S3-F001, S3-F004 -->

## 受入条件

- [ ] Auto-Yes確認ダイアログにStop条件入力フィールドが表示される
- [ ] Stop条件が空の場合は従来通りの動作（時間ベースのみで停止）
- [ ] Stop条件に正規表現を入力でき、ターミナル出力がマッチした場合にAuto-Yesが自動停止する
- [ ] Auto-Yesが停止した際にユーザーに通知される（`stopReason`フィールドによるトースト通知。停止理由が「Stop条件マッチ」であることを明示。トースト重複表示防止済み） <!-- S1-F002, S5-F004 -->
- [ ] 不正な正規表現パターン入力時にバリデーションエラーが表示される（クライアント: インラインエラー+ボタン無効化、サーバー: 400レスポンス） <!-- S1-F010 -->
- [ ] 正規表現のReDoS（Regular Expression Denial of Service）対策が施されている（`MAX_STOP_PATTERN_LENGTH`による最大長制限 + `new RegExp(pattern)` try-catchによる構文検証） <!-- S1-F004, S5-F005 -->
- [ ] 既存のAuto-Yes機能（時間ベース停止、プロンプト自動応答）に影響しない
- [ ] 既存テストがすべてパスする（AutoYesConfirmDialog/AutoYesToggleの既存テストはonConfirm/onToggleシグネチャ変更に合わせて修正済みであること） <!-- S7-F002, S7-F003 -->

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/auto-yes-manager.ts` | `AutoYesState`にstopPattern・stopReasonフィールド追加（stopReasonは `'expired' \| 'stop_pattern_matched'`、undefinedは手動OFF/初期状態）、`setAutoYesEnabled()`のdisableパスをexisting未定義時のフォールバック付きスプレッド演算子に変更しstopReason/stopPattern保持（S7-F001参照）、`pollAutoYes()`にStop条件チェック追加（初期実装は全文照合）、`getAutoYesState()`期限切れ無効化時のstopPattern保持・stopReason設定、停止時の処理フロー実装 <!-- S3-F002, S3-F009, S5-F001, S5-F003, S7-F001 --> |
| `src/lib/auto-yes-resolver.ts` | 変更なし（自動応答ロジックは変わらない） |
| `src/config/auto-yes-config.ts` | `MAX_STOP_PATTERN_LENGTH`等のStop条件関連定数を追加 <!-- S1-F007 --> |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | Stop条件入力フィールド追加、リアルタイムバリデーション、onConfirmにstopPattern引数追加 |
| `src/components/worktree/AutoYesToggle.tsx` | onToggleにstopPattern引数追加 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | stopPatternパラメータの受け渡し・サーバーサイドバリデーション追加・空文字列正規化処理追加。**`setAutoYesEnabled()`へのstopPattern渡しはenabled=true時のみ**: `setAutoYesEnabled(params.id, body.enabled, body.enabled ? duration : undefined, body.enabled ? stopPattern : undefined)`（enabled=false時はスプレッド演算子で既存stateが保持されるためstopPatternパラメータは不要） <!-- S5-F007, S7-F005 --> |
| `src/app/api/worktrees/[id]/current-output/route.ts` | autoYesレスポンスに`stopReason`フィールド追加（クライアント通知用）。**`stopReason`はenabledの値に関わらず`autoYesState?.stopReason`をそのまま返却する**（enabled=false時にこそ必要な情報であり、サーバー側でフィルタリングしない） <!-- S1-F002, S1-F008, S7-F004 --> |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `CurrentOutputResponse.autoYes`型に`stopReason`フィールドを追加（`{ enabled: boolean; expiresAt: number \| null; stopReason?: 'expired' \| 'stop_pattern_matched' }`）、handleAutoYesToggleにstopPattern引数追加、fetch bodyへのstopPattern追加、stopReason検出時のトースト通知、**トースト重複防止（useRefで前回enabled状態を保持、enabled: true -> false遷移時のみstopReasonチェック+トースト表示）**、**`fetchCurrentOutput()`のuseCallback依存配列に`showToast`を追加**（stable referenceのためレンダリング頻度への影響は最小限） <!-- S1-F006, S3-F003, S5-F003, S5-F004, S7-F006 --> |
| `locales/ja/autoYes.json` | Stop条件ラベル・プレースホルダー・停止通知メッセージ・バリデーションエラーの日本語翻訳キー追加 <!-- S1-F001 --> |
| `locales/en/autoYes.json` | Stop条件ラベル・プレースホルダー・停止通知メッセージ・バリデーションエラーの英語翻訳キー追加 <!-- S1-F001 --> |
| `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | **既存テスト修正**: Interactionsセクション（lines 115-143）のonConfirm引数検証を新シグネチャ（2引数: duration, stopPattern）に対応させる（line 119, 127, 135）。新規テスト追加: stopPattern入力フィールドのレンダリング・バリデーション・onConfirm引数検証 <!-- S7-F002, S3-F005 --> |
| `tests/unit/components/worktree/AutoYesToggle.test.tsx` | **既存テスト修正**: OFF->ONセクション（lines 39-62）のonToggle引数検証を新シグネチャ（3引数: enabled, duration, stopPattern）に対応させる。ON->OFFテスト（line 81-88）は変更不要 <!-- S7-F003, S3-F006 --> |

### 関連コンポーネント

- `src/lib/prompt-detector.ts` -- プロンプト検出（変更不要、Stop条件はその前段で判定）
- `src/lib/cli-patterns.ts` -- stripAnsi, detectThinking（変更不要）
- `src/lib/auto-yes-resolver.ts` -- 変更なし（Stop条件チェックはresolveAutoAnswer()呼び出し前に行われる）
- `src/lib/session-cleanup.ts` -- 変更不要（stopAutoYesPollingの冪等性により、Stop条件マッチによる自動停止との競合なし確認済み） <!-- S3-F010 -->

### useAutoYes.tsについて <!-- S1-F003 -->

`src/hooks/useAutoYes.ts` はクライアントサイドの自動応答フックであり、stopPatternはサーバーサイド（`auto-yes-manager.ts`）で管理される。stopPatternの伝達はWorktreeDetailRefactored.tsx -> fetch API -> auto-yes/route.ts -> setAutoYesEnabled() の経路で行われるため、**useAutoYes.ts自体の変更は不要**。ただし、`stopReason`を受け取ってトースト通知をトリガーするロジックはWorktreeDetailRefactored.tsxのautoYesポーリング処理で実装する。

## セキュリティ考慮

- **ReDoS対策**: **初期実装ではパターン長制限（`MAX_STOP_PATTERN_LENGTH = 500`文字）+ `new RegExp(pattern)` try-catchによる構文検証のみで対応する**。500文字以下のパターンに対する実用的なReDoSリスクは低く、外部ライブラリ（safe-regex2等）の追加は依存関係増加・メンテナンスコストとの比較衡量により初期バージョンでは見送る。ReDoS対策の強化（safe-regex2等の導入）は将来の改善として検討する <!-- S1-F004, S5-F005 -->
- **入力サニタイズ**: stopPatternの最大長を`MAX_STOP_PATTERN_LENGTH`定数で制限する
- **バリデーション（Defense in Depth）**: クライアントサイド（AutoYesConfirmDialog内リアルタイム検証）とサーバーサイド（route.ts POSTハンドラー）の両方でバリデーションを実施 <!-- S1-F010 -->
- **サーバーサイドバリデーション**: APIルートでstopPatternの正規表現構文検証（try-catch）・長さ制限を検証する。無効な場合は400レスポンスを返す

---

## レビュー履歴

### イテレーション 1 (2026-02-19) -- Stage 1 通常レビュー

| ID | 重要度 | 対応内容 |
|----|--------|---------|
| S1-F001 | Must Fix | 変更対象ファイルテーブルにi18nファイル（`locales/ja/autoYes.json`, `locales/en/autoYes.json`）を追加 |
| S1-F002 | Must Fix | Stop条件停止時のクライアント通知メカニズムを設計に追加（AutoYesStateに`stopReason`フィールド、current-output APIレスポンス変更、トースト通知） |
| S1-F003 | Must Fix | `useAutoYes.ts`の変更を「不要」に修正。stopPatternはサーバーサイドで管理され、伝達経路はWorktreeDetailRefactored経由 |
| S1-F004 | Should Fix | ReDoS対策を`safe-regex2`等によるパターン安全性検証 + MAX_STOP_PATTERN_LENGTH制限に具体化 |
| S1-F005 | Should Fix | pollAutoYes内のstopPatternマッチ時処理フロー（stopReason設定 -> 無効化 -> ポーラー停止 -> ログ）を明記 |
| S1-F006 | Should Fix | WorktreeDetailRefactored.tsxのstopPattern伝達経路（ConfirmDialog -> Toggle -> handleAutoYesToggle -> fetch -> route.ts）を具体的に記述 |
| S1-F007 | Should Fix | `auto-yes-config.ts`を変更対象ファイルテーブルに追加（MAX_STOP_PATTERN_LENGTH等の定数追加） |
| S1-F008 | Should Fix | `current-output/route.ts`を変更対象ファイルテーブルに追加（autoYesレスポンスにstopReason追加） |
| S1-F009 | Should Fix | stopPatternの照合対象範囲をcleanOutput全体（差分照合方式）に明確化 |
| S1-F010 | Should Fix | バリデーションエラーUI表示を具体化（クライアント: インラインエラー+ボタン無効化、サーバー: 400レスポンス） |
| S1-F011 | Nice to Have | Auto-Yes有効中のstopPattern表示は将来検討として記録（スコープ外） |
| S1-F012 | Nice to Have | デフォルトプリセット機能は将来のエンハンスメントとして明記 |

### イテレーション 2 (2026-02-19) -- Stage 3 影響範囲レビュー

| ID | 重要度 | 対応内容 |
|----|--------|---------|
| S3-F001 | Must Fix | 実装タスクに「stopPatternフィールド追加後のsetAutoYesEnabled/getAutoYesStateテスト追加」を明記 |
| S3-F002 | Must Fix | getAutoYesState()内の期限切れ無効化時にstopPatternをスプレッド演算子で保持し、stopReasonに'expired'を設定する設計を明記 |
| S3-F003 | Must Fix | WorktreeDetailRefactored.tsxの変更内容にCurrentOutputResponse.autoYes型へのstopReasonフィールド追加を明記 |
| S3-F004 | Must Fix | 実装タスクにtests/integration/auto-yes-persistence.test.tsへのstopPattern永続化テスト追加を追記 |
| S3-F005 | Should Fix | 実装タスクにAutoYesConfirmDialog: stopPattern入力フィールドのレンダリング・バリデーションテスト追加を追記 |
| S3-F006 | Should Fix | 実装タスクにAutoYesToggle: onToggle呼び出し時のstopPattern引数テスト追加を追記 |
| S3-F007 | Should Fix | Desktop/Mobile両方のAutoYesToggleが同一handleAutoYesToggleを参照するためstopPattern伝達が保証される旨を追記 |
| S3-F008 | Should Fix | auto-yes GETレスポンスへのstopReason追加は将来検討として記録（初期実装はcurrent-output API経由の通知のみ） |
| S3-F009 | Should Fix | 初期実装は全文照合を採用、差分照合は将来最適化として明記 |
| S3-F010 | Should Fix | 関連コンポーネントにsession-cleanup.ts変更不要（確認済み）を追記 |
| S3-F011 | Should Fix | useAutoYes.tsの競合ウィンドウ（最大1ポーリングサイクル）は実害なし、変更不要判断を維持 |
| S3-F012 | Nice to Have | auto-yes-resolver.testへの影響なし確認済み |
| S3-F013 | Nice to Have | auto-yes-config.testへのMAX_STOP_PATTERN_LENGTH定数テストは暗黙的に含まれる |
| S3-F014 | Nice to Have | useAutoYes.testへの影響なし確認済み |

### イテレーション 3 (2026-02-19) -- Stage 5 通常レビュー（2回目）

| ID | 重要度 | 対応内容 |
|----|--------|---------|
| S5-F001 | Should Fix | `setAutoYesEnabled()`のdisableパスをスプレッド演算子 `{ ...existing, enabled: false }` に変更し、stopReason/stopPatternフィールドを保持する設計を追記。コードイメージ付き |
| S5-F002 | Should Fix | 実装タスクのユニットテストに「再有効化時のstopReasonクリア確認テスト」「disableパスのstopReason/stopPattern保持確認テスト」を追加 |
| S5-F003 | Should Fix | stopReasonの型を `'expired' \| 'stop_pattern_matched'` に変更。undefinedを手動OFF/初期状態として扱う方針を明記（'manual'は設定しない） |
| S5-F004 | Should Fix | WorktreeDetailRefactored.tsxにトースト重複表示防止メカニズム（useRefで前回enabled状態を保持、enabled: true -> false遷移時のみトースト表示）の設計を追加 |
| S5-F005 | Should Fix | ReDoS対策を「パターン長制限 + try-catch構文検証」のみに変更。safe-regex2等の外部ライブラリ追加は初期バージョンでは見送り、将来の改善として検討 |
| S5-F006 | Nice to Have | 判定タイミングの番号がIssue内の参照用であり、コード内のコメント番号とは対応しない旨の注記を追加 |
| S5-F007 | Nice to Have | auto-yes/route.tsのstopPattern空文字列正規化処理（`body.stopPattern?.trim() \|\| undefined`）を追記 |

### イテレーション 4 (2026-02-19) -- Stage 7 影響範囲レビュー（2回目）

| ID | 重要度 | 対応内容 |
|----|--------|---------|
| S7-F001 | Should Fix | `setAutoYesEnabled()`のdisableパスコードイメージを修正。existing未定義時のフォールバック処理（enabledAt/expiresAtの`?? 0`フォールバック + stopReason/stopPatternの条件付きスプレッド）を追記。既存テスト互換性を明記 |
| S7-F002 | Should Fix | AutoYesConfirmDialog.test.tsxの既存テスト修正が必要であることを実装タスクに追記。Interactionsセクション（lines 115-143）の3テストケース（line 119, 127, 135）でonConfirm引数数変更への対応が必要 |
| S7-F003 | Should Fix | AutoYesToggle.test.tsxの既存テスト修正が必要であることを実装タスクに追記。OFF->ONセクション（lines 39-62）でonToggle引数数変更への対応が必要。ON->OFFテスト（line 81-88）は変更不要 |
| S7-F004 | Should Fix | current-output/route.tsのstopReasonフィールド返却条件（enabledの値に関わらず`autoYesState?.stopReason`をそのまま返却する）をIssueに明記 |
| S7-F005 | Should Fix | auto-yes/route.tsのsetAutoYesEnabled()呼び出しでstopPatternをenabled=true時のみ渡すことをIssueに明記 |
| S7-F006 | Should Fix | WorktreeDetailRefactored.tsxのfetchCurrentOutputのuseCallback依存配列にshowToastを追加することを実装タスクに追記。代替アプローチ（useEffectによるautoYes状態変更監視）も記載 |
| S7-F007 | Nice to Have | auto-yes-persistence.test.tsのstopPatternフィールド永続化テストケース構造が未記載（実装タスクに概要記載済みのため追加対応は見送り） |
| S7-F008 | Nice to Have | globalThis型宣言はAutoYesState型参照のため自動反映。追加変更不要を確認 |
| S7-F009 | Nice to Have | handleAutoYesToggle()のfetch body拡張はIssue本文に既に記載済み。追加対応不要 |