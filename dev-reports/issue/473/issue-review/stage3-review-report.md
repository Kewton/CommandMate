# Issue #473 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-11
**フォーカス**: 影響範囲レビュー（1回目）
**Stage**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |
| **合計** | **6** |

影響範囲レビューの結果、最も重要な指摘は `status-detector.ts` の検出優先順位に関するもの（F301）である。この実装は5つの全CLIツールで共有される `detectSessionStatus()` 関数を変更するため、優先順位の設計を誤ると既存ツールのステータス検出に副作用が生じる。一方、新規 `special-keys` APIは既存の `terminal` APIと同一パターンで実装可能であり、セキュリティ影響は限定的。パフォーマンス面でも追加のポーリング負荷は発生しない設計であることを確認した。

---

## Must Fix（必須対応）

### F301: 選択リスト検出分岐の優先順位がステータス検出の既存優先順序に影響する

**カテゴリ**: 既存コンポーネントへの影響 - status-detector.ts
**リスク**: high

**問題**:
`status-detector.ts` の `detectSessionStatus()` は以下の厳密な優先順位で動作する:

1. プロンプト検出（interactive prompt） -> `waiting`
2. thinking検出 -> `running`
3. OpenCode固有検出（processing indicator / response complete） -> `running` or `ready`
4. 入力プロンプト検出 -> `ready`
5. 時間ベースヒューリスティック -> `ready`
6. デフォルト -> `running`

Issueでは `status-detector.ts` に `reason: 'opencode_selection_list'` の新規分岐を追加するとあるが、どの優先順位に挿入するかが未定義。優先順位を誤ると:
- 選択リスト表示中にプロンプト検出が誤発火する
- thinking検出と競合する
- 既存の `OPENCODE_PROCESSING_INDICATOR`（`esc interrupt`）との判定順序が不明確になる

**影響を受けるコンポーネント**:
- `src/lib/status-detector.ts` - 直接変更対象
- `src/app/api/worktrees/[id]/current-output/route.ts` - detectSessionStatus() を呼び出し
- `src/lib/worktree-status-helper.ts` - detectSessionStatus() を呼び出し
- `src/lib/response-poller.ts` - detectSessionStatus() を参照
- `src/lib/__tests__/status-detector.test.ts` - テスト追加必須

**推奨対応**:
Issue本文の検出方法セクションに、`detectSessionStatus()` 内での選択リスト検出の優先順位を明記する。推奨は priority 2.5（OpenCode固有検出ブロック、L202-264）内に、`OPENCODE_PROCESSING_INDICATOR` チェックの後、contentCandidates 解析の前に配置すること。返却する `status` 値は `'waiting'`（UIがナビゲーションボタンを表示するトリガー）が妥当。

---

## Should Fix（推奨対応）

### F302: 選択リスト検出状態のフロントエンドへの伝達方法が未定義

**カテゴリ**: 新規 special-keys API の影響 - WorktreeDetailRefactored.tsx
**リスク**: medium

**問題**:
`current-output` API は `detectSessionStatus()` の結果を `isRunning`, `isGenerating`, `isPromptWaiting`, `thinking` の4つのフラグとして返している。`WorktreeDetailRefactored.tsx` は `CurrentOutputResponse` 型（L112-127）でこのレスポンスを受け取る。選択リスト検出状態を表す新フラグ（例: `isSelectionListActive`）の追加が必要だが、Issueに記載がない。これは以下の3層変更を意味する:

1. `current-output/route.ts` のレスポンス形式変更
2. `CurrentOutputResponse` 型の更新
3. `WorktreeDetailRefactored.tsx` での状態管理追加

**推奨対応**:
Issueのフロントエンドセクションに伝達パスを明記する。`detectSessionStatus()` -> `current-output` API -> `WorktreeDetailRefactored.tsx` のデータフロー設計を追加。

---

### F303: テスト対象ファイルと追加すべきテストケースの一覧が未記載

**カテゴリ**: テスト影響範囲
**リスク**: medium

**問題**:
受け入れ基準にテスト要件が含まれていない。影響を受けるテストファイル:

| テストファイル | 追加すべきテスト |
|--------------|----------------|
| `tests/unit/lib/cli-patterns.test.ts` | OPENCODE_SELECTION_LIST_PATTERN の正規表現テスト |
| `src/lib/__tests__/status-detector.test.ts` | opencode_selection_list reason の検出テスト |
| `tests/unit/terminal-route.test.ts` 相当 | 新規 special-keys API テスト |
| 既存全テスト | 回帰テスト（他CLIツールの誤検知防止） |

**推奨対応**:
受け入れ基準に「テスト」セクションを新設。特に回帰テスト（Claude/Codex/Gemini/vibe-local の検出結果が変わらないこと）は必須。

---

### F304: MessageInput へのキーボードインターセプト追加による既存キーハンドリングとの衝突リスク

**カテゴリ**: 既存コンポーネントへの影響 - MessageInput.tsx
**リスク**: medium

**問題**:
`MessageInput.tsx` の `handleKeyDown`（L231-266）は Escape, Enter, IME の3種のキーイベントをハンドリング済み。矢印キーのインターセプトを追加する場合:
- MessageInput 内か親コンポーネントかが未定義
- textarea の矢印キーはカーソル移動に使用されるため、複数行入力時の操作を阻害する可能性

**推奨対応**:
キーボードインターセプトは `MessageInput` の外側（`WorktreeDetailRefactored` または新規ナビゲーションボタンコンポーネント）で行い、`MessageInput` 自体は変更しない設計を推奨。textarea のフォーカス中に矢印キーを奪うとカーソル移動が壊れるため。

---

## Nice to Have（あれば良い）

### F305: OPENCODE_SELECTION_LIST_PATTERN の誤検知リスク評価

**カテゴリ**: cli-patterns.ts への変更影響
**リスク**: low

`status-detector.ts` 内で `cliToolId === 'opencode'` の分岐内でのみ使用される設計のため、他CLIツールへの直接影響はない。ただし、`OPENCODE_SKIP_PATTERNS` への追加可否は具体的なパターン確定後に判断が必要。

---

### F306: 選択リスト検出のパフォーマンスオーバーヘッド

**カテゴリ**: パフォーマンス影響
**リスク**: low

追加の `capture-pane` 呼び出しは不要（既存ポーリングサイクル内で実行）。OpenCode固有ブロック内でのみ正規表現マッチングが追加されるため、他CLIツール使用時のオーバーヘッドはゼロ。実装時に正規表現がバックトラッキングを起こさないことを確認すれば十分。

---

## 影響範囲マトリクス

| コンポーネント | 変更種別 | 影響度 | 備考 |
|--------------|---------|-------|------|
| `src/lib/cli-patterns.ts` | 新規パターン追加 | 中 | OPENCODE_SELECTION_LIST_PATTERN 新規定義 |
| `src/lib/status-detector.ts` | 検出分岐追加 | 高 | 優先順位設計が重要（F301） |
| `src/app/api/worktrees/[id]/special-keys/route.ts` | 新規ファイル | 低 | terminal API と同一パターン |
| `src/app/api/worktrees/[id]/current-output/route.ts` | レスポンス拡張 | 中 | isSelectionListActive 追加（F302） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | UI状態管理追加 | 中 | ナビゲーションボタン表示制御 |
| `src/components/worktree/MessageInput.tsx` | 変更なし推奨 | 低 | SRP維持のため変更回避（F304） |
| `src/lib/tmux.ts` | 変更なし | なし | sendSpecialKeys() は既存で十分 |
| `src/lib/tmux-capture-cache.ts` | 変更なし | なし | 既存キャッシュで対応可能 |
| `src/lib/prompt-answer-sender.ts` | 変更なし | なし | Claude専用ロジックに影響なし |

## 他CLIツールへの影響確認

| CLIツール | 影響 | 根拠 |
|-----------|------|------|
| Claude | なし | status-detector の OpenCode 分岐（L202-264）は `cliToolId === 'opencode'` で完全にガード |
| Codex | なし | 同上。cli-patterns.ts の codex ケースに変更なし |
| Gemini | なし | 同上。cli-patterns.ts の gemini ケースに変更なし |
| vibe-local | なし | 同上。cli-patterns.ts の vibe-local ケースに変更なし |

---

## 参照ファイル

### コード（直接変更対象）
- `src/lib/cli-patterns.ts`: 新規パターン定義（OPENCODE_SELECTION_LIST_PATTERN）
- `src/lib/status-detector.ts`: 選択リスト検出分岐追加（L202-264 OpenCode ブロック内）
- `src/app/api/worktrees/[id]/special-keys/route.ts`: 新規エンドポイント
- `src/app/api/worktrees/[id]/current-output/route.ts`: レスポンス拡張
- `src/components/worktree/WorktreeDetailRefactored.tsx`: UI制御追加

### コード（影響確認済み・変更不要）
- `src/lib/tmux.ts`: sendSpecialKeys() は既存で十分（ALLOWED_SPECIAL_KEYS ホワイトリスト済み）
- `src/lib/tmux-capture-cache.ts`: 既存キャッシュTTL=2秒で対応可能
- `src/lib/prompt-answer-sender.ts`: isClaudeMultiChoice 判定は Claude 専用、影響なし
- `src/components/worktree/MessageInput.tsx`: 変更回避推奨（F304）

### テスト（追加必須）
- `tests/unit/lib/cli-patterns.test.ts`: パターンテスト追加
- `src/lib/__tests__/status-detector.test.ts`: 検出分岐テスト追加
- 新規: special-keys API テスト
