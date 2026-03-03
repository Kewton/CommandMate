# Issue #398: LM Studio モデル選択対応 設計方針書

## 1. 概要

OpenCode の `ensureOpencodeConfig()` を拡張し、Ollama に加え LM Studio の OpenAI互換API からもモデル一覧を取得して `opencode.json` に反映する。

**スコープ**: `opencode-config.ts` のリファクタリングと LM Studio API 統合。TUI モード（opencode.json）でのモデル選択のみ。スケジュール実行（`claude-executor.ts`）は対象外。

## 2. アーキテクチャ設計

### 2-1. 現在のアーキテクチャ

```
ensureOpencodeConfig(worktreePath)
  ├── validateWorktreePath()
  ├── existsSync(opencode.json) → skip if exists
  ├── fetch(OLLAMA_API_URL)      ← 単一プロバイダー
  │   ├── parse { models: [{ name, details }] }
  │   └── validate OLLAMA_MODEL_PATTERN
  └── writeFileSync(opencode.json)
      └── { provider: { ollama: { ... } } }
```

**問題点**: Ollama API 失敗時（非200応答、サイズ超過、構造不正、例外発生のいずれの場合も）早期 `return` するため、後続の LM Studio 処理に到達不可能。

### 2-2. 新アーキテクチャ

```
ensureOpencodeConfig(worktreePath)
  ├── validateWorktreePath()
  ├── existsSync(opencode.json) → skip if exists
  ├── fetchOllamaModels()        ← 独立関数（失敗時=空{}）
  ├── fetchLmStudioModels()      ← 独立関数（失敗時=空{}）
  ├── merge check: both empty → skip
  └── writeFileSync(opencode.json)
      └── { provider: { ollama?: {...}, lmstudio?: {...} } }
```

**設計原則**:
- [D1-001 SRP] 各 `fetchXxxModels()` は独自のAPI呼び出し・パース・バリデーションを担当
- [D1-002 KISS] 2プロバイダー限定のシンプル設計。`ensureOpencodeConfig()` 内のプロバイダー構成はインラインif分岐で組み立てる。3プロバイダー目追加時にデータ駆動設計（providerDefinitions配列+ループ処理）へのリファクタリングを検討する
- 失敗隔離: 各関数は例外を投げず、空オブジェクトを返す

### 2-3. モジュール構成（変更後）

```
src/lib/cli-tools/opencode-config.ts
├── Constants
│   ├── OLLAMA_API_URL, OLLAMA_BASE_URL, MAX_OLLAMA_MODELS, OLLAMA_MODEL_PATTERN（既存）
│   ├── LM_STUDIO_API_URL, LM_STUDIO_BASE_URL（新規）
│   ├── MAX_LM_STUDIO_MODELS, LM_STUDIO_MODEL_PATTERN（新規）
│   └── LM_STUDIO_API_TIMEOUT_MS, MAX_LM_STUDIO_RESPONSE_SIZE（新規、非export）
├── Types
│   ├── OllamaModel, OllamaModelDetails（既存）
│   └── LmStudioModel（新規）
├── Helpers
│   ├── formatModelDisplayName()（既存、Ollama専用）
│   └── validateWorktreePath()（既存）
│   // TODO: If a 3rd provider is added, extract common HTTP fetch logic
├── Provider Functions
│   ├── fetchOllamaModels(): Promise<ProviderModels>（新規、既存ロジック抽出、内部にHTTPフェッチロジックを含む（D1: 選択肢B採用））
│   └── fetchLmStudioModels(): Promise<ProviderModels>（新規、内部にHTTPフェッチロジックを含む（D1: 選択肢B採用））
└── Main
    └── ensureOpencodeConfig()（リファクタリング）
```

## 3. 設計上の決定事項

### D1: 関数抽出アプローチ

| 決定事項 | 選択肢A | 選択肢B（採用） |
|---------|---------|----------------|
| HTTP共通化 | `fetchWithTimeout()` 共通ヘルパー | 各 fetch 関数内に独立実装 |
| メリット | DRY、一貫性 | SRP厳密、テスト容易 |
| デメリット | 共通ヘルパーの汎用性維持が必要 | タイムアウト/AbortController が重複 |

**採用理由**: 選択肢B。現時点で2プロバイダーのみであり、HTTP共通化ヘルパー（`fetchWithTimeout()`）を導入しない理由は以下の通り:
- **YAGNI**: 2プロバイダーのみでは抽象化のコストが利益を上回る。AbortController/setTimeout/レスポンスサイズチェックの重複は認識しているが、各関数のAPIレスポンス形式が異なるため（Ollama: `{ models }` vs LM Studio: `{ data }`）、HTTPフェッチ部分のみを共通化しても削減できるコード量は限定的
- **テスト容易性**: 各関数が独立しているため、モック設定がシンプルになる
- **将来の共通化ポイント**: 3プロバイダー目追加時に `fetchWithTimeout(url, timeoutMs, maxResponseSize): Promise<string | null>` のような最小限ヘルパー（レスポンステキストを返すだけ、JSON解析は呼び出し側）の導入を検討する。実装時に各fetch関数の冒頭にTODOコメントを記載する

### D2: opencode.json プロバイダー構成

| 決定事項 | 選択 | 理由 |
|---------|------|------|
| 0件プロバイダーの扱い | プロバイダーキー自体を省略 | 空の models は OpenCode に無意味 |
| 両方0件の場合 | opencode.json 生成スキップ | 空の provider 設定は無意味 |

**動作変更の注記**: 既存動作では Ollama API成功/モデル0件でも空 models の opencode.json が生成されていたが、新設計ではプロバイダー0件の場合ファイル生成をスキップする（動作変更）。

```typescript
// 動的プロバイダー構成
const provider: Record<string, unknown> = {};
if (Object.keys(ollamaModels).length > 0) {
  provider.ollama = { npm: '...', name: '...', options: { baseURL: OLLAMA_BASE_URL }, models: ollamaModels };
}
if (Object.keys(lmStudioModels).length > 0) {
  provider.lmstudio = { npm: '...', name: '...', options: { baseURL: LM_STUDIO_BASE_URL }, models: lmStudioModels };
}
if (Object.keys(provider).length === 0) return; // 両方0件 → スキップ
```

### D3: LM Studio API レスポンスパーサー

LM Studio は OpenAI互換API（`/v1/models`）を提供:

```typescript
// LM Studio レスポンス形式（OpenAI互換）
interface LmStudioResponse {
  data: Array<{
    id: string;       // モデルID（例: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF"）
    object: string;   // "model"
  }>;
}
```

- モデル識別子: `id` フィールド（Ollama の `name` とは異なる）
- `details`（parameter_size, quantization_level）は取得不可 → 表示名=ID そのまま
- バリデーション: `LM_STUDIO_MODEL_PATTERN` で長さ200文字制限

### D4: 戻り値型の統一

```typescript
/** 共通の戻り値型（両関数で統一） */
type ProviderModels = Record<string, { name: string }>;

// fetchOllamaModels(): Promise<ProviderModels>
// fetchLmStudioModels(): Promise<ProviderModels>
// 失敗時: {} (空オブジェクト)
```

**ミニマル設計の理由**: `ProviderModels` を `Record<string, { name: string }>` に留めているのは、opencode.json の models 構造が `Record<string, { name: string }>` であるため、この型で十分なためである。Ollama 固有の details 情報（parameter_size, quantization_level）は `fetchOllamaModels()` 内で `formatModelDisplayName()` によって name 文字列に変換される。UI 層でパラメータサイズ等の追加情報が必要な場合は、別途既存API（`/api/ollama/models`）を使用する。

### D5: 後方互換性と移行

- **既存 opencode.json は上書きしない**: `ensureOpencodeConfig()` は `existsSync()` チェックにより、opencode.json が存在する場合は何もしない（現行動作維持）
- **LM Studio モデルの追加手順**: Ollama のみで生成された既存 opencode.json を持つユーザーが LM Studio を後から導入した場合、LM Studio モデルは自動的に追加されない。ユーザーが opencode.json を削除してセッションを再起動する必要がある
- **将来 Issue**: opencode.json マージ更新機能（既存ファイルにプロバイダーを追記する機能）の実装を検討する。現時点では existsSync による全スキップ方式を維持し、KISS 原則を優先する

## 4. 定数設計

### 4-1. 新規追加定数

```typescript
// [SEC-001] SSRF Prevention: ハードコード必須
export const LM_STUDIO_API_URL = 'http://localhost:1234/v1/models' as const;
export const LM_STUDIO_BASE_URL = 'http://localhost:1234/v1' as const;

// DoS Prevention
export const MAX_LM_STUDIO_MODELS = 100;

// Model name validation (length-limited, path format support)
// 文字種根拠:
//   - a-zA-Z0-9._:/- : Ollama と共通の基本文字種（モデル名、組織名/モデル名形式）
//   - @ : HuggingFace リビジョン指定形式（例: org/model@revision）への将来対応
// 実際のモデルID例:
//   - lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF (54文字)
//   - TheBloke/Mistral-7B-Instruct-v0.2-GGUF (41文字)
// 長さ上限根拠: 実際のモデルID最大長が約60文字であり、200文字は十分な安全マージン
//   （org名+model名+quantization情報+revision指定を考慮した余裕値）
export const LM_STUDIO_MODEL_PATTERN = /^[a-zA-Z0-9._:/@-]{1,200}$/;

// Internal constants (non-export)
const LM_STUDIO_API_TIMEOUT_MS = 3000;
const MAX_LM_STUDIO_RESPONSE_SIZE = 1 * 1024 * 1024; // 1MB
```

### 4-2. 既存定数（変更なし）

| 定数 | 値 | export状態 | 備考 |
|------|----|-----------|------|
| `OLLAMA_API_URL` | `http://localhost:11434/api/tags` | export | 変更なし |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | export | 変更なし |
| `MAX_OLLAMA_MODELS` | 100 | export | 変更なし |
| `OLLAMA_MODEL_PATTERN` | `/^[a-zA-Z0-9._:/-]{1,100}$/` | export | 変更なし |
| `OLLAMA_API_TIMEOUT_MS` | 3000 | 非export | 変更なし |
| `MAX_OLLAMA_RESPONSE_SIZE` | 1MB | 非export | 変更なし |
| `CONFIG_FILE_NAME` | `opencode.json` | 非export | 変更なし |

## 5. セキュリティ設計

### SEC-001: SSRF 防止

| 対策 | 実装 |
|------|------|
| API URL ハードコード | `LM_STUDIO_API_URL` / `LM_STUDIO_BASE_URL` を `as const` で定義 |
| 環境変数からの導出禁止 | JSDoc に明記（既存 Ollama 定数と同一ポリシー） |
| fetch 先の制限 | `localhost` のみ |

### SEC-002: DoS 防御

| 対策 | 定数 | 値 |
|------|------|----|
| レスポンスサイズ制限 | `MAX_LM_STUDIO_RESPONSE_SIZE` | 1MB |
| モデル数制限 | `MAX_LM_STUDIO_MODELS` | 100 |
| タイムアウト | `LM_STUDIO_API_TIMEOUT_MS` | 3000ms |
| モデル名長さ制限 | `LM_STUDIO_MODEL_PATTERN` | 200文字 |

**`response.text()` 後サイズチェック方式の設計判断根拠**:

`fetchLmStudioModels()` および `fetchOllamaModels()` では、`response.text()` でレスポンス全体をメモリに読み込んだ後に `text.length > MAX_LM_STUDIO_RESPONSE_SIZE` でサイズチェックを行う。この方式はメモリ使用量の観点で最適ではないが、以下の理由で許容する:

1. **Content-Length ヘッダーは改竄可能で信頼できない**: 事前サイズチェックとしては不十分
2. **ストリーミング実装の複雑性が KISS 原則に反する**: ReadableStream による段階的読み込みは実装・テスト・保守のコストが高い
3. **1MB のメモリ消費はサーバー環境で許容範囲内**: 並列実行時でも合計 2MB + JSON パースオーバーヘッドであり問題ない
4. **AbortController によるタイムアウト（3000ms）が二次的な保護を提供する**: 極端に大きなレスポンスはタイムアウトにより中断される

この方式は既存の Ollama 実装（opencode-config.ts）と同一パターンであり、一貫性を維持する。

### SEC-003: JSON インジェクション防止

- `JSON.stringify()` で config 生成（テンプレートリテラル禁止）
- 既存の `[D4-005]` ポリシーを LM Studio にも適用

### SEC-004: パストラバーサル防止

- 既存の `validateWorktreePath()` は変更なし
- LM Studio 追加による新たなパス操作は発生しない

### SEC-005: モデルID安全性

- `JSON.stringify()` によるエスケープで JSON 構造破壊は防止済み（SEC-003 適用）
- モデルIDに含まれる `/`（例: `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`）は opencode.json のキーとして OpenCode 側で適切に処理されることを前提とする。本プロジェクトの責務は JSON 構造の健全性保証までであり、OpenCode 内部でのキー解釈は OpenCode 側の責務である
- 将来のスケジュール実行対応時に `claude-executor.ts` の引数バリデーション追加が必要（`--` 文字列の拒否等によるコマンドライン引数インジェクション防止）。現時点では `execFile` を使用しているためシェルインジェクションは防止されるが、引数解釈の操作リスクは残る

### SEC-006: ログ出力の情報制御

- `console.warn` の出力内容は HTTP ステータスコードおよび固定メッセージ文字列に限定する
- API レスポンスボディ、リクエストヘッダー、モデル名一覧等の詳細情報はログに含めない
- 将来のデバッグ目的でレスポンスボディをログに含める変更を設計レベルで防止する（デバッグが必要な場合は環境変数による明示的な有効化を要する）
- 既存の Ollama 実装（Issue #379 opencode-config.ts）と同一のログ出力パターンを維持する

### SEC-007: ファイルパーミッション

- `opencode.json` は機密情報（API キー等）を含まないため、`writeFileSync()` に `mode` オプションを指定せず OS デフォルト（umask 適用後、一般的に 0o644）に委ねる
- これは既存の opencode-config.ts 実装と一貫した設計判断である
- 将来的にプロバイダー設定に認証情報（API キー等）が追加される場合（例: LM Studio リモートサーバー対応時）は `mode: 0o600` を明示的に設定する方針とする

## 6. API 設計

### 6-1. fetchOllamaModels()

```typescript
/**
 * Fetch model list from Ollama API.
 * Returns empty object on any failure (non-fatal).
 *
 * @returns Model map (key: model name, value: { name: display name })
 * @internal
 */
export async function fetchOllamaModels(): Promise<ProviderModels> {
  // 既存ロジック抽出（`ensureOpencodeConfig()` 内の `// Fetch models from Ollama API` コメントから catch ブロック末尾までの既存ロジック）
  // 既存の全 early return（非200応答/サイズ超過/構造不正/例外発生の4パターン）を空オブジェクト返却に変換する
  // 失敗時は console.warn + return {}
}
```

### 6-2. fetchLmStudioModels()

```typescript
/**
 * Fetch model list from LM Studio OpenAI-compatible API.
 * Returns empty object on any failure (non-fatal).
 *
 * @returns Model map (key: model id, value: { name: model id })
 * @internal
 */
export async function fetchLmStudioModels(): Promise<ProviderModels> {
  const models: ProviderModels = {};
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LM_STUDIO_API_TIMEOUT_MS);
    const response = await fetch(LM_STUDIO_API_URL, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      console.warn(`LM Studio API returned status ${response.status}`);
      return {};
    }

    const text = await response.text();
    if (text.length > MAX_LM_STUDIO_RESPONSE_SIZE) {
      console.warn('LM Studio API response too large');
      return {};
    }

    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.data)) {
      console.warn('Invalid LM Studio API response structure');
      return {};
    }

    const modelList = data.data.slice(0, MAX_LM_STUDIO_MODELS);
    for (const model of modelList) {
      if (typeof model?.id !== 'string') continue;
      if (!LM_STUDIO_MODEL_PATTERN.test(model.id)) continue;
      models[model.id] = { name: model.id };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('LM Studio API timeout');
    } else {
      console.warn('Failed to fetch LM Studio models');
    }
  }
  return models;
}
```

### 6-3. ensureOpencodeConfig()（リファクタリング後）

```typescript
export async function ensureOpencodeConfig(worktreePath: string): Promise<void> {
  const validatedPath = validateWorktreePath(worktreePath);
  const configPath = path.join(validatedPath, CONFIG_FILE_NAME);

  if (fs.existsSync(configPath)) return;

  // 並列呼び出し（各々失敗しても空オブジェクトを返すため Promise.all は拒否されない）
  const [ollamaModels, lmStudioModels] = await Promise.all([
    fetchOllamaModels(),
    fetchLmStudioModels(),
  ]);

  // 動的プロバイダー構成
  const provider: Record<string, unknown> = {};
  if (Object.keys(ollamaModels).length > 0) {
    provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: OLLAMA_BASE_URL },
      models: ollamaModels,
    };
  }
  if (Object.keys(lmStudioModels).length > 0) {
    provider.lmstudio = {
      npm: '@ai-sdk/openai-compatible',
      name: 'LM Studio (local)',
      options: { baseURL: LM_STUDIO_BASE_URL },
      models: lmStudioModels,
    };
  }

  // 両方0件 → スキップ
  if (Object.keys(provider).length === 0) return;

  const config = { $schema: 'https://opencode.ai/config.json', provider };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    console.warn(`Failed to write opencode.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

## 7. テスト設計

### 7-1. テスト構成

| テスト対象 | テスト種別 | ケース数（概算） |
|-----------|----------|----------------|
| `fetchOllamaModels()` | ユニット | 8件（既存ロジック移行） |
| `fetchLmStudioModels()` | ユニット | 8件（新規） |
| `ensureOpencodeConfig()` | 結合 | 8件（マージロジック） |
| 定数 | ユニット | 4件（新規定数バリデーション） |

### 7-2. fetchLmStudioModels() テストケース

| ケース | 期待結果 |
|--------|---------|
| 正常: モデル2件取得 | `{ "model-a": { name: "model-a" }, ... }` |
| API未起動（ECONNREFUSED） | 空オブジェクト `{}` |
| APIタイムアウト | 空オブジェクト `{}` |
| 非200レスポンス | 空オブジェクト `{}` |
| レスポンスサイズ超過（>1MB） | 空オブジェクト `{}` |
| 不正なレスポンス構造 | 空オブジェクト `{}` |
| モデル数上限超過（>100件） | 100件に切り詰め |
| 不正なモデル名（パターン不一致） | スキップ |

### 7-3. ensureOpencodeConfig() 結合テスト

| ケース | 期待結果 |
|--------|---------|
| Ollama + LM Studio 両方成功 | 両プロバイダーを含む opencode.json |
| Ollama のみ成功 | ollama のみの opencode.json |
| LM Studio のみ成功 | lmstudio のみの opencode.json |
| 両方未起動（0件） | opencode.json 生成なし |
| Ollama API成功だがモデル0件 + LM Studio未起動 | opencode.json 生成なし（動作変更: 既存では空modelsのファイルが生成されていた） |
| opencode.json 既存 | 何もしない |

### 7-4. 既存テスト移行方針

`mockFetch` を URL ベースで分岐する mock 実装に変更:

```typescript
const mockFetch = vi.fn().mockImplementation((url: string) => {
  if (url === OLLAMA_API_URL) {
    return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ models: [...] })) });
  }
  if (url === LM_STUDIO_API_URL) {
    return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ data: [...] })) });
  }
  return Promise.reject(new Error('Unknown URL'));
});
```

### 7-5. 既存テスト移行影響

既存 `opencode-config.test.ts` のテストケース13件について、リファクタリング後の移行先と注意事項を以下に示す。

#### 移行対応表

| # | 既存テストケース | 移行先 | 注意事項 |
|---|----------------|--------|---------|
| 1 | Ollama モデル正常取得 | `fetchOllamaModels()` 個別テスト | 期待値変更なし |
| 2 | Ollama API タイムアウト | `fetchOllamaModels()` 個別テスト | 空オブジェクト `{}` を返すことを検証 |
| 3 | Ollama API ネットワーク失敗（ECONNREFUSED） | `fetchOllamaModels()` 個別テスト | 空オブジェクト `{}` を返すことを検証 |
| 4 | Ollama API 非200応答 | `fetchOllamaModels()` 個別テスト | 空オブジェクト `{}` を返すことを検証 |
| 5 | Ollama API レスポンスサイズ超過 | `fetchOllamaModels()` 個別テスト | 空オブジェクト `{}` を返すことを検証 |
| 6 | Ollama API レスポンス構造不正 | `fetchOllamaModels()` 個別テスト | 空オブジェクト `{}` を返すことを検証 |
| 7 | Ollama モデル数上限（>100件） | `fetchOllamaModels()` 個別テスト | 100件に切り詰めることを検証 |
| 8 | Ollama モデル名バリデーション（パターン不一致） | `fetchOllamaModels()` 個別テスト | スキップされることを検証 |
| 9 | Ollama 表示名フォーマット（formatModelDisplayName） | `fetchOllamaModels()` 個別テスト | 期待値変更なし |
| 10 | opencode.json 既存スキップ | `ensureOpencodeConfig()` 統合テスト | 期待値変更なし |
| 11 | パストラバーサル防御 | `ensureOpencodeConfig()` 統合テスト | 期待値変更なし |
| 12 | worktreePath が非ディレクトリ | `ensureOpencodeConfig()` 統合テスト | 期待値変更なし |
| 13 | 書き込み失敗/EEXIST | `ensureOpencodeConfig()` 統合テスト | 期待値変更なし |

#### 動作変更による期待値の変更に関する注意

既存テストのうち「Ollama API 失敗時に opencode.json が生成されない」ことを検証するテスト群（#2, #3, #4, #5, #6 の5件）は、リファクタリング後に注意が必要である。これらのテストを `ensureOpencodeConfig()` 統合テストとして実行する場合、LM Studio 側の mockFetch も失敗（ECONNREFUSED）に設定しなければ、LM Studio API が成功して opencode.json が生成されてしまい、テストが不正に失敗する。

対策: 上記5件は `fetchOllamaModels()` 個別テストに移行し、統合テストでは「両方未起動（0件）→ opencode.json 生成なし」のケース（セクション7-3参照）で包括的にカバーする。

#### 影響なし確認: opencode.test.ts

`opencode.test.ts` は `ensureOpencodeConfig` のみを mock しており、新規 export（`LM_STUDIO_API_URL`, `fetchOllamaModels`, `fetchLmStudioModels` 等）は `opencode.ts` で import されないため変更不要。

## 8. パフォーマンス設計

### 8-1. API呼び出しの並列化

```typescript
// 並列呼び出し（Promise.all）
const [ollamaModels, lmStudioModels] = await Promise.all([
  fetchOllamaModels(),
  fetchLmStudioModels(),
]);
```

**選択**: 並列呼び出し（`Promise.all`）を採用。
- 最大実行時間: max(3秒, 3秒) = 3秒（直列なら最大6秒）
- `OPENCODE_INIT_WAIT_MS`（15秒）内に十分収まる
- 各関数は独立しているため並列実行に問題なし
- **Promise.all の安全性**: `fetchOllamaModels()` および `fetchLmStudioModels()` は内部で全例外を try-catch で捕捉し、いかなる失敗時も空オブジェクト `{}` を返す設計である。そのため `Promise.all` が拒否（reject）されることはなく、外側での追加 try-catch は不要である。この設計意図はセクション 6-1/6-2 の JSDoc に「Returns empty object on any failure (non-fatal)」として明記されている

### 8-2. 実行時間への影響

| シナリオ | 並列実行時 | 直列実行時 |
|---------|----------|----------|
| 両方起動中（応答200ms想定） | ~200ms | ~400ms |
| Ollama未起動（タイムアウト3秒） | ~3秒 | ~3秒+200ms |
| 両方未起動（タイムアウト3秒） | ~3秒 | ~6秒 |
| LM Studio未起動（接続拒否即座） | ~200ms | ~200ms+即座 |

## 9. スコープ外の明確化

| 項目 | 理由 | 将来Issue |
|------|------|----------|
| `claude-executor.ts` の `ollama/` プレフィックス変更 | TUI モードで十分、スケジュール実行は別途。`buildCliArgs()` の opencode case で `ollama/` プレフィックスがハードコード（L110-115）。LM Studio モデル ID（例: `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`）に `ollama/` が付加されると `ollama/lmstudio-community/...` となり、OpenCode の `opencode run -m` コマンドが認識できないモデル名としてエラーを返す。TUI モード（opencode.json 経由）ではプロバイダー識別子が不要なため問題なし。将来 Issue として「opencode のスケジュール実行でプロバイダー識別子（ollama/ vs lmstudio/）を動的に切り替える」対応が必要。**セキュリティ注記（SEC-005関連）**: 将来の LM Studio スケジュール実行対応時には、`buildCliArgs()` に渡される model パラメータに対する引数インジェクション対策（`--` 文字列の拒否、許可文字パターンバリデーション等）が必要。`execFile` 使用によりシェルインジェクションは防止されるが、コマンドライン引数の解釈操作リスクは別途考慮すること | 要 |
| `schedule-manager.ts` の opencode options 構築 | TUI モードで十分。L328-331 の options 構築が vibe-local 専用であり、opencode の場合 model 未指定でスケジュール実行される（opencode.json のデフォルトモデルを使用）。LM Studio モデルをスケジュール実行で使用するには DB スキーマ拡張（opencode_model カラム等）と options 構築ロジックの case 'opencode' 追加が必要 | 要 |
| `AgentSettingsPane.tsx` の UI モデルセレクター | opencode.json で自動設定 | 要 |
| `/api/lmstudio/models` API エンドポイント | UI 対応時に必要 | 要 |

## 10. 実装順序

1. **定数追加**: `LM_STUDIO_API_URL`, `LM_STUDIO_BASE_URL`, `MAX_LM_STUDIO_MODELS`, `LM_STUDIO_MODEL_PATTERN` 等
2. **型定義追加**: `LmStudioModel`, `ProviderModels` 型
3. **fetchOllamaModels() 抽出**: 既存ロジックを独立関数に抽出
4. **fetchLmStudioModels() 新規作成**: LM Studio API パーサー実装
5. **ensureOpencodeConfig() リファクタリング**: 両関数呼び出し + マージ + 動的プロバイダー構成
6. **テスト移行・追加**: 既存テスト分割 + 新規テスト追加
7. **CLAUDE.md 更新**: モジュール説明更新

## 11. レビュー履歴

| ステージ | レビュー日 | フォーカス | 結果 |
|---------|----------|----------|------|
| Stage 1 | 2026-03-02 | 設計原則（通常レビュー） | Must Fix: 1件、Should Fix: 4件反映、Nice to Have: 4件スキップ |
| Stage 2 | 2026-03-02 | 整合性レビュー | Must Fix: 2件、Should Fix: 4件反映、Nice to Have: 4件スキップ |
| Stage 3 | 2026-03-02 | 影響分析レビュー | Must Fix: 1件、Should Fix: 4件反映、Nice to Have: 4件スキップ |
| Stage 4 | 2026-03-02 | セキュリティレビュー | Must Fix: 1件、Should Fix: 4件反映、Nice to Have: 4件スキップ |

## 12. レビュー指摘事項サマリー

### Stage 1: 通常レビュー（設計原則）

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S1-001 | Should Fix | DRY | タイムアウト/AbortController/レスポンスサイズチェックの重複コード | 反映済み（セクション3 D1にYAGNI根拠と将来の共通化ポイントを明記） |
| S1-002 | Nice to Have | DRY | 定数の対称的重複（OLLAMA系/LM_STUDIO系） | スキップ（Nice to Have） |
| S1-003 | Must Fix | SRP | ensureOpencodeConfig()内のプロバイダー構成組み立てロジックとOCP主張の矛盾 | 反映済み（セクション2-2のOCP主張を取り下げ、KISS設計として明記） |
| S1-004 | Should Fix | KISS | Promise.all並列化のエラーハンドリング記述不足 | 反映済み（セクション8-1に安全性根拠を明記） |
| S1-005 | Nice to Have | YAGNI | 汎用ヘルパー化の先送りは妥当 | スキップ（Nice to Have） |
| S1-006 | Should Fix | 型設計 | ProviderModels型のミニマル設計理由が未記載 | 反映済み（セクション3 D4にミニマル設計の理由を明記） |
| S1-007 | Nice to Have | OCP | LM_STUDIO_MODEL_PATTERNの長さ上限の根拠未記載 | スキップ（Nice to Have） |
| S1-008 | Should Fix | SRP | セクション6-3とセクション8-1のコード例不整合 | 反映済み（セクション6-3をPromise.all形式に統一） |
| S1-009 | Nice to Have | DRY | OLLAMA定数が/api/ollama/models/route.tsにも重複定義 | スキップ（Nice to Have） |

### Stage 2: 整合性レビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S2-001 | Must Fix | コード整合性 | セクション6-1の行番号参照「L163-210」が不安定 | 反映済み（安定したコメント/関数名参照に変更） |
| S2-002 | Must Fix | コード整合性 | セクション2-1の問題点記述がcatchのみに言及 | 反映済み（全4パターンのearly returnを明記、セクション6-1に実装ノート追記） |
| S2-003 | Should Fix | コード整合性 | 0件時の動作変更が設計書に未記載 | 反映済み（セクション3 D2に動作変更注記、セクション7-3にテストケース追加） |
| S2-004 | Should Fix | コード整合性 | モジュール構成図に不採用のfetchWithTimeout()が残留 | 反映済み（削除しTODOコメント追加、Provider Functionsに選択肢B注記） |
| S2-005 | Should Fix | Issue整合性 | テストファイルパスの不一致 | スキップ（Issue本文修正は別途対応） |
| S2-006 | Should Fix | 設計書内部 | 既存定数テーブルにexport/非exportの区別なし | 反映済み（セクション4-2にexport状態列を追加） |
| S2-007 | Nice to Have | 命名規則 | LM_STUDIO_MODEL_PATTERNの@追加理由未記載 | スキップ（Nice to Have） |
| S2-008 | Nice to Have | テスト整合性 | テストケース数と既存テスト数の整合確認 | スキップ（Nice to Have） |
| S2-009 | Nice to Have | コード整合性 | opencode.json provider構造の動作変更影響未記載 | スキップ（Nice to Have） |
| S2-010 | Should Fix | コード整合性 | claude-executor.tsのollama/プレフィックス問題の詳細不足 | 反映済み（セクション9に具体的な影響と将来Issue記載を追記） |
| S2-011 | Nice to Have | 設計書内部 | S1-005の実質反映状況が不明確 | スキップ（Nice to Have） |

### Stage 3: 影響分析レビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S3-001 | Should Fix | 直接影響 | schedule-manager.ts の opencode スケジュール実行で model オプションが渡されない | 反映済み（セクション9にoptions構築の詳細とDB拡張要件を追記） |
| S3-002 | Should Fix | 間接影響 | 既存 opencode.json ユーザーへの影響が設計書に不十分 | 反映済み（セクション3 D5に後方互換性と移行サブセクションを追加） |
| S3-003 | Must Fix | テスト影響 | 既存テスト opencode-config.test.ts の mockFetch が大幅な書き換えを必要とする点が設計書で過小評価 | 反映済み（セクション7-5に既存テスト移行影響サブセクションを追加、13件の移行対応表と動作変更注意事項を記載） |
| S3-004 | Nice to Have | 直接影響 | /api/ollama/models/route.ts の OLLAMA_API_URL 定数との重複は意図的だが注記が有用 | スキップ（Nice to Have） |
| S3-005 | Nice to Have | 間接影響 | opencode.ts startSession() の実行時間増加の影響が OPENCODE_INIT_WAIT_MS 内に収まることの明示 | スキップ（Nice to Have） |
| S3-006 | Should Fix | スコープ | claude-executor.ts の ollama/ プレフィックスハードコードが LM Studio モデルをスケジュール実行で使用不可にする影響の具体性不足 | 反映済み（セクション9に具体的な失敗シナリオとエラー挙動を追記） |
| S3-007 | Nice to Have | 後方互換性 | Ollama API 成功/モデル0件時の動作変更による後方互換性への影響が限定的だが確認事項あり | スキップ（Nice to Have） |
| S3-008 | Should Fix | テスト影響 | opencode.test.ts の ensureOpencodeConfig mock が新規 export 追加に伴い更新確認が必要 | 反映済み（セクション7-5に影響なし確認を追記） |
| S3-009 | Nice to Have | 直接影響 | LM_STUDIO_MODEL_PATTERN の @ 文字許可と LM Studio モデル ID フォーマットの整合性 | スキップ（Nice to Have） |

### Stage 4: セキュリティレビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S4-001 | Should Fix | InfoLeak | console.warn によるモデル名・APIステータスコードの情報漏洩リスク | 反映済み（セクション5にSEC-006ログ出力の情報制御を追加） |
| S4-002 | Should Fix | DoS | LM_STUDIO_MODEL_PATTERN の文字種が Ollama よりも広い理由と安全性の根拠不足 | 反映済み（セクション4-1にモデルID実例・@文字根拠・200文字上限根拠を追記） |
| S4-003 | Nice to Have | SSRF | SEC-001 SSRF防止ポリシーの DNS rebinding への言及がない | スキップ（Nice to Have） |
| S4-004 | Must Fix | Injection | LM Studio モデルIDが opencode.json の provider キーに使用されるリスク | 反映済み（セクション5にSEC-005モデルID安全性を追加、セクション9にセキュリティ注記を追記） |
| S4-005 | Nice to Have | DoS | Promise.all 並列実行時の合計リソース消費量（メモリ）に関する考慮 | スキップ（Nice to Have） |
| S4-006 | Should Fix | AccessControl | opencode.json の writeFileSync パーミッション指定がない | 反映済み（セクション5にSEC-007ファイルパーミッションを追加） |
| S4-007 | Nice to Have | その他 | LM Studio のデフォルトポート 1234 のポート衝突リスクの注記がない | スキップ（Nice to Have） |
| S4-008 | Should Fix | DoS | response.text() がレスポンス全体をメモリに読み込んだ後にサイズチェックする設計 | 反映済み（セクション5 SEC-002に設計判断根拠を追記） |
| S4-009 | Nice to Have | その他 | LM Studio API接続時のHTTPヘッダーが設計されていない | スキップ（Nice to Have） |

## 13. 実装チェックリスト（レビュー反映分）

- [ ] **S1-003**: `ensureOpencodeConfig()` のプロバイダー構成はインラインif分岐で実装する（OCPではなくKISS設計）。3プロバイダー目追加時にデータ駆動設計へリファクタリングする旨をコードコメントに記載する
- [ ] **S1-001**: 各fetch関数（`fetchOllamaModels()`, `fetchLmStudioModels()`）の冒頭にTODOコメントを記載する（例: `// TODO: If a 3rd provider is added, extract common fetch logic to fetchWithTimeout()`）
- [ ] **S1-004**: `fetchOllamaModels()` と `fetchLmStudioModels()` が全例外を内部で捕捉することをテストで検証する（予期せぬエラー型を投入しても空オブジェクトが返ることを確認）
- [ ] **S1-008**: `ensureOpencodeConfig()` 内のfetch呼び出しは `Promise.all` で並列実行する（直列awaitにしない）
- [ ] **S1-006**: `ProviderModels` 型のJSDocに「opencode.jsonのmodels構造に合わせたミニマル設計」である旨を記載する
- [ ] **S2-001**: `fetchOllamaModels()` の抽出対象は行番号ではなく `ensureOpencodeConfig()` 内の `// Fetch models from Ollama API` コメントから catch ブロック末尾までの既存ロジックを参照する
- [ ] **S2-002**: `fetchOllamaModels()` 抽出時に、既存の全 early return（非200応答/サイズ超過/構造不正/例外発生の4パターン）を空オブジェクト `{}` 返却に変換する。catch ブロックだけでなく全ての return パスを確認すること
- [ ] **S2-003**: 0件時の動作変更をテストで検証する（Ollama API成功/モデル0件 + LM Studio未起動 → opencode.json が生成されないことを確認）
- [ ] **S2-006**: 新規定数追加時に export/非export を設計書セクション4-1の定義に従って正しく設定する

- [ ] **S3-003**: 既存テスト13件を移行対応表（セクション7-5）に従い、`fetchOllamaModels()` 個別テスト（9件）と `ensureOpencodeConfig()` 統合テスト（4件）に分割する
- [ ] **S3-003**: Ollama API 失敗テスト群（5件）を `fetchOllamaModels()` 個別テストに移行する際、LM Studio 側の mockFetch 設定が不要であることを確認する（個別テストでは `ensureOpencodeConfig()` を経由しないため）
- [ ] **S3-003**: `ensureOpencodeConfig()` 統合テストで「両方未起動（0件）→ opencode.json 生成なし」ケースを実装する際、Ollama/LM Studio 両方の mockFetch を ECONNREFUSED に設定する
- [ ] **S3-001**: `schedule-manager.ts` の opencode options 構築がスコープ外であることを認識し、本 Issue では対応しない。将来 Issue として DB スキーマ拡張と options 構築ロジックの case 'opencode' 追加を起票する
- [ ] **S3-002**: 既存 opencode.json の上書きは行わない（existsSync スキップ維持）。ユーザーが LM Studio モデルを追加する場合は opencode.json 削除+セッション再起動が必要である旨を把握する
- [ ] **S3-006**: `claude-executor.ts` の `ollama/` プレフィックス問題がスコープ外であることを認識し、本 Issue では対応しない。TUI モード（opencode.json）ではプロバイダー識別子が不要であり問題なし
- [ ] **S3-008**: `opencode.test.ts` は変更不要であることを実装後に確認する（`ensureOpencodeConfig` のみ mock、新規 export は `opencode.ts` で未使用）

- [ ] **S4-004**: `fetchLmStudioModels()` のモデルIDキー使用箇所に、JSON.stringify() によるエスケープで JSON 構造破壊が防止されている旨のコードコメントを記載する
- [ ] **S4-004**: 将来のスケジュール実行対応 Issue 起票時に、`claude-executor.ts` の `buildCliArgs()` に対する引数インジェクション対策（`--` 文字列拒否等）を要件に含める
- [ ] **S4-001**: `console.warn` 出力は固定メッセージ文字列と HTTP ステータスコードに限定する。API レスポンスボディやモデル名一覧をログに含めない
- [ ] **S4-002**: `LM_STUDIO_MODEL_PATTERN` の実装時に、コードコメントとして `@` 文字の許可根拠（HuggingFace リビジョン指定対応）と 200 文字上限の根拠（実際のモデルID最大約60文字 + 安全マージン）を記載する
- [ ] **S4-006**: `writeFileSync()` に `mode` オプションを指定しない（OS デフォルトに委ねる意図的な判断）。将来の認証情報追加時は `mode: 0o600` を設定する
- [ ] **S4-008**: `response.text()` 後のサイズチェック方式を維持する。Content-Length 事前チェックやストリーミング実装に変更しない

---

*Generated by design-policy command for Issue #398*
*Date: 2026-03-02*
*Stage 1 レビュー反映: 2026-03-02*
*Stage 2 レビュー反映: 2026-03-02*
*Stage 3 レビュー反映: 2026-03-02*
*Stage 4 セキュリティレビュー反映: 2026-03-02*
