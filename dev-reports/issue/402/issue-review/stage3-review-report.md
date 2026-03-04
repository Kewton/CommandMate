# Issue #402 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 4 |

**総合評価**: good

Issue本文は主要な変更対象と呼び出し元を概ね正しく記載しているが、呼び出し元の網羅性、テスト分離性への影響、キャッシュの設計詳細について補完が必要な箇所がある。

---

## Must Fix（必須対応）

### IR-005: キャッシュヒット時の戻り値同一性を受入条件に明記

**カテゴリ**: 後方互換性
**場所**: 受入条件セクション

**問題**:
`detectPrompt()`の戻り値（`PromptDetectionResult`）はキャッシュ有無に関わらず常に同一でなければならないが、現在の受入条件では「プロンプト検出の動作自体（戻り値・副作用）に影響がないこと」としか記載されていない。キャッシュ追加により内部状態を持つモジュールに変わるため、「ログだけスキップし戻り値は不変」という制約を明示的にテスト可能な条件として記載する必要がある。

`detectPrompt()`は以下の5モジュールから呼び出されており、戻り値が少しでも変わると全呼び出し元に影響する:
- `response-poller.ts`（3箇所）
- `auto-yes-manager.ts`（1箇所）
- `status-detector.ts`（1箇所）
- `current-output/route.ts`（1箇所）
- `prompt-response/route.ts`（1箇所）

**証拠**:
```
src/lib/response-poller.ts L779, L953, L1088
src/lib/auto-yes-manager.ts L585
src/lib/status-detector.ts L145
src/app/api/worktrees/[id]/current-output/route.ts L101
src/app/api/worktrees/[id]/prompt-response/route.ts L99
```

**推奨対応**:
受入条件に以下を追加する:
> キャッシュヒット時（ログ抑制時）もdetectPrompt()の戻り値は非キャッシュ時と完全に同一であること

---

## Should Fix（推奨対応）

### IR-001: prompt-response/route.tsが影響範囲表に未記載

**カテゴリ**: 未記載の影響範囲
**場所**: 影響範囲セクション

**問題**:
`src/app/api/worktrees/[id]/prompt-response/route.ts`のL99で`detectPrompt()`を直接呼び出しているが、影響範囲表に記載されていない。キャッシュ方式(B)（worktreeIdパラメータ追加）を採用した場合、このファイルも修正対象となる。

**証拠**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts L99
promptCheck = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
```

**推奨対応**:
影響範囲表に以下を追加:

| ファイル | 変更内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | detectPrompt呼び出し元（影響確認） |

---

### IR-002: response-poller.ts内の呼び出し回数と影響の詳細化

**カテゴリ**: 未記載の影響範囲
**場所**: 影響範囲セクション

**問題**:
`response-poller.ts`内の`detectPromptWithOptions()`ヘルパー関数がdetectPrompt()のラッパーとして機能しており、3箇所（L779, L953, L1088）から呼び出されている。影響範囲表では「ログ出力の呼び出し箇所修正（必要に応じて）」と記載されているが、ログ量への定量的インパクトの説明が不足している。

**証拠**:
```typescript
// src/lib/response-poller.ts
L380: function detectPromptWithOptions(output, cliToolId) {
L385:   return detectPrompt(stripBoxDrawing(stripAnsi(output)), promptOptions);
// 呼び出し箇所:
L779: const promptDetection = detectPromptWithOptions(fullOutput, cliToolId); // extractResponse早期チェック
L953: const promptDetection = detectPromptWithOptions(fullOutput, cliToolId); // extractResponse後半チェック
L1088: const promptDetection = result.promptDetection ?? detectPromptWithOptions(result.response, cliToolId); // checkForResponse
```

**推奨対応**:
影響範囲表のresponse-poller.ts行の変更内容を具体化する。例: 「detectPromptWithOptions()経由で最大3回呼び出し。キャッシュ方式(A)であれば変更不要。ログ削減効果の主要対象。」

---

### IR-003: 既存テストの影響確認が実装タスクに未記載

**カテゴリ**: テスト影響
**場所**: 実装タスクセクション

**問題**:
以下の既存テストファイルが`detectPrompt`を直接・間接的にテストしている:
- `tests/unit/prompt-detector.test.ts` - 直接import
- `tests/unit/lib/status-detector.test.ts` - detectSessionStatus()経由
- `tests/unit/lib/auto-yes-manager.test.ts` - detectAndRespondToPrompt()経由
- `tests/integration/issue-256-acceptance.test.ts` - 直接import
- `tests/integration/issue-208-acceptance.test.ts` - 直接import

キャッシュ追加によりモジュールスコープに状態が生まれるため、テスト間でキャッシュが共有され、テスト順序に依存した偽の成功/失敗が発生する可能性がある。

**推奨対応**:
実装タスクに以下を追加:
- `[ ]` 既存テストの影響確認（キャッシュ状態のテスト間リセット）
- キャッシュリセット関数（例: `resetDetectPromptCache()`）を `@internal` エクスポートし、テストのbeforeEach/afterEachで呼び出す設計

---

### IR-006: CLAUDE.mdのモジュール説明更新が未記載

**カテゴリ**: 後方互換性
**場所**: 影響範囲セクション

**問題**:
CLAUDE.mdの「主要機能モジュール」セクションに`prompt-detector.ts`の詳細説明があるが、キャッシュ機構追加時の更新が影響範囲に含まれていない。

**推奨対応**:
影響範囲表にCLAUDE.mdを追加:

| ファイル | 変更内容 |
|---------|---------|
| `CLAUDE.md` | prompt-detector.tsのモジュール説明にキャッシュ機構の記載を追加 |

---

### IR-008: SF-001トレードオフのキャッシュ解消効果の明記

**カテゴリ**: 変更波及範囲
**場所**: 影響範囲セクション

**問題**:
`status-detector.ts`のSF-001設計トレードオフ（detectPromptの2重呼び出し）について、背景・課題セクションで言及されているが、キャッシュ方式(A)を採用した場合にこの2重呼び出しのログが自動的に抑制される効果が影響範囲表に明記されていない。

`current-output/route.ts`では:
1. L87: `detectSessionStatus(output, cliToolId)` -> 内部で`detectPrompt()`呼び出し
2. L101: `detectPrompt(stripBoxDrawing(cleanOutput), promptOptions)` -> 同一リクエスト内の2回目

キャッシュにより2回目はログスキップされるため、SF-001のコスト（ログ重複）が実質解消される。

**推奨対応**:
影響範囲表のstatus-detector.ts行に「SF-001による2重呼び出し分のログがキャッシュにより自然に抑制される（コード変更不要）」を追記する。

---

## Nice to Have（あれば良い）

### IR-004: ハッシュ計算対象の最適化指針

**カテゴリ**: パフォーマンス影響
**場所**: キャッシュ設計方針セクション

**問題**:
キャッシュ方式(A)でoutput全体のハッシュを計算する場合、最大10,000行のテキストに対するハッシュ計算が毎回発生する。`detectPrompt()`内部ではyes/noパターンは末尾20行、multiple_choiceは末尾50行のウィンドウのみを検査するため、ハッシュ対象をこの範囲に限定する最適化が可能。

**推奨対応**:
キャッシュキーの設計候補として「output末尾50行のハッシュ（detectPromptのスキャンウィンドウと一致）」を選択肢に追加する。

---

### IR-007: キャッシュエントリのライフサイクル管理

**カテゴリ**: パフォーマンス影響
**場所**: キャッシュ設計方針セクション

**問題**:
モジュールスコープキャッシュの長期運用時のメモリリスクについて記載がない。方式(A)で前回値1エントリのみ保持なら問題ないが、方式(B)でworktreeId単位の場合はworktree削除時のクリーンアップが必要。

**推奨対応**:
キャッシュ設計方針に「エントリ数の上限またはTTL方針」を補足する。方式(A)で前回値のみ保持の場合は問題ないことも明記すると設計意図が明確になる。

---

### IR-009: ログ出力テストの技術的制約

**カテゴリ**: テスト影響
**場所**: 実装タスクセクション

**問題**:
ログ出力の抑制をテストするには、logger.tsのconsole出力をキャプチャする必要がある。テスト方式（`vi.spyOn(console, 'log')`等）の指針が記載されていない。

**推奨対応**:
実装タスクのテスト関連項目に、テスト方式の候補を補足する。

---

### IR-010: 抑制対象ログ箇所の優先順位

**カテゴリ**: 変更波及範囲
**場所**: 実装タスクセクション

**問題**:
`detectPrompt()`内のログ出力は3箇所のみ:
- L171: `logger.debug('detectPrompt:start')` -- 全呼び出しで出力（主要抑制対象）
- L216: `logger.debug('detectPrompt:complete')` -- プロンプト未検出時に出力（主要抑制対象）
- L185-189: `logger.info('detectPrompt:multipleChoice')` -- 新プロンプト検出時のみ（抑制対象外）

L185のmultipleChoiceログは新規プロンプト検出時のみ出力されるため抑制対象外とすべきだが、この優先順位がIssue本文に記載されていない。

**推奨対応**:
実装タスクに「抑制対象: L171 debug + L216 debug。L185 infoは新規プロンプト検出ログのため抑制対象外」と補足する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/prompt-detector.ts` | 主要変更対象。logger呼び出しはL171, L185-189, L216の3箇所 |
| `src/lib/response-poller.ts` | detectPromptWithOptions()経由で3箇所でdetectPrompt()呼び出し |
| `src/lib/auto-yes-manager.ts` | detectAndRespondToPrompt()でdetectPrompt()呼び出し |
| `src/lib/status-detector.ts` | detectSessionStatus()でdetectPrompt()呼び出し |
| `src/app/api/worktrees/[id]/current-output/route.ts` | detectSessionStatus()経由+直接の2箇所で呼び出し |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | L99でdetectPrompt()を直接呼び出し（影響範囲表に未記載） |
| `src/lib/logger.ts` | ログレベル制御の基盤 |
| `tests/unit/prompt-detector.test.ts` | 既存テスト（キャッシュ追加時にテスト分離性への影響あり） |
| `tests/unit/lib/status-detector.test.ts` | 既存テスト（detectSessionStatus経由の間接影響） |
| `tests/unit/lib/auto-yes-manager.test.ts` | 既存テスト（detectAndRespondToPrompt経由の間接影響） |
| `tests/integration/issue-256-acceptance.test.ts` | 既存テスト（detectPrompt直接import） |
| `tests/integration/issue-208-acceptance.test.ts` | 既存テスト（detectPrompt直接import） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | prompt-detector.tsのモジュール説明の更新が必要 |
