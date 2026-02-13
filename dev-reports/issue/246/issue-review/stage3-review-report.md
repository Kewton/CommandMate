# Issue #246 レビューレポート（Stage 3）

**レビュー日**: 2026-02-13
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: useAutoYes hookへの影響が未記載

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 セクション - 関連コンポーネント

**問題**:
Issueの影響範囲に記載されていない隠れた影響対象として、`useAutoYes` hookがある。visibilitychange復帰時に`fetchCurrentOutput`が呼ばれると、prompt状態が変更される（`WorktreeDetailRefactored.tsx` L1039-1043のprompt state transition）。`useAutoYes` hookは`state.prompt.visible`をwatchしてauto-responseをトリガーするため（L1425-1431）、バックグラウンド中にpromptが到着していた場合、復帰時の`fetchCurrentOutput`がprompt状態を更新し、auto-yes hookが自動応答を発火する可能性がある。

`useAutoYes`のDUPLICATE_PREVENTION_WINDOW_MS（3秒）は同一prompt内での重複を防ぐが、バックグラウンドから復帰までの時間が3秒を超える場合（通常のユースケースでは数十秒～数分）は重複とみなされず、prompt到着から時間が経過した後の自動応答が発生する。これは意図した動作かもしれないが、明示的に分析されていない。

**証拠**:
- `src/hooks/useAutoYes.ts` L18: `DUPLICATE_PREVENTION_WINDOW_MS = 3000`
- `src/components/worktree/WorktreeDetailRefactored.tsx` L1425-1431: `useAutoYes` hookは`isPromptWaiting=state.prompt.visible`を監視
- `src/components/worktree/WorktreeDetailRefactored.tsx` L1039-1043: `fetchCurrentOutput`内でprompt状態遷移が発生

**推奨対応**:
影響範囲の関連コンポーネントに`src/hooks/useAutoYes.ts`を追加し、以下を記載する:
- visibilitychange復帰時の`fetchCurrentOutput`がprompt状態を更新した場合、auto-yes hookが自動応答を発火する可能性がある
- `DUPLICATE_PREVENTION_WINDOW_MS`（3秒）によりある程度保護されるが、バックグラウンド滞在時間が3秒を超える場合は保護範囲外
- 復帰時の自動応答動作が意図通りか確認する必要がある

---

## Should Fix（推奨対応）

### SF-1: setIntervalポーリングとの競合状態の具体的影響分析が不足

**カテゴリ**: 破壊的変更
**場所**: ## 対策案 セクション / ## 受入条件 セクション

**問題**:
visibilitychangeハンドラとsetIntervalポーリング（L1479-1493）の同時発火について、受入条件では「データの整合性が保たれる」と記載があるが、具体的な競合シナリオの分析がない。

setIntervalのuseEffectは`loading`と`error`を依存配列に持つ（L1480: `if (loading || error) return;`）。visibilitychange復帰時にhandleRetry同等フロー（`setError(null)` -> `setLoading(true)` -> fetch -> `setLoading(false)`）を実行すると、以下のシーケンスが発生する:

1. `setError(null)` + `setLoading(true)` によりuseEffectが再実行、`loading=true`のため`return`でsetInterval未設定
2. fetch完了後に`setLoading(false)` -> useEffectが再度実行 -> 新しいsetIntervalが設定される
3. ただし、Reactのstate更新バッチングにより、visibilitychangeハンドラのfetchとsetIntervalの最後のfetch実行が重なる窓が存在する

現在のfetch関数（`fetchWorktree`/`fetchMessages`/`fetchCurrentOutput`）は全てGETリクエストで冪等であるため、データ破損は起きない。しかし、不必要なAPI呼び出しが発生する。

**証拠**:
- `WorktreeDetailRefactored.tsx` L1479-1493: useEffectの依存配列は`[loading, error, fetchCurrentOutput, fetchWorktree, fetchMessages, state.terminal.isActive]`
- L1480: `if (loading || error) return;`

**推奨対応**:
実装タスクまたは対策案に以下を追加する:
- fetchは全てGETリクエストで冪等であるため、同時発火してもデータ破損は起きないことを確認済みと記載
- 不必要なAPI負荷を避けるため、visibilitychangeハンドラ内のfetch実行中はsetIntervalが自動的にcleanupされる設計であることを明記（loading=trueのガードにより実現される）

---

### SF-2: テスト範囲の特定が不十分

**カテゴリ**: テスト範囲
**場所**: ## 実装タスク セクション - テスト関連タスク

**問題**:
テスト方法はStage 2の反映で具体化されたが（`document.dispatchEvent`、`Object.defineProperty`によるモック）、具体的なテストケースの列挙がない。また、`WorktreeList.tsx`にはテストファイルが存在しないことが確認された。

**証拠**:
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: 既存テストファイルが存在
- `tests/unit/components/WorktreeList*.test.*`: テストファイルが存在しない

**推奨対応**:
テスト計画を以下のように具体化する:

1. `WorktreeDetailRefactored.test.tsx`に追加すべきテストケース:
   - (a) `visibilitychange`発火（`visibilityState='visible'`）時に`fetchWorktree`が呼ばれること
   - (b) error状態で`visibilitychange`が発火した場合、errorがリセットされデータ再取得が行われること
   - (c) `visibilityState='hidden'`時にはfetch呼び出しが行われないこと
   - (d) throttle/timestampガードにより短時間の連続発火でfetchが1回のみ実行されること
2. WorktreeList.tsxのテストについて:
   - テストファイルが存在しないため、新規テストファイルの作成方針を明記するか、手動テスト（スマートフォン実機確認に含む）で代替する旨を記載

---

### SF-3: debounce関数はvisibilitychangeの用途に不向き

**カテゴリ**: 依存関係
**場所**: ## 検討事項 セクション - debounce/throttle考慮

**問題**:
Issueでは「`src/lib/utils.ts`に既存のdebounce関数あり」として、連続発火防止にdebounce活用を検討事項としている。しかし、`src/lib/utils.ts`のdebounce関数はデバウンスパターン（最後の呼び出しからN ms後に実行）であり、visibilitychangeハンドラの連続発火防止にはスロットルパターン（最初の呼び出しから即座に実行し、N ms間は再実行を抑制）の方が適切。

visibilitychange復帰時はユーザーがすぐにデータを見たい場面であるため、debounceを使うと遅延が発生し、ユーザー体験を損なう。現在のコードベースにthrottle関数は存在しない。

**証拠**:
- `src/lib/utils.ts` L25-40: `debounce`関数は最後の呼び出しから`delay` ms後に実行する設計
- `grep -r 'throttle' src/` の結果が0件

**推奨対応**:
検討事項のdebounce/throttle記載を修正し、以下を明記する:
- visibilitychangeハンドラでは即座にデータ再取得を行いたいため、debounceではなくthrottleまたはtimestampベースの簡易ガード（例: `lastFetchTime`を`useRef`で管理し、前回取得から5秒以内は再取得をスキップ）が適切
- `src/lib/utils.ts`のdebounce関数はこの用途には不向き
- timestampベースのガードはコードベースにthrottle関数を新規追加するよりも実装が軽量

---

## Nice to Have（あれば良い）

### NTH-1: visibilitychangeパターンのカスタムフック化検討

**カテゴリ**: ドキュメント更新
**場所**: ## 影響範囲 セクション

**問題**:
本Issue対応でvisibilitychangeイベントリスナーが初めてコードベースに導入される（現在src以下にvisibilitychangeリスナーは0件）。同様のsetIntervalポーリングパターンを持つコンポーネントが複数存在し、将来的に同じパターンの適用が想定される。

**証拠**:
- `src/components/external-apps/ExternalAppsManager.tsx` L56-57: 60秒間隔のsetIntervalポーリング
- `src/components/external-apps/ExternalAppStatus.tsx` L72-74: 設定可能間隔のsetIntervalポーリング
- `src/components/worktree/AutoYesToggle.tsx` L64-65: 1秒間隔のsetInterval

**推奨対応**:
将来のIssueとして「visibilitychangeハンドラのカスタムフック化（例: `usePageVisibility`）を検討し、他のポーリング系コンポーネントにも横展開する」を記載する。ただし本Issueのスコープでは`WorktreeDetailRefactored.tsx`への直接追加で十分。

---

### NTH-2: WorktreeList.tsxのWebSocket再接続との相互作用

**カテゴリ**: 移行考慮
**場所**: ## 実装タスク セクション - WorktreeList.tsx関連タスク

**問題**:
WorktreeList.tsxにvisibilitychange対応（setInterval再設定）を追加する際、同コンポーネントが利用するWebSocket接続（`useWebSocket` L110-112）のバックグラウンド復帰時の再接続動作が未分析。WebSocket接続もバックグラウンド中に切断される可能性があり、reconnect時にbroadcastメッセージを受信して`fetchWorktrees(true)`が呼ばれる（L103-106）。visibilitychange復帰とWebSocket reconnect両方からfetchが発火する可能性がある。

**証拠**:
- `WorktreeList.tsx` L110-112: `const { status: wsStatus } = useWebSocket({ onMessage: handleWebSocketMessage })`
- `WorktreeList.tsx` L103-106: broadcastメッセージ受信時に`fetchWorktrees(true)`

**推奨対応**:
WorktreeList.tsxの対応について「WebSocket再接続時のbroadcast受信による`fetchWorktrees(true)`呼び出しとvisibilitychange復帰による再取得が重複する可能性がある。fetchWorktrees(true)はsilentモードで冪等であるため大きな問題にはならないが、留意する」と注記する。

---

## 影響範囲サマリー

### 変更対象ファイル（直接変更）

| ファイル | 変更内容 | リスク |
|---------|---------|--------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | visibilitychangeイベントリスナー追加、復帰時のエラーリセット+データ再取得 | 中: setIntervalとの競合窓、auto-yes hookへの連鎖影響 |
| `src/components/worktree/WorktreeList.tsx` | バックグラウンド復帰時のsetInterval再設定 | 低: WebSocket再接続との重複可能性 |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | visibilitychangeテストケース追加 | 低: 既存テストへの影響なし |

### 影響を受けるファイル（変更なし、動作影響あり）

| ファイル | 影響 | リスク |
|---------|------|--------|
| `src/hooks/useAutoYes.ts` | visibilitychange復帰時のprompt状態変更により自動応答が発火する可能性 | **高: バックグラウンド中のprompt到着時** |
| `src/hooks/useWorktreeUIState.ts` | ローカルstateのerrorとreducer管理のerrorが2系統あることに留意 | 低: 直接的影響なし |
| `src/lib/utils.ts` | debounce関数はvisibilitychange用途に不向き | 低: 変更不要、代替手法で実装 |
| `src/hooks/useWebSocket.ts` | WorktreeList.tsxでのWebSocket再接続とsetInterval再設定の相互作用 | 低: 冪等なfetch呼び出し |
| `src/app/api/worktrees/[id]/route.ts` | visibilitychange復帰時に追加のGETリクエストを受ける | 低: 既存APIで対応可能 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | visibilitychange復帰時に追加のGETリクエストを受ける | 低: 既存APIで対応可能 |
| `src/app/api/worktrees/[id]/messages/route.ts` | visibilitychange復帰時に追加のGETリクエストを受ける | 低: 既存APIで対応可能 |

### 破壊的変更の有無

**破壊的変更なし**。visibilitychangeイベントリスナーの追加は既存のポーリング動作に対する追加的な振る舞いであり、既存の動作を変更しない。ただし、以下の間接的な動作変更に注意:
- auto-yes有効時にバックグラウンドから復帰すると、バックグラウンド中に到着したpromptに対する自動応答がトリガーされる可能性がある
- 復帰直後に既存setIntervalのfetchとvisibilitychangeのfetchが短期間で2回発生する窓が存在する

---

## 参照ファイル

### コード
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 主要変更対象（ポーリング L1479-1493、handleRetry L1434-1442、fetchCurrentOutput L1017-1053のprompt状態遷移）
- `src/components/worktree/WorktreeList.tsx`: 副次的変更対象（setInterval L122-129、WebSocket L110-112）
- `src/hooks/useAutoYes.ts`: 影響範囲未記載だが影響を受ける（DUPLICATE_PREVENTION_WINDOW_MS L18）
- `src/hooks/useWorktreeUIState.ts`: clearErrorアクション（L270）、ローカルstateとの2系統管理
- `src/lib/utils.ts`: debounce関数（L25-40）、visibilitychangeには不向き
- `src/hooks/useWebSocket.ts`: WorktreeList.tsxの再接続動作
- `src/components/external-apps/ExternalAppsManager.tsx`: 類似ポーリングパターン（横展開候補）
- `src/components/external-apps/ExternalAppStatus.tsx`: 類似ポーリングパターン（横展開候補）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: テスト追加先

### ドキュメント
- `CLAUDE.md`: プロジェクトのコーディング規約・ファイル構成・テスト戦略
