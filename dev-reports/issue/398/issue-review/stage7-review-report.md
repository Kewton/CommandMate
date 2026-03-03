# Issue #398 Stage 7 影響範囲レビューレポート（2回目）

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 2 |

**総合評価**: good

前回（Stage 3）の影響範囲レビューで指摘した8件（IMP-001 -- IMP-008）は全て適切に対応されている。変更対象ファイル、スコープ外ファイル、関連コンポーネントの区分が明確で、各ファイルの変更理由・不変理由が具体的に記載されている。Stage 5で追加されたF2-001/F2-002の反映も影響範囲に新たな問題を生じさせていない。

---

## 前回指摘事項（IMP-001 -- IMP-008）の対応確認

### IMP-001: schedule-manager.ts を将来的影響箇所として追記 -- **resolved**

スコープ外ファイルテーブルに `src/lib/schedule-manager.ts`（L320-331）が追加され、以下が具体的に明記されている:
- スケジュール実行のoptions構築がopencodeケース未対応
- 将来の変更箇所: SQLクエリにopencode用モデル情報取得を追加、options構築にcase 'opencode'を追加

実際のコード（L327-331: `state.entry.cliToolId === 'vibe-local'`の条件分岐のみ）と記載が正確に整合している。

### IMP-002: claude-executor.ts スコープ外を明確化 -- **resolved**

`src/lib/claude-executor.ts`がスコープ外ファイルテーブルに追加され、「スコープ外」として明確に決定済み。理由（OpenCode TUIでのモデル選択で十分）が明記され、受入条件にも「LM Studioモデルのスケジュール実行（非インタラクティブモード）はIssue #398のスコープ外とする」が追加されている。

実際のコード `buildCliArgs()` L113の `ollama/${options.model}` ハードコードと記載が整合。

### IMP-003: 既存テスト移行を実装タスクに追加 -- **resolved**

テストセクションに「既存テスト移行」タスクが追加済み。URLベースのmock実装または`mockResolvedValueOnce()`の2回呼び出しが具体的に記載されている。

実際のテストコード（`tests/unit/cli-tools/opencode-config.test.ts` 298行、`mockFetch`が単一API前提）との整合性を確認した。

### IMP-004: claude-executor.test.ts を影響範囲に追加 -- **resolved**

スコープ外ファイルテーブルに `tests/unit/lib/claude-executor.test.ts` が追加済み。「IMP-002のスコープ外方針により変更不要。将来的にプレフィックスを動的化する場合はテスト修正が必要」と記載。

実際のテスト（L148-150: `['run', '-m', 'ollama/qwen3:8b', 'hello']`の固定値検証）と整合。

### IMP-005: opencode.test.ts を関連コンポーネントに追加 -- **resolved**

関連コンポーネントテーブルに `tests/unit/cli-tools/opencode.test.ts` が追加済み。ensureOpencodeConfig()シグネチャ不変のため変更不要、新規export追加時のmock確認の注記あり。

実際のmock定義（L19-21: `vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }))`）と整合。

### IMP-006: CLAUDE.md 更新タスクを追加 -- **resolved**

実装タスクのドキュメントセクションにCLAUDE.md更新タスクが追加済み。具体的な更新内容（fetchOllamaModels()/fetchLmStudioModels()独立関数化、LM Studio定数追加）が明記されている。

### IMP-007: AgentSettingsPane.tsx 将来的影響を追記 -- **resolved**

関連コンポーネントテーブルに `src/components/worktree/AgentSettingsPane.tsx` が追加済み。将来的なモデルセレクターUI対応時の `/api/lmstudio/models` APIエンドポイント新設の必要性が明記されている。

実際のコード（L111-141: `isVibeLocalChecked`でガードされたOllamaモデル取得ロジック、OpenCode選択時はモデルセレクターなし）と整合。

### IMP-008: types.ts の将来的確認箇所を追記 -- **resolved**

関連コンポーネントテーブルに `src/lib/cli-tools/types.ts` が追加済み。`OLLAMA_MODEL_PATTERN`（L183: `/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/`）がLM StudioモデルID（パス形式・.gguf拡張子含む）とも理論上マッチすることの確認と、DB保存時の将来的再確認推奨が明記されている。

---

## F2-001/F2-002 反映の影響範囲への影響

### F2-001: LM_STUDIO_MODEL_PATTERNパターン具体化 -- 影響範囲変化なし

`/^[a-zA-Z0-9._:/-]{1,200}$/`の具体パターンが追記された。このパターンは`opencode-config.ts`内部でのみ使用され（LM Studio APIレスポンスバリデーション用）、外部ファイルへの影響はない。`types.ts`の`OLLAMA_MODEL_PATTERN`とは独立しており、影響範囲の変化なし。

### F2-002: 戻り値型の統一定義 -- 影響範囲変化なし

`fetchOllamaModels()`/`fetchLmStudioModels()`の戻り値型が`Promise<Record<string, { name: string }>>`として明記された。全て`opencode-config.ts`内部の設計であり、外部インターフェース（`ensureOpencodeConfig()`のシグネチャ: `(worktreePath: string) => Promise<void>`）に変更はない。

---

## Nice to Have（あれば良い）

### IMP2-001: fetchOllamaModels()/fetchLmStudioModels()のexport追加によるモジュール公開APIの拡大

**カテゴリ**: 影響範囲
**場所**: `src/lib/cli-tools/opencode-config.ts` 新規export群

**問題**:
リファクタリング後、現在の4つのexport定数に加え、`fetchOllamaModels()`、`fetchLmStudioModels()`、LM Studio関連定数が新規exportされる。`opencode.test.ts`のmock定義はモジュール全体をmockしているため直接は影響しないが、将来的にこれらの関数を個別にmockする必要が生じる可能性がある。

**推奨対応**:
現状の記載で十分。実装時に新規定数のexport/importが漏れないよう注意する程度で良い。

---

### IMP2-002: opencode-config.test.tsのconstantsセクションにLM Studio定数テストの必要性

**カテゴリ**: テスト
**場所**: `tests/unit/cli-tools/opencode-config.test.ts` L50-62

**問題**:
既存テストのconstantsセクションではOllama関連の3定数をテストしている。LM Studio対応後はLM Studio関連定数のテストも追加すべきだが、Issue本文のテストセクションでは明示的に記載されていない。ただし、`fetchLmStudioModels()`のテスト実装時に自然に定数をimport・検証することになるため、実質的な漏れにはならない。

**推奨対応**:
テストセクションにLM Studio定数値テストを明示的に追加するとより親切だが、必須ではない。

---

## 影響範囲の網羅性確認

### 変更対象ファイル（2ファイル）-- 全てカバー済み

| ファイル | カバー状況 |
|---------|-----------|
| `src/lib/cli-tools/opencode-config.ts` | 完全 |
| `tests/unit/cli-tools/opencode-config.test.ts` | 完全 |

### スコープ外ファイル（3ファイル）-- 全て明記済み

| ファイル | カバー状況 |
|---------|-----------|
| `src/lib/claude-executor.ts` | 完全（スコープ外理由明記） |
| `tests/unit/lib/claude-executor.test.ts` | 完全（スコープ外理由明記） |
| `src/lib/schedule-manager.ts` | 完全（将来的影響箇所として明記） |

### 関連コンポーネント（5ファイル）-- 全て明記済み

| ファイル | カバー状況 |
|---------|-----------|
| `src/lib/cli-tools/opencode.ts` | 完全（変更不要理由明記） |
| `src/lib/cli-tools/types.ts` | 完全（将来的確認箇所明記） |
| `src/components/worktree/AgentSettingsPane.tsx` | 完全（将来的影響明記） |
| `tests/unit/cli-tools/opencode.test.ts` | 完全（変更不要理由明記） |
| `CLAUDE.md` | 完全（更新タスク記載済み） |

### 非影響ファイル -- 確認済み

以下のファイルはIssue #398の変更の影響を受けないことを確認:
- `src/lib/response-poller.ts` -- OpenCode TUI出力パターン検出に影響なし
- `src/lib/cli-patterns.ts` -- OpenCodeパターン定数に影響なし
- `src/lib/status-detector.ts` -- セッションステータス検出に影響なし
- `src/app/api/worktrees/[id]/route.ts` -- types.tsのOLLAMA_MODEL_PATTERNを使用、opencode-config.tsとは独立
- `src/app/api/ollama/models/route.ts` -- 独自のOLLAMA_API_URL定数を使用、opencode-config.tsとは独立
- `src/lib/cli-tools/vibe-local.ts` -- Vibe Local固有のOllama連携、opencode-config.tsの変更の影響なし

### 破壊的変更 -- なし

`ensureOpencodeConfig()`の関数シグネチャ（`(worktreePath: string) => Promise<void>`）は変更されないため、呼び出し元（`opencode.ts` L99）への破壊的変更はない。

---

## 結論

Issue #398の影響範囲記載は十分な品質に達しており、実装開始に適した状態である。前回指摘した8件は全て適切に対応され、F2-001/F2-002の反映も新たな影響範囲の問題を生じさせていない。Must Fix/Should Fixの指摘はなく、2件のNice to Haveのみである。
