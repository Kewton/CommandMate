# Issue #246 レビューレポート（Stage 7）

**レビュー日**: 2026-02-13
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 2 |

**総合評価**: Issue #246の影響範囲分析は高品質であり、Stage 3で指摘された全6件（MF-1, SF-1~3, NTH-1~2）およびStage 5で指摘された2件（NTH-1~2）が全て適切に反映されている。新たなMust Fix/Should Fix事項は発見されなかった。

---

## 前回指摘事項の反映確認

### Stage 3（影響範囲レビュー1回目）の指摘事項

| ID | カテゴリ | ステータス | 確認内容 |
|----|---------|-----------|---------|
| MF-1 | 影響ファイル | **解決済み** | useAutoYes hookが影響範囲の関連コンポーネントに追加され、DUPLICATE_PREVENTION_WINDOW_MS（3秒）の保護範囲外リスクが明記されている。実装タスクと受入条件にもauto-yes連動確認が追加されている。 |
| SF-1 | 破壊的変更 | **解決済み** | visibilitychangeハンドラとsetIntervalの同時発火分析が対策案セクションに追加されている。GETリクエストの冪等性分析と2つの対処オプションが記載されている。受入条件に「API呼び出しが不必要に重複しないこと」が追加されている。 |
| SF-2 | テスト範囲 | **解決済み** | 4つの具体的テストケースが列挙されている。WorktreeList.tsxのテストファイル不在と対応方針が明記されている。テスト手法も具体化されている。 |
| SF-3 | 依存関係 | **解決済み** | throttle/timestampガードへの修正が完了。debounceが不向きである理由と、timestampベースの簡易ガードの提案が明記されている。 |
| NTH-1 | ドキュメント更新 | **解決済み** | 将来的な横展開候補セクションが追加され、usePageVisibilityカスタムフック化の検討が記載されている。本Issueでは最小限実装で十分と明記されている。 |
| NTH-2 | 移行考慮 | **解決済み** | WebSocket再接続とsetInterval再設定の相互作用が実装タスクと変更対象ファイル表の両方に記載されている。 |

### Stage 5（通常レビュー2回目）の指摘事項

| ID | カテゴリ | ステータス | 確認内容 |
|----|---------|-----------|---------|
| NTH-1 | 正確性 | **解決済み** | 「WorktreeList.tx」が「WorktreeList.tsx」に修正されている。 |
| NTH-2 | 完全性 | **解決済み** | レビュー履歴にStage番号（Stage 2 / Stage 4 / Stage 6）が追記されている。 |

---

## 影響範囲の網羅性評価

### 変更対象ファイル

Issueに記載されている変更対象ファイル（2件）は適切であり、過不足はない。

| ファイル | 記載 | 評価 |
|---------|------|------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 記載あり | 適切。visibilitychangeリスナー追加の主要対象。 |
| `src/components/worktree/WorktreeList.tsx` | 記載あり | 適切。setInterval再設定の副次的対象。 |

### 関連コンポーネント

Issueに記載されている関連コンポーネント（5件）は適切であり、各コンポーネントの影響分析が具体的に行われている。

| ファイル | 記載 | 評価 |
|---------|------|------|
| `src/hooks/useWorktreeUIState.ts` | 記載あり | 適切。clearErrorとローカルstateの使い分けが明確化済み。 |
| `src/hooks/useAutoYes.ts` | 記載あり | 適切。visibilitychange復帰時のprompt状態更新によるauto-yes発火リスクが分析済み。 |
| `src/lib/utils.ts` | 記載あり | 適切。debounce不適合とthrottle/timestampガードの提案が明記済み。 |
| `src/app/api/worktrees/[id]/route.ts` 他3件 | 記載あり | 適切。変更不要だがAPIエンドポイントとして認識。 |
| ExternalAppsManager.tsx / ExternalAppStatus.tsx | 記載あり | 適切。将来的横展開候補として分離されている。 |

### 依存関係分析

主要な依存関係が全て分析されている。

- fetchWorktree/fetchMessages/fetchCurrentOutputのGET冪等性
- useAutoYes hookのstate.prompt.visible監視
- useWebSocket autoReconnectの独立動作
- useWorktreeUIState clearError vs ローカルsetErrorの2系統

### 破壊的変更

なし。visibilitychangeリスナーの追加は純粋な機能追加であり、既存動作に変更を加えない。受入条件で「setIntervalのタイミングやインターバル値が変更されていない」ことが保証されている。

### テスト範囲

4つの具体的テストケースが計画されており、テスト手法も記載されている。WorktreeList.tsxのテストファイル不在に対する方針も明確。

---

## Nice to Have（あれば良い）

### NTH-1: useAutoSave hookのバックグラウンド遷移時の動作

**カテゴリ**: 影響ファイル
**場所**: ## 影響範囲 - 関連コンポーネント セクション

**問題**:
`useAutoSave` hookが `MemoCard` コンポーネントで使用されており（`src/components/worktree/MemoCard.tsx` L71, L83）、内部的に `setTimeout`（debounce）を使用している。バックグラウンド遷移時にメモ編集中の場合、`useAutoSave` の debounce timer がブラウザによって一時停止される可能性がある。

**証拠**:
- `src/hooks/useAutoSave.ts` L190-192: `timerRef.current = setTimeout(() => void executeSave(valueRef.current), debounceMs)`
- `src/components/worktree/MemoCard.tsx` L71-88: `useAutoSave` を title と content に使用。`debounceMs` 未指定のためデフォルト300ms。

**推奨対応**:
影響範囲分析の完全性として認識しておく程度でよい。Issueへの追記は不要。`useAutoSave` の timer は `debounceMs=300ms` と短く、復帰後に即座に再開されるため、ユーザーが認識可能な問題は発生しない。将来的に `usePageVisibility` カスタムフックを導入する際に、`saveNow()` を復帰時に呼び出すことを検討してもよいが、本Issueのスコープ外。

---

### NTH-2: useWebSocket autoReconnectのsetTimeoutバックグラウンド制約

**カテゴリ**: 依存関係
**場所**: ## 実装タスク セクション - WorktreeList.tsx関連タスク

**問題**:
`useWebSocket` hookの `autoReconnect` 機能（`src/hooks/useWebSocket.ts` L136-141: `ws.onclose` で `reconnectDelay=3000ms` 後に `connect()` を再実行）は、バックグラウンド中にWebSocket接続が切断された場合、復帰時に `autoReconnect` の `setTimeout` 自体がブラウザのバックグラウンドタイマー制約を受ける可能性がある。Issueでは「WebSocketのreconnect処理がsetIntervalの再設定と独立して動作するため、両者の復帰タイミングのずれについて留意する」と記載されているが、`autoReconnect` の `setTimeout` 自体のバックグラウンド遅延については言及されていない。

**証拠**:
- `src/hooks/useWebSocket.ts` L132-141: `ws.onclose` 内で `autoReconnect=true` の場合に `setTimeout(connect, reconnectDelay=3000)` が実行される。
- `src/components/worktree/WorktreeList.tsx` L103-106: `onMessage` 経由で `fetchWorktrees(true)` がトリガーされる。

**推奨対応**:
現在の記載で実用上は十分。WebSocket接続が復帰すれば `onMessage` で `fetchWorktrees(true)` がトリガーされるため、最終的にはデータ同期が回復する。実装フェーズの設計判断に委ねてよい。

---

## 総合評価

Issue #246の影響範囲分析は、2回のイテレーション（Stage 3 + Stage 7）を通じて十分な品質に達している。

**強み**:
- 変更対象ファイルと関連コンポーネントが体系的に整理されている
- 依存関係の影響分析が具体的（useAutoYes hookのDUPLICATE_PREVENTION_WINDOW_MS分析、GETリクエスト冪等性分析など）
- 破壊的変更がないことが受入条件で保証されている
- テスト計画が4つの具体的テストケースとテスト手法を含む
- 将来的な横展開（usePageVisibilityカスタムフック化）がスコープ外として明確に分離されている
- レビュー履歴のトレーサビリティが確保されている

**残存リスク（全て認識・記載済み）**:
1. useAutoYes hookのDUPLICATE_PREVENTION_WINDOW_MS（3秒）がバックグラウンド長期滞在後の復帰で保護範囲外になるリスク -- 実装時の判断に委ねられている
2. throttle/timestampガードの具体的な閾値（例: 5秒）の最終決定 -- 実装者に委ねられている
3. WebSocket autoReconnectのsetTimeoutがバックグラウンドで遅延するリスク -- 軽微、broadcastメッセージで同期回復

---

## 参照ファイル

### コード
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 主要変更対象。visibilitychangeリスナー追加先
- `src/components/worktree/WorktreeList.tsx`: 副次的変更対象。setInterval再設定対応
- `src/hooks/useAutoYes.ts`: 影響範囲。prompt状態変更時のauto-yes発火リスク
- `src/hooks/useWebSocket.ts`: 間接的影響。autoReconnect機能のバックグラウンド動作
- `src/hooks/useAutoSave.ts`: 軽微な関連。setTimeout debounceのバックグラウンド一時停止
- `src/hooks/useWorktreeUIState.ts`: 関連コンポーネント。clearError vs ローカルsetError
- `src/lib/utils.ts`: debounce関数（visibilitychangeに不向き）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: テスト追加先

### ドキュメント
- `CLAUDE.md`: プロジェクトのコーディング規約・ファイル構成の参照ドキュメント
