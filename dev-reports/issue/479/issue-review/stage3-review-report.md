# Issue #479 影響範囲レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 2 |

Issue #479（巨大ファイル分割 R-1）の影響範囲を実コードベースの依存関係に基づいて分析した。db.tsは50箇所の消費者を持ち最大のインパクトだが、バレルファイル戦略でカバーされている。新たに発見された問題として、auto-yes-manager.tsのisValidWorktreeIdが11のAPIルートからimportされており、分割時の配置先検討が必要である。

## 影響範囲サマリー

| ファイル | API消費者 | lib消費者 | テスト消費者 | バレル戦略 | リスク |
|---------|----------|----------|------------|----------|-------|
| db.ts | 37 | 13 | 37 | あり | 高（軽減済） |
| response-poller.ts | 3 | 3 | 5 | 未記載 | 中 |
| auto-yes-manager.ts | 11 | 2 | 7 | なし | 中 |
| WorktreeDetailRefactored.tsx | 1 | 0 | 0 | 不要 | 低 |
| prompt-detector.ts | - | 6 | 6 | なし | 低〜中 |
| claude-session.ts | 1 | 2 | 4 | なし | 低 |
| schedule-manager.ts | 0 | 2 | 4 | なし | 低 |

---

## Must Fix（必須対応）

### I001: auto-yes-manager.tsのisValidWorktreeIdが11のAPIルートで使用されている

**カテゴリ**: 依存関係

**問題**:
auto-yes-manager.tsからexportされている `isValidWorktreeId` は汎用バリデーション関数であるにもかかわらず、Auto-Yes機能とは無関係な11のAPIルート（git/log, git/diff, git/show, execution-logs, schedules等）からimportされている。Issueの分割案「ポーリングと状態管理の分離」ではこの関数の配置先が考慮されていない。

**影響ファイル**（11ファイル）:
- `src/app/api/worktrees/[id]/route.ts`
- `src/app/api/worktrees/[id]/prompt-response/route.ts`
- `src/app/api/worktrees/[id]/schedules/route.ts`
- `src/app/api/worktrees/[id]/schedules/[scheduleId]/route.ts`
- `src/app/api/worktrees/[id]/execution-logs/route.ts`
- `src/app/api/worktrees/[id]/execution-logs/[logId]/route.ts`
- `src/app/api/worktrees/[id]/current-output/route.ts`
- `src/app/api/worktrees/[id]/git/log/route.ts`
- `src/app/api/worktrees/[id]/git/diff/route.ts`
- `src/app/api/worktrees/[id]/git/show/[commitHash]/route.ts`

**推奨対応**:
`isValidWorktreeId` を `path-validator.ts` または新規の `worktree-validator.ts` に移動すべき。一時的にauto-yes-manager.tsからre-exportする移行戦略も有効。

---

## Should Fix（推奨対応）

### I002: db.tsテストのモック戦略への影響

**カテゴリ**: テスト

**問題**:
37テストファイルがdb.tsをimportしている。バレルファイル戦略によりimportパス変更は不要だが、`vi.mock('@/lib/db', ...)` でバレル全体をモックする現在のパターンでは、分割後に個別ドメインモジュール単位のモック粒度が活かせない。

**推奨対応**:
テスト戦略に「バレル経由モックの維持」と「将来的な個別モジュールモックへの移行メリット」を明記する。

---

### I003: response-poller.tsにバレルファイル戦略が未適用

**カテゴリ**: 依存関係

**問題**:
db.tsにはバレルファイル戦略が明記されているが、response-poller.tsには記載がない。4ファイルに分割した場合、6つのソースファイルと5つのテストファイル（計11ファイル）のimportパス変更が必要になる。消費者ごとに異なるモジュールからimportするため変更は機械的だが、方針の明記がない。

**推奨対応**:
response-poller.tsにもバレルファイル戦略を適用するか、消費者数が限定的（11ファイル）のため直接importパス変更で対応するかを明記する。

---

### I004: Phase 3内のdb.tsとresponse-poller.tsの実施順序

**カテゴリ**: 依存関係

**問題**:
response-poller.tsはdb.tsから6関数（createMessage, getSessionState, updateSessionState, getWorktreeById, clearInProgressMessageId, markPendingPromptsAsAnswered）をimportしている。両者がPhase 3に分類されているが、同時分割は作業を複雑化させる。

**推奨対応**:
Phase 3内でdb.tsのバレルファイル化を先行し、その後にresponse-poller.tsを分割する順序を明記する。

---

### I005: response-poller.tsのモジュールレベル状態の分割時の整合性

**カテゴリ**: ランタイム

**問題**:
response-poller.ts内にはactivePollers（Map）とTUI accumulator状態がモジュールレベル変数として存在する。4ファイルに分割した場合、stopPolling時にtui-accumulator側の状態もクリアする必要があるか等、モジュール間の状態整合性を設計する必要がある。

**推奨対応**:
分割後のモジュール間での状態管理方針（特にstopPolling時のtui-accumulator清掃の呼び出し関係）を設計に含める。

---

### I006: response-poller.tsのテストファイルと分割後モジュールの対応表

**カテゴリ**: テスト

**問題**:
既存テストが既に機能別に分かれている（response-poller.test.ts, response-poller-opencode.test.ts, response-poller-tui-accumulator.test.ts, resolve-extraction-start-index.test.ts）。分割後モジュール名との対応を明確にすれば効率的。

**推奨対応**:
テスト戦略に対応表を追記:
- `response-poller.test.ts` -> `response-cleaner.test.ts`（テスト対象がclean関数）
- `response-poller-tui-accumulator.test.ts` -> `tui-accumulator.test.ts`
- `resolve-extraction-start-index.test.ts` -> `response-extractor.test.ts`

---

## Nice to Have（あれば良い）

### I007: Phase別PR戦略の定義

**カテゴリ**: CI/CD

**問題**:
3つのPhaseを1つのPRで行うのか、Phase別にPRを分けるのかが未定義。Phase 3は高リスクのため独立PRが望ましい。

---

### I008: ツリーシェイキング改善のメリット明記

**カテゴリ**: ランタイム

**問題**:
db.ts分割後にバレルファイルを廃止し直接importに移行すれば、Next.jsサーバーサイドバンドルのツリーシェイキングが改善される。分割の副次的メリットとして記載すると動機がより明確になる。

---

## 参照ファイル

### コード（主要影響元）
- `src/lib/db.ts`: 43関数export、50消費者
- `src/lib/response-poller.ts`: 15関数export、11消費者
- `src/lib/auto-yes-manager.ts`: isValidWorktreeIdが11 APIルートで使用
- `src/lib/assistant-response-saver.ts`: response-pollerからclean関数のみimport（分割の妥当性を裏付け）

### テスト（主要影響先）
- `tests/unit/`: db.ts関連34ファイル、response-poller関連4ファイル
- `tests/integration/`: db.ts関連20+ファイル
- `src/lib/__tests__/`: db.ts関連3ファイル

### ドキュメント
- `CLAUDE.md`: 主要モジュール一覧の更新が必要（受け入れ基準に追加済み）
