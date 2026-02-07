# Issue #180 レビューレポート - Stage 7

**レビュー日**: 2026-02-07
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目
**Issue タイトル**: fix: ステータス表示の不整合 - CLIがidle状態でもrunning/waitingと誤表示

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 1 |

**総合評価**: Issue #180 の影響範囲分析は非常に良好な状態にある。前回の影響範囲レビュー（Stage 3）で指摘した11件の全指摘事項がほぼ完全に反映されている。detectPrompt() コールマップの全11箇所の行番号は実コードと正確に一致しており、方式A/B/Cの影響ファイル一覧も正しい。今回の新規発見は軽微なもののみである。

---

## 前回指摘事項の反映状況

### 完全に反映済み（9件）

| 前回ID | 内容 | 状態 |
|--------|------|------|
| S3-001 | status-detector.ts の影響範囲追加 | 反映済み |
| S3-002 | response-poller.ts / claude-poller.ts の追加 | 反映済み |
| S3-003 | current-output/route.ts / useAutoYes.ts の追加 | 反映済み |
| S3-004 | prompt-response/route.ts の追加 | 反映済み |
| S3-005 | 方式A/B/C影響ファイル一覧の追加 | 反映済み |
| S3-007 | route.ts と status-detector.ts の前処理不一致 | 反映済み |
| S3-008 | detectThinking() の呼び出し箇所ごとの入力範囲不一致 | 反映済み |
| S3-009 | UI表示確認項目の追加 | 反映済み |
| S3-011 | status-detector.ts の既存実装活用の検討 | 反映済み |

### 概ね反映済み（2件）

| 前回ID | 内容 | 状態 | 残課題 |
|--------|------|------|--------|
| S3-006 | テスト要件の追加 | 概ね反映 | cli-patterns.test.ts が1ファイルのみ参照（S7-001） |
| S3-010 | claude-poller.ts のレガシー判定 | 概ね反映 | 実際の使用状況の記載が不正確（S7-002） |

---

## detectPrompt() コールマップ検証結果

Issue に記載されたコールマップの全行番号を実コードと照合した結果、全11箇所が正確であることを確認した。

| ファイル | Issue記載の行番号 | 実際の行番号 | 結果 |
|---------|-----------------|-------------|------|
| `src/app/api/worktrees/route.ts` | 行62 | 行62 | 一致 |
| `src/app/api/worktrees/[id]/route.ts` | 行62 | 行62 | 一致 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 行88 | 行88 | 一致 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 行75 | 行75 | 一致 |
| `src/lib/response-poller.ts` | 行248, 行442, 行556 | 行248, 行442, 行556 | 一致 |
| `src/lib/claude-poller.ts` | 行164, 行232 | 行164, 行232 | 一致 |
| `src/lib/auto-yes-manager.ts` | 行290 | 行290 | 一致 |
| `src/lib/status-detector.ts` | 行80 | 行80 | 一致 |

**網羅性**: `src/` 配下の `detectPrompt()` 呼び出し全箇所（定義・コメント除く11箇所）がコールマップに含まれていることを `grep` で確認済み。

---

## Should Fix（推奨対応）

### S7-001: cli-patterns テストファイルの参照が不完全

**カテゴリ**: 影響範囲
**場所**: 受け入れ条件 > テスト要件 > 条件11 および テストファイルセクション

**問題**:
Issue では `src/lib/__tests__/cli-patterns.test.ts` のみを記載しているが、`tests/unit/lib/cli-patterns.test.ts` にも `detectThinking` のテストが存在する（行142-161: Codex, Claude, Gemini の detectThinking テスト）。この2つ目のテストファイルが受け入れ条件のテスト要件（条件11）に含まれていない。

**証拠**:
- `src/lib/__tests__/cli-patterns.test.ts` 行134-144: Claude の detectThinking テスト
- `tests/unit/lib/cli-patterns.test.ts` 行142-161: Codex/Claude/Gemini の detectThinking テスト（この追加テストは Issue #4 で追加された Codex 固有パターンのテストを含む）

**推奨対応**:
受け入れ条件11を「`src/lib/__tests__/cli-patterns.test.ts` および `tests/unit/lib/cli-patterns.test.ts` - detectThinking テストがパスすること」に修正する。テストファイルセクションにも `tests/unit/lib/cli-patterns.test.ts` を追加する。

---

### S7-002: claude-poller.ts のレガシー判定の記載が不正確

**カテゴリ**: 影響範囲
**場所**: detectPrompt() コールマップ > claude-poller.ts 注記

**問題**:
Issue では「claude-poller.ts はレガシーポーラーの可能性がある。実際に使用されているかを設計時に確認し、不要であれば修正対象から除外して後日の廃止候補として記録すること」と記載しているが、実際には以下の2ファイルから import されている:

- `src/lib/session-cleanup.ts` 行11: `import { stopPolling as stopClaudePolling } from './claude-poller';`
- `src/lib/cli-tools/manager.ts` 行11: `import { stopPolling as stopClaudePolling } from '../claude-poller';`

つまり `stopPolling` 関数は使用されている。一方、`startPolling` はどこからも呼ばれておらず（`response-poller.ts` の `startPolling` のみが `send/route.ts`, `respond/route.ts`, `start-polling/route.ts` から呼ばれている）、ポーリングのメインパスでは `response-poller.ts` が使用されている。

この状況から、`claude-poller.ts` の `detectPrompt()` 呼び出し（行164, 行232）は `startPolling` が呼ばれない限り到達しないため、実質的には修正不要である。しかし「使用されているかを確認」という記載は不正確であり、設計時に混乱を招く可能性がある。

**推奨対応**:
claude-poller.ts に関する注記を以下に更新する:
「claude-poller.ts は session-cleanup.ts および cli-tools/manager.ts から stopPolling が import されているため、完全に未使用ではない。ただし startPolling は呼び出されておらず、ポーリングのメインパスでは response-poller.ts が使用されている。detectPrompt() の呼び出し（行164, 232）はポーリングが開始されない限り到達しないため、修正の優先度は低い。」

---

## Nice to Have（あれば良い）

### S7-003: current-output/route.ts の thinking 検出と detectPrompt の入力スコープの非対称性

**カテゴリ**: 影響範囲
**場所**: detectPrompt() コールマップ > current-output/route.ts 行

**問題**:
`current-output/route.ts` において、thinking 検出（行83）は `lastSection`（最後15行の非空行）に対して行われているが、detectPrompt（行88）は `cleanOutput`（全文）に対して呼ばれている。この非対称性により、thinking インジケーターが15行以上前に表示されている場合（出力が活発に進行中で thinking が画面上部にスクロールした場合など）、thinking 検出が false を返し、detectPrompt がスキップされずに全文に対して呼ばれる可能性がある。

**補足**:
これは既存の Issue #161 の設計と一致しており、thinking 検出は「最近の出力」に限定されることが意図されている可能性が高い。また、この Issue #180 の修正により detectPrompt の検索範囲が末尾に限定されれば、この非対称性の実質的な影響は軽減される。

**推奨対応**:
設計検討事項として記載を検討する。緊急性は低い。

---

## 設計方式（A/B/C）の影響範囲検証

Issue に記載された各方式の影響ファイル一覧を実コードに基づいて検証した。

| 方式 | 変更対象ファイル | 検証結果 |
|------|-----------------|---------|
| **(A)** | `route.ts` x2 のみ | 正確。route.ts の行62 のみ変更で、他の呼び出し元には影響しない |
| **(B)** | `detectPrompt()` を呼ぶ全8ファイル | 正確。呼び出し元8ファイル（route.ts x2, current-output/route.ts, prompt-response/route.ts, response-poller.ts, claude-poller.ts, auto-yes-manager.ts, status-detector.ts）全てが影響を受ける |
| **(C)** | 方式Bと同範囲 | 正確。方式Bと同じ8ファイルに影響 |

**注記**: response-poller.ts の3箇所の detectPrompt() 呼び出しの個別分析の必要性（行248/442 vs 行556 の入力データの性質の違い）が正しく記載されている。

---

## 受け入れ条件の網羅性

| 条件 | 内容 | 評価 |
|------|------|------|
| 1-4 | 機能要件（ステータス表示の正確性） | 適切 |
| 5 | 回帰テスト | 適切（条件7-11で具体化） |
| 6 | 両route.tsへの修正適用 | 適切（共通関数化の補足あり） |
| 7 | prompt-detector.test.ts | 適切 |
| 8 | auto-yes-manager.test.ts | 適切 |
| 9 | prompt-response-verification.test.ts | 適切 |
| 10 | status-detector.test.ts | 適切 |
| 11 | cli-patterns.test.ts | 不完全（S7-001: 1ファイル欠落） |
| 12-14 | UI表示確認 | 適切 |

---

## 参照ファイル

### コード（検証済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/app/api/worktrees/route.ts`: ステータス検出ロジック（行47-111）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/app/api/worktrees/[id]/route.ts`: 同一のステータス検出ロジック（行47-111）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/prompt-detector.ts`: detectPrompt() 定義（行44）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/response-poller.ts`: detectPrompt() 呼び出し3箇所（行248, 442, 556）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/claude-poller.ts`: detectPrompt() 呼び出し2箇所（行164, 232）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/auto-yes-manager.ts`: detectPrompt() 呼び出し（行290）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/status-detector.ts`: detectPrompt() 呼び出し（行80）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/app/api/worktrees/[id]/current-output/route.ts`: detectPrompt() 呼び出し（行88）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/app/api/worktrees/[id]/prompt-response/route.ts`: detectPrompt() 呼び出し（行75）

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/prompt-detector.test.ts`: detectPrompt 直接テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/lib/auto-yes-manager.test.ts`: pollAutoYes thinking スキップテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/api/prompt-response-verification.test.ts`: プロンプト再検証テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/__tests__/status-detector.test.ts`: status-detector テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/__tests__/cli-patterns.test.ts`: cli-patterns テスト（Claude detectThinking）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/tests/unit/lib/cli-patterns.test.ts`: cli-patterns テスト（Codex/Claude/Gemini detectThinking -- Issue記載漏れ）
