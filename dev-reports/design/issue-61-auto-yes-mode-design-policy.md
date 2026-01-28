# Issue #61: Auto Yesモード - 設計方針書

## 1. 概要

ワークツリー単位でauto yesモードを提供し、Claude Code等のCLIツールからのyes/no確認・複数選択肢プロンプトに自動応答する機能。1時間のタイムアウト付き安全設計。

## 2. システム構成

```
┌─────────────────────────────────────────────────┐
│  Frontend (React)                                │
│                                                  │
│  WorktreeDetailRefactored                        │
│    ├── AutoYesToggle (新規)                      │
│    │     └── GET/POST /api/worktrees/[id]/auto-yes│
│    └── useAutoYes() (新規カスタムフック)          │
│          └── fetchCurrentOutput()の結果を受けて   │
│              auto yes判定・自動応答・二重防止     │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  Backend (Next.js API Routes)                    │
│                                                  │
│  /api/worktrees/[id]/auto-yes  (新規)            │
│    GET  → { enabled, expiresAt }                 │
│    POST → { enabled } → インメモリに保存         │
│                                                  │
│  /api/worktrees/[id]/current-output (既存)       │
│    └── レスポンスに autoYes 状態を付加           │
│                                                  │
│  /api/worktrees/[id]/prompt-response (既存)      │
│    └── auto yes からも同じAPIで応答              │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  tmux session                                    │
│    └── sendKeys() でキーストローク送信           │
└─────────────────────────────────────────────────┘
```

## 3. 設計判断

### 3.1 状態管理: サーバーサイド インメモリ

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **インメモリ Map (採用)** | 実装シンプル、DB変更不要、再起動でリセット | プロセス再起動で消失 |
| DB永続化 | 永続性 | Issueの要件上不要（再起動リセットが望ましい） |
| フロントエンドstate | 実装簡単 | タブ間で不整合 |

**決定**: `Map<worktreeId, AutoYesState>` をサーバーサイドのモジュールスコープで保持する。

```typescript
// src/lib/auto-yes-manager.ts
interface AutoYesState {
  enabled: boolean;
  enabledAt: number;   // Date.now()
  expiresAt: number;   // enabledAt + 3600000 (1時間)
}

const autoYesStates = new Map<string, AutoYesState>();
```

### 3.2 自動応答の実行場所: フロントエンド側ポーリング内

**選択肢の比較**:

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **フロントエンドで判定・API呼出 (採用)** | 既存フローとの一貫性、UIフィードバック容易 | タブが開いていないと動作しない |
| サーバーサイドポーリング内で自動応答 | タブ不要で動作 | 既存アーキテクチャから逸脱、ポーリングロジックの二重化 |

**決定**: 既存の`fetchCurrentOutput()`内でプロンプト検出後、auto yesがONなら自動で`/prompt-response` APIを呼び出す。

**理由**:
- 現在のアーキテクチャでは、ポーリングはフロントエンドが起点（`fetchCurrentOutput`が2秒間隔で`/current-output`を呼ぶ）
- auto yesもこのフローに乗せることで、既存コードへの変更を最小限に抑える
- auto yesを使うユーザーは画面を開いている前提（カウントダウン確認のため）

### 3.3 応答API: 既存の `/prompt-response` を利用

Issue本文では `/api/worktrees/[id]/respond` と記載されているが、実際のフロントエンド応答フローは軽量版の `/prompt-response` を使用している。auto yesもこれに合わせる。

- `/prompt-response`: messageId不要、tmuxに直接送信（WorktreeDetailRefactored が使用中）
- `/respond`: messageId必須、DB更新あり（メッセージ履歴保存向け）

**決定**: `/prompt-response` を使用。auto yesの応答はDB保存不要。

### 3.4 自動応答ルール

| プロンプト種別 | 応答ルール |
|---------------|-----------|
| yes/no | `'y'` を送信 |
| 複数選択肢（`isDefault`あり） | デフォルトオプションの番号を送信 |
| 複数選択肢（`isDefault`なし） | 先頭オプションの番号を送信 |
| テキスト入力が必要な選択肢 | **自動応答しない**（安全のため手動対応） |

### 3.5 二重応答防止

**課題**: ポーリング間隔（2秒）内にtmux出力が更新されない場合、同一プロンプトが再検出され同じ応答が複数回送信される恐れがある。

**対策**: フロントエンド側に「最後に自動応答したプロンプトの複合キー」をRefで保持し、同一プロンプトへの連続応答を抑止する。複合キーには`type`と`question`を含め、同一questionテキストで異なるプロンプト種別が出現するエッジケースにも対応する。

```typescript
// useAutoYesフック内（src/hooks/useAutoYes.ts）
const lastAutoRespondedRef = useRef<string | null>(null);

// 複合キー生成: type + question で一意に識別
const promptKey = `${data.promptData.type}:${data.promptData.question}`;
```

## 4. API設計

### 4.1 新規API: `/api/worktrees/[id]/auto-yes`

#### GET - 状態取得

```typescript
// Response 200
{
  enabled: boolean;
  expiresAt: number | null;  // Unix timestamp (ms)
}

// Response 404 - worktreeが存在しない場合
{ error: "Worktree '<id>' not found" }
```

#### POST - 状態切替

```typescript
// Request
{ enabled: boolean }

// Response 200
{
  enabled: boolean;
  expiresAt: number | null;
}

// Response 400 - enabledがbooleanでない場合
{ error: "enabled must be a boolean" }

// Response 404 - worktreeが存在しない場合
{ error: "Worktree '<id>' not found" }
```

**バリデーション**:
- `enabled`フィールドが`boolean`型であることを明示的にチェックする
- worktreeの存在確認を行い、存在しない場合は404を返す（既存APIと同一パターン）

### 4.2 既存API変更: `/api/worktrees/[id]/current-output`

レスポンスに auto yes 状態を付加する。

```typescript
// src/types/models.ts に型定義を追加（既存の型定義ファイルに集約）
interface CurrentOutputResponse {
  isRunning: boolean;
  cliToolId: string;
  content: string;
  fullOutput: string;
  realtimeSnippet: string;
  lineCount: number;
  lastCapturedLine: number;
  isComplete: boolean;
  isGenerating: boolean;
  thinking: boolean;
  thinkingMessage: string | null;
  isPromptWaiting: boolean;
  promptData: PromptData | null;
  autoYes: {
    enabled: boolean;
    expiresAt: number | null;
  };
}
```

これにより、フロントエンドはポーリングのたびにauto yes状態を取得でき、別途ポーリングする必要がない。

## 5. コンポーネント設計

### 5.1 新規: AutoYesToggle

```
src/components/worktree/AutoYesToggle.tsx
```

**配置**: ターミナル表示エリアの上部（PromptPanelの上）

```
┌─────────────────────────────────────┐
│ [🔘 Auto Yes]  残り 52:30           │  ← AutoYesToggle
├─────────────────────────────────────┤
│                                     │
│  ターミナル出力                      │
│                                     │
├─────────────────────────────────────┤
│  [Yes] [No]  質問テキスト           │  ← PromptPanel（auto yes OFF時のみ表示）
└─────────────────────────────────────┘
```

**Props**:
```typescript
interface AutoYesToggleProps {
  worktreeId: string;
  enabled: boolean;
  expiresAt: number | null;
  onToggle: (enabled: boolean) => Promise<void>;
  lastAutoResponse: string | null;  // 自動応答通知用
}
```

**表示仕様**:
- OFF: トグルスイッチのみ
- ON: トグルスイッチ + `残り MM:SS` カウントダウン（1秒更新、`setInterval`）
- 自動応答時: `Auto responded: "y"` のような一時通知を2秒間表示（フェードアウト）

### 5.2 新規: useAutoYes カスタムフック

auto-yes判定ロジックを`WorktreeDetailRefactored`から分離し、カスタムフックとして独立させる。これにより`WorktreeDetailRefactored`の肥大化を防ぎ、テスタビリティを向上させる。

```typescript
// src/hooks/useAutoYes.ts
interface UseAutoYesParams {
  worktreeId: string;
  cliTool: string;
  isPromptWaiting: boolean;
  promptData: PromptData | null;
  autoYesEnabled: boolean;
}

interface UseAutoYesReturn {
  lastAutoResponse: string | null;  // 直近の自動応答内容（通知用）
}

function useAutoYes({
  worktreeId, cliTool, isPromptWaiting, promptData, autoYesEnabled
}: UseAutoYesParams): UseAutoYesReturn {
  const lastAutoRespondedRef = useRef<string | null>(null);
  const [lastAutoResponse, setLastAutoResponse] = useState<string | null>(null);

  useEffect(() => {
    if (!isPromptWaiting) {
      lastAutoRespondedRef.current = null;
      return;
    }
    if (!promptData || !autoYesEnabled) return;

    // 複合キー: type + question で一意に識別
    const promptKey = `${promptData.type}:${promptData.question}`;
    if (lastAutoRespondedRef.current === promptKey) return;

    const answer = resolveAutoAnswer(promptData);
    if (answer === null) return;

    lastAutoRespondedRef.current = promptKey;
    setLastAutoResponse(answer);

    fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, cliTool }),
    });
  }, [isPromptWaiting, promptData, autoYesEnabled, worktreeId, cliTool]);

  return { lastAutoResponse };
}
```

### 5.3 既存変更: WorktreeDetailRefactored

`useAutoYes`フックを呼び出すのみ。auto-yes判定ロジックは含めない。

```typescript
// WorktreeDetailRefactored内
const { lastAutoResponse } = useAutoYes({
  worktreeId,
  cliTool: cliToolId,
  isPromptWaiting: data?.isPromptWaiting ?? false,
  promptData: data?.promptData ?? null,
  autoYesEnabled: data?.autoYes?.enabled ?? false,
});
// lastAutoResponseをAutoYesToggleに渡す
```

### 5.4 自動応答解決ロジック

```typescript
// src/lib/auto-yes-resolver.ts
function resolveAutoAnswer(promptData: PromptData): string | null {
  if (promptData.type === 'yes_no') {
    return 'y';
  }
  if (promptData.type === 'multiple_choice') {
    const defaultOpt = promptData.options.find(o => o.isDefault);
    const target = defaultOpt ?? promptData.options[0];
    if (target?.requiresTextInput) {
      return null; // テキスト入力が必要な場合は自動応答しない
    }
    return target?.number?.toString() ?? null;
  }
  return null;
}
```

## 6. ファイル構成

### 新規ファイル

| ファイル | 役割 |
|---------|------|
| `src/lib/auto-yes-manager.ts` | サーバーサイド状態管理（Map） |
| `src/lib/auto-yes-resolver.ts` | 自動応答ルール解決（サーバー依存なし、フロントエンドから利用） |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | auto yes API（バリデーション付き） |
| `src/components/worktree/AutoYesToggle.tsx` | トグルUIコンポーネント（通知表示含む） |
| `src/hooks/useAutoYes.ts` | auto yes判定・自動応答・二重応答防止カスタムフック |

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/current-output/route.ts` | レスポンスにautoYes状態を付加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `useAutoYes`フック呼出、AutoYesToggle配置 |
| `src/types/models.ts` | `CurrentOutputResponse`型定義を追加 |

## 7. 安全設計

| 安全策 | 実装 |
|-------|------|
| 1時間タイムアウト | `expiresAt`をサーバー側で管理、GET時に期限切れチェック |
| テキスト入力スキップ | `requiresTextInput`の選択肢には自動応答しない |
| サーバー再起動リセット | インメモリMapのため自動的にクリア |
| カウントダウン表示 | フロントエンドで`expiresAt`から残り時間を計算・表示 |
| 二重応答防止 | `lastAutoRespondedRef`で同一questionへの連続応答を抑止 |
| 自動応答の可視化 | AutoYesToggle内に一時通知を表示し、動作をユーザーが確認可能 |

## 8. テスト方針

| テスト種別 | 対象 |
|-----------|------|
| Unit | `auto-yes-manager.ts` - 状態管理（ON/OFF/期限切れ） |
| Unit | `auto-yes-resolver.ts` - 各プロンプト種別の応答解決 |
| Unit | `useAutoYes` - 二重応答防止（同一複合キー連続時にスキップ）、プロンプト解消時のリセット |
| Integration | `/api/worktrees/[id]/auto-yes` - API動作 |
| Component | `AutoYesToggle` - 表示切替、カウントダウン、自動応答通知 |
