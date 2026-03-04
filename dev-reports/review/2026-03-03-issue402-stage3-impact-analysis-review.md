# Issue #402 Stage 3: Impact Analysis Review

## Executive Summary

Issue #402 の設計方針書に対する影響分析レビューを実施した。`prompt-detector.ts` へのモジュールスコープキャッシュ追加（`lastOutputTail`）による波及効果を、既存テスト、Hot Reload、マルチプロセス環境、呼び出し元モジュール、パフォーマンス、統合テストの6つの観点から分析した。

**結論**: 設計方針書の影響分析は正確で網羅的であり、変更のリスクは低い。should_fix 3件はすべてテスト分離に関する推奨事項であり、実装時の対応で解決可能。

| 評価 | 結果 |
|------|------|
| ステータス | **Approved** |
| スコア | **4/5** |
| Must Fix | 0件 |
| Should Fix | 3件 |
| Nice to Have | 6件 |

---

## 影響分析詳細

### 1. 既存テストへの影響

#### 分析対象

| テストファイル | detectPrompt 使用方法 | キャッシュ影響 |
|--------------|---------------------|-------------|
| `tests/unit/prompt-detector.test.ts` | 直接呼び出し（実モジュール） | あり |
| `tests/unit/lib/status-detector.test.ts` | detectSessionStatus() 経由（実モジュール） | あり |
| `tests/unit/api/prompt-response-verification.test.ts` | vi.mock() でモック化 | なし |
| `tests/integration/issue-256-acceptance.test.ts` | 直接呼び出し（実モジュール） | あり |
| `tests/integration/issue-208-acceptance.test.ts` | 直接呼び出し（実モジュール） | あり |

#### 分析結果

**prompt-detector.test.ts** [S3-001 should_fix]:
現在のテストは `detectPrompt()` の戻り値（`isPrompt`, `promptData`, `cleanContent`, `rawContent`）のみを検証しており、ログ出力の検証は含まない。設計制約 D4-001 により戻り値は不変であるため、テスト結果の正否には影響しない。しかし、テスト間で `lastOutputTail` キャッシュが共有されるため、`beforeEach` での `resetDetectPromptCache()` 呼び出しが必要。設計方針書セクション8で対応方針は記載済みだが、実装チェックリストに明示すべき。

**status-detector.test.ts** [S3-009 should_fix]:
`detectSessionStatus()` 経由で実際の `detectPrompt()` を呼び出している。テストは `status`, `confidence`, `reason`, `hasActivePrompt` を検証しており、ログ出力は検証していない。テスト結果への直接影響はないが、テスト分離のベストプラクティスとして `resetDetectPromptCache()` の追加を推奨。

**prompt-response-verification.test.ts**:
`vi.mock('@/lib/prompt-detector')` で `detectPrompt` をモック化しているため、`lastOutputTail` キャッシュの影響を完全に受けない。追加対応不要。

### 2. Hot Reload 時の挙動 [S3-002 nice_to_have]

| 観点 | 分析 |
|------|------|
| リセット発生 | Hot Reload により `lastOutputTail` が `null` にリセットされる |
| 機能影響 | なし。直後の1回の呼び出しでログが出力されるが、新規output時と同じ動作 |
| `globalThis` パターンの必要性 | 不要。`auto-yes-manager.ts` がglobalThisを使用するのはポーリングタイマーの維持とUI状態の一貫性のため。ログ抑制目的の `lastOutputTail` は異なる要件 |
| 最悪ケース | 変更前と同等のログ量が1回出力されるだけ |
| 参照パターン | `ip-restriction.ts` のモジュールスコープキャッシュ（`cachedRanges`）と同パターン |

設計方針書セクション4 D1 で根拠が正しく説明されている。

### 3. マルチプロセス環境 [S3-003 should_fix]

| 環境 | キャッシュ共有 | 影響 |
|------|-------------|------|
| Next.js 単一プロセス（標準） | プロセス内で共有される | 設計通り |
| Next.js クラスタモード | プロセス間で非共有 | 各プロセス独立にキャッシュ。影響なし |
| サーバーレス環境（Vercel等） | Lambda間で非共有 | CommandMateの対象外（ローカル開発ツール） |

CommandMate はローカル開発ツールとして単一プロセスでの動作を前提としている。複数worktreeの同時アクティブ監視では、異なるworktreeからの呼び出しがキャッシュを交互に上書きしてヒット率が低下するが、設計方針書 DC-001 で分析されている通り、最悪ケースでも変更前と同等のログ量に留まる。

### 4. 他モジュールへの波及

#### 直接呼び出し元の影響分析

```
detectPrompt() 呼び出し元（7箇所）:
  response-poller.ts        -> detectPromptWithOptions() 経由で最大3回/cycle
  auto-yes-manager.ts       -> detectAndRespondToPrompt() 経由で1回/cycle
  status-detector.ts        -> detectSessionStatus() 経由で1回/request
  current-output/route.ts   -> SF-001の2回目呼び出しで1回/request
  prompt-response/route.ts  -> プロンプト再検証で1回/event
```

| モジュール | 戻り値依存 | ログ依存 | 影響 |
|-----------|-----------|---------|------|
| `response-poller.ts` [S3-005] | isPrompt, promptData, cleanContent, rawContent を使用 | なし | **影響なし** |
| `auto-yes-manager.ts` [S3-006] | isPrompt, promptData を使用。isDuplicatePrompt() で独自のキャッシュ管理 | なし | **影響なし** |
| `status-detector.ts` [S3-004] | isPrompt のみ使用 | なし | **影響なし** (SF-001 二重呼び出しはキャッシュヒットで自然に抑制) |
| `current-output/route.ts` [S3-004] | isPrompt, promptData を使用 | なし | **影響なし** |
| `prompt-response/route.ts` | isPrompt, promptData を使用 | なし | **影響なし** |

設計制約 D4-001（戻り値不変）と D4-002（ログ抑制のみ、検出ロジック不変）により、すべての呼び出し元への波及影響はゼロである。

#### status-detector.ts SF-001 二重呼び出しの詳細分析

`current-output/route.ts` は以下の順序で処理を行う:

1. `detectSessionStatus(output, cliToolId)` を呼び出し (内部で `detectPrompt(stripBoxDrawing(cleanOutput), promptOptions)`)
2. `detectPrompt(stripBoxDrawing(cleanOutput), promptOptions)` を直接呼び出し (SF-001)

両呼び出しは同一HTTPリクエスト処理内で同期的に発生し、同一の引数が渡されるため、2回目は確実にキャッシュヒットする。これによりSF-001の二重呼び出しで発生していた重複ログが自然に解消される。

### 5. パフォーマンスへの影響 [S3-007 nice_to_have]

| 指標 | コスト | 分析 |
|------|-------|------|
| `lines.slice(-50).join('\n')` | 数マイクロ秒 | `output.split('\n')` は既存コード（L173）で実行済み。lines変数の共有により追加split不要 |
| 文字列比較（最大10KB） | 数マイクロ秒 | V8のバイト列比較最適化。10KB程度は無視できるレベル |
| ログI/O削減 | 数百マイクロ秒~数ミリ秒 x 12行/cycle | JSON.stringify + console + ファイル書き込みの累積コスト削減 |
| 正味効果 | **大幅なI/O削減** | 文字列比較コスト << ログI/O削減効果 |

設計方針書セクション7の分析通り、キャッシュ効率は以下の通り:
- ユーザー未応答時（同一プロンプト表示中）: 100%キャッシュヒット
- thinking/応答処理中: キャッシュミス（出力が変化するため。これは正常動作）
- SF-001二重呼び出し: 確実にキャッシュヒット

### 6. 既存統合テストへの影響 [S3-008 nice_to_have]

**issue-256-acceptance.test.ts**:
- 13個のシナリオ（AC1-AC13）で `detectPrompt()` を直接呼び出し
- すべて戻り値の `isPrompt`, `promptData.type`, `promptData.options` を検証
- ログ出力の検証なし
- D4-001 により戻り値不変のためテスト結果に影響なし
- キャッシュ共有によるログ抑制はテストデバッグ時の可視性に軽微な影響

**issue-208-acceptance.test.ts**:
- 5個の受け入れ基準（AC1-AC5）で `detectPrompt()` を直接呼び出し
- すべて戻り値の `isPrompt` と `promptData` を検証
- ログ出力の検証なし
- D4-001 により戻り値不変のためテスト結果に影響なし

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| テスト分離 | キャッシュ共有によるテスト間干渉 | Low | Med | P2 |
| 機能劣化 | 戻り値変更による既存機能への影響 | High | Low (D4-001で防止) | P3 |
| パフォーマンス | 文字列比較のCPU負荷 | Low | Low | P3 |
| Hot Reload | 開発環境でのキャッシュリセット | Low | Low | P3 |
| マルチworktree | キャッシュヒット率低下 | Low | Med | P3 |

---

## 改善推奨事項

### Should Fix (3件)

**S3-001**: `tests/unit/prompt-detector.test.ts` の beforeEach に `resetDetectPromptCache()` を追加する。設計方針書セクション12の実装チェックリストにこの項目を明示する。

**S3-003**: DC-001の記述に「CommandMateはローカル単一プロセスでの動作を前提としており、サーバーレス/クラスタ環境は対象外」という前提を追加する。

**S3-009**: `tests/unit/lib/status-detector.test.ts` に `resetDetectPromptCache()` のインポートと beforeEach での呼び出しを追加する。実装チェックリストにこの項目を追加する。

### Nice to Have (6件)

**S3-002**: `lastOutputTail` のコードコメントに「Hot Reload時にリセットされるが機能影響なし」の一文を追加する。

**S3-004**: 追加対応不要。SF-001二重呼び出しのキャッシュヒット分析は正確。

**S3-005**: 追加対応不要。response-poller.ts への影響はゼロ。

**S3-006**: 追加対応不要。auto-yes-manager.ts への影響はゼロ。

**S3-007**: 追加対応不要。パフォーマンストレードオフの分析は妥当。

**S3-008**: 統合テストファイルに `resetDetectPromptCache()` の beforeEach 追加を検討（オプション）。

---

## 承認ステータス

**Approved** - 設計方針書の影響分析は全体的に正確で網羅的である。変更は `prompt-detector.ts` のモジュールスコープに閉じており、`detectPrompt()` の戻り値に影響しない設計制約（D4-001/D4-002）が明確に定義されている。should_fix の3件はいずれもテスト分離に関する実装時の対応事項であり、設計方針の変更は不要。

---

*Generated by architecture-review-agent for Issue #402 Stage 3*
*Review date: 2026-03-03*
