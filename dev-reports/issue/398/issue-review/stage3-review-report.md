# Issue #398 影響範囲レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 6 |
| Nice to Have | 3 |

**総評**: Issue #398 の影響範囲記載は主要な変更対象（`opencode-config.ts`）と直接の呼び出し元（`opencode.ts`）を正しくカバーしている。Stage 1 レビューの MF-004 対応で `claude-executor.ts` も追加されたが、対応方針が曖昧なまま残っている。最も重要な2つの指摘は、`schedule-manager.ts` の options 構築ロジック漏れ（IMP-001）と `buildCliArgs()` の `ollama/` プレフィックス問題の方針未確定（IMP-002）である。テスト面では既存テストの修正必要性が Issue に未記載である点（IMP-003）も重要。

---

## Must Fix（必須対応）

### IMP-001: schedule-manager.ts の executeSchedule() が opencode 向けモデルオプションを構築しない

**カテゴリ**: 影響範囲
**場所**: `src/lib/schedule-manager.ts` L320-331

**問題**:

`schedule-manager.ts` の `executeSchedule()` 関数（L327-331）で options を構築する際、`cliToolId === 'vibe-local'` の場合のみ `worktree.vibe_local_model` を model オプションとして渡している。

```typescript
// schedule-manager.ts L327-331（現在の実装）
const options: ExecuteCommandOptions | undefined =
  state.entry.cliToolId === 'vibe-local' && worktree.vibe_local_model
    ? { model: worktree.vibe_local_model }
    : undefined;
```

`cliToolId === 'opencode'` の場合は options が `undefined` になるため、`buildCliArgs()` の opencode ケースで `options.model` が常に falsy となる。つまり、スケジュール実行時にモデル指定ができない。

さらに、L320 の SQL クエリ（`SELECT path, vibe_local_model FROM worktrees WHERE id = ?`）も vibe-local 専用であり、将来 OpenCode 用のモデル情報を DB に保存する場合はクエリ拡張が必要。

**推奨対応**:

Issue の影響範囲セクションに `schedule-manager.ts` L327-331 を「将来的影響箇所」として追記する。現スコープでは opencode の TUI モード（`opencode.json` 経由）でのモデル選択がメインであり、スケジュール実行での LM Studio モデル指定がスコープ外であることを明記する。

---

### IMP-002: claude-executor.ts buildCliArgs() の ollama/ プレフィックス問題の対応方針が不明確

**カテゴリ**: 影響範囲
**場所**: `src/lib/claude-executor.ts` L110-115, Issue本文 > 影響範囲対応セクション

**問題**:

Issue 本文の「影響範囲対応」セクションの記載が以下のように曖昧である:

> `src/lib/claude-executor.ts`: `buildCliArgs()`のopencode caseで`ollama/`プレフィックスがハードコードされている（L110-115）ため、LM Studioモデル対応が必要か検討し対応する（スコープ外とする場合はその旨を明記）

`buildCliArgs()` の該当コード:

```typescript
// claude-executor.ts L110-115
case 'opencode':
  if (options?.model) {
    return ['run', '-m', `ollama/${options.model}`, message];
  }
  return ['run', message];
```

`ollama/` プレフィックスがハードコードされているため、LM Studio モデルを指定する場合は `lmstudio/` プレフィックスが必要になる可能性がある。しかし、OpenCode CLI の `-m` オプションがどのようなプレフィックス形式を受け付けるかの仕様確認が Issue 内でなされていない。

**推奨対応**:

以下の2択のいずれかを Issue 内で明確に決定する:

**(A) スコープ外とする場合（推奨）**: 受入条件に以下を追記する:
> 「スケジュール実行での LM Studio モデル指定は Issue #398 のスコープ外。`opencode run -m` は現状 `ollama/` プレフィックスのみ対応し、LM Studio モデルのスケジュール実行は将来 Issue で対応する」

**(B) スコープ内とする場合**: `ExecuteCommandOptions` に `provider` フィールドを追加し、`buildCliArgs()` でプロバイダーに応じたプレフィックスを動的に設定する設計を実装タスクに追加する。

---

## Should Fix（推奨対応）

### IMP-003: 既存テスト opencode-config.test.ts の全テストケースが Ollama 単独前提で記述

**カテゴリ**: テスト
**場所**: `tests/unit/cli-tools/opencode-config.test.ts` 全体（298行）

**問題**:

既存テストの `ensureOpencodeConfig()` テストケースは全て `mockFetch` が単一の Ollama API エンドポイントのみを前提に記述されている。リファクタリング後に以下の影響が発生する:

1. `mockFetch` が 2 回呼ばれるようになり、`mockResolvedValue` の設定が不十分になる
2. 「Ollama API timeout (non-fatal)」テスト等で `writeFileSync` が呼ばれない検証は、LM Studio が成功すれば呼ばれるようになり、テストが壊れる
3. config JSON の構造検証で `provider.ollama` のみを検証しているが、`provider.lmstudio` の検証も必要

Issue 本文ではテスト追加は記載されているが、既存テストの修正必要性が明記されていない。

**推奨対応**:

実装タスクのテストセクションに以下を追加: 「既存の `ensureOpencodeConfig()` テストケースを `fetchOllamaModels()`/`fetchLmStudioModels()` の独立関数テストに分割・移行する。結合テストでは両方の `mockFetch` を URL に基づいて異なるレスポンスを返す mock 実装を使用する」

---

### IMP-004: claude-executor.test.ts の buildCliArgs opencode テストケースの影響確認

**カテゴリ**: テスト
**場所**: `tests/unit/lib/claude-executor.test.ts` L143-156

**問題**:

以下のテストが `ollama/` プレフィックスの固定値を検証している:

```typescript
// claude-executor.test.ts L148-150
it('should build opencode args with -m when model is specified', () => {
  const args = buildCliArgs('hello', 'opencode', undefined, { model: 'qwen3:8b' });
  expect(args).toEqual(['run', '-m', 'ollama/qwen3:8b', 'hello']);
});
```

IMP-002 の方針次第でこのテストの修正が必要になる。

**推奨対応**:

影響範囲テーブルに `tests/unit/lib/claude-executor.test.ts` を追加する。

---

### IMP-005: opencode.test.ts の ensureOpencodeConfig モックへの影響

**カテゴリ**: 未記載依存
**場所**: `tests/unit/cli-tools/opencode.test.ts` L18-21

**問題**:

opencode-config モジュール全体を mock しており、`ensureOpencodeConfig` を `vi.fn()` で置き換えている。関数シグネチャ自体は変更されないため影響は低いが、`opencode-config.ts` から新規 export が追加される場合は mock 定義の更新が必要になる可能性がある。

**推奨対応**:

影響範囲の「関連コンポーネント」に `tests/unit/cli-tools/opencode.test.ts` を注記付きで追加する。

---

### IMP-006: CLAUDE.md の opencode-config.ts モジュール説明の更新タスクが未追加

**カテゴリ**: ドキュメント
**場所**: `CLAUDE.md` L165

**問題**:

CLAUDE.md の `opencode-config.ts` エントリ:

> `ensureOpencodeConfig()`でOllama API/api/tagsからモデル取得→opencode.json生成

LM Studio 対応後は以下に更新が必要:

> `ensureOpencodeConfig()`でOllama API/api/tags + LM Studio OpenAI互換API /v1/models からモデル取得→opencode.json生成。fetchOllamaModels()/fetchLmStudioModels()独立関数化。LM_STUDIO_API_URL/LM_STUDIO_BASE_URL/LM_STUDIO_MODEL_PATTERN/MAX_LM_STUDIO_MODELS定数追加

Stage 1 の NTH-002 で指摘済みだが、Issue 本文にはまだ実装タスクとして反映されていない。

**推奨対応**:

実装タスクに「CLAUDE.md の `opencode-config.ts` エントリを更新する」タスクを明示的に追加する。

---

### IMP-007: AgentSettingsPane の OpenCode 向けモデルセレクター UI のスコープ確認

**カテゴリ**: 影響範囲
**場所**: `src/components/worktree/AgentSettingsPane.tsx` L111-141

**問題**:

現在の AgentSettingsPane は `isVibeLocalChecked` でガードされており、OpenCode 選択時にモデルセレクターを表示しない。Issue 本文では「今回スコープ外」と正しく記載されている。しかし、将来的に OpenCode 向けモデルセレクター UI を追加する場合、以下が必要:

- `/api/lmstudio/models` API エンドポイントの新設（または `/api/ollama/models` を `/api/local-models` に汎用化）
- AgentSettingsPane に opencode 選択時のモデルセレクター追加

**推奨対応**:

影響範囲の「関連コンポーネント」セクションに将来的影響を注記する。

---

### IMP-008: OLLAMA_MODEL_PATTERN（types.ts）と LM Studio モデル ID の互換性

**カテゴリ**: 影響範囲
**場所**: `src/lib/cli-tools/types.ts` L183, `src/app/api/worktrees/[id]/route.ts` L246

**問題**:

`types.ts` の `OLLAMA_MODEL_PATTERN`（`/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/`）は vibeLocalModel のバリデーションにも使用されている。LM Studio モデル ID は `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/...gguf` のようなパス形式を含む可能性がある。現パターンはドットとスラッシュを許容するため理論上はマッチするが、将来 DB に LM Studio モデルを保存する場合は再確認が必要。

**推奨対応**:

Issue の影響範囲に「将来的確認箇所」として追記する。

---

## Nice to Have（あれば良い）

### IMP-009: opencode.ts startSession() の ensureOpencodeConfig() 実行時間増加

**カテゴリ**: 影響範囲
**場所**: `src/lib/cli-tools/opencode.ts` L97-99

`ensureOpencodeConfig()` の実行時間が最大6秒（Ollama 3秒 + LM Studio 3秒）に増加する可能性があるが、`OPENCODE_INIT_WAIT_MS`（15秒）内に収まるため影響なし。「関連コンポーネント」に補足を追記するとより親切。

---

### IMP-010: response-poller.ts / cli-patterns.ts の OpenCode パターンへの影響なし

**カテゴリ**: 影響範囲
**場所**: `src/lib/response-poller.ts`, `src/lib/cli-patterns.ts`

LM Studio モデル使用時も OpenCode TUI の表示パターンは変わらないため影響なし。ただし、実装時の動作確認項目として「LM Studio モデル使用時の OpenCode TUI 出力パターンが既存の検出パターンで正常にマッチすること」の確認を推奨。

---

### IMP-011: CLAUDE.md の claude-executor.ts エントリの更新対象

**カテゴリ**: ドキュメント
**場所**: `CLAUDE.md` L172

IMP-002 でスコープ内対応する場合、`claude-executor.ts` エントリに LM Studio プレフィックス対応の記述追加が必要。

---

## 影響範囲マトリクス

### 直接影響（変更必須）

| ファイル | 変更内容 | Issue 記載状況 |
|---------|---------|--------------|
| `src/lib/cli-tools/opencode-config.ts` | `fetchOllamaModels()`/`fetchLmStudioModels()` 独立関数化、リファクタリング | 記載あり |
| `tests/unit/cli-tools/opencode-config.test.ts` | 既存テスト修正 + LM Studio テスト追加 | 追加のみ記載、修正は未記載 |

### 条件付き影響（方針次第）

| ファイル | 条件 | Issue 記載状況 |
|---------|------|--------------|
| `src/lib/claude-executor.ts` | IMP-002 のスコープ判断次第 | 記載あり（方針未確定） |
| `tests/unit/lib/claude-executor.test.ts` | IMP-002 のスコープ判断次第 | 未記載 |

### 将来的影響（現スコープ外）

| ファイル | 将来的変更内容 | Issue 記載状況 |
|---------|-------------|--------------|
| `src/lib/schedule-manager.ts` | options 構築に opencode ケース追加、SQL クエリ拡張 | **未記載** |
| `src/app/api/ollama/models/route.ts` | LM Studio モデル API 対応 | 未記載（UI スコープ外） |
| `src/components/worktree/AgentSettingsPane.tsx` | OpenCode 向けモデルセレクター | 記載あり（スコープ外） |

### 影響なし（確認済み）

| ファイル | 理由 |
|---------|------|
| `src/lib/cli-tools/opencode.ts` | `ensureOpencodeConfig()` シグネチャ不変 |
| `src/lib/cli-tools/types.ts` | CLI ツール型定義に変更なし |
| `src/lib/response-poller.ts` | OpenCode TUI パターン検出に影響なし |
| `src/lib/cli-patterns.ts` | OpenCode パターン定数に影響なし |
| `src/lib/status-detector.ts` | セッションステータス検出に影響なし |
| `src/app/api/worktrees/[id]/route.ts` | worktree PATCH API に変更なし |

---

## 参照ファイル

### コード（変更対象・影響確認対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/cli-tools/opencode-config.ts`: 主要変更対象（L1-239）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/claude-executor.ts`: `buildCliArgs()` L99-120 の `ollama/` プレフィックス問題
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/schedule-manager.ts`: `executeSchedule()` L318-339 の options 構築ロジック
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/cli-tools/opencode.ts`: `startSession()` L97-99 の呼び出し元
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/cli-tools/types.ts`: `OLLAMA_MODEL_PATTERN` L183
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/components/worktree/AgentSettingsPane.tsx`: UI スコープ外確認
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/app/api/ollama/models/route.ts`: Ollama 専用 API
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/app/api/worktrees/[id]/route.ts`: worktree PATCH API

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/cli-tools/opencode-config.test.ts`: 既存テスト298行（修正必要）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/lib/claude-executor.test.ts`: `buildCliArgs` opencode テスト L143-156
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/cli-tools/opencode.test.ts`: `ensureOpencodeConfig` mock L18-21

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/CLAUDE.md`: `opencode-config.ts` エントリ L165、`claude-executor.ts` エントリ L172
