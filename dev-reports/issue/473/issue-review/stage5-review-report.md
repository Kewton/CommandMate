# Issue #473 Stage 5: 通常レビュー（2回目）

**レビュー日**: 2026-03-12
**レビュー対象**: GitHub Issue #473 (feat: OpenCode TUI選択リストのキーボードナビゲーション対応)
**前回ステージ**: Stage 1-4 (通常レビュー1回目 + 反映 + 影響範囲レビュー + 反映)

---

## 前回指摘の反映確認

### Stage 1 指摘 (F001-F008): 全8件 反映済み

| ID | 重要度 | 反映状況 | 確認結果 |
|----|--------|----------|----------|
| F001 | must_fix | 反映済み | 新規 special-keys エンドポイント設計が追加され、sendKeys/sendSpecialKeys の動作差異が明記されている |
| F002 | must_fix | 反映済み | prompt-response API が Claude multiple_choice 専用であり OpenCode に適用不可という注記が追加されている |
| F003 | must_fix | 反映済み | cli-patterns.ts パターン新規定義の必要性、status-detector.ts 検出分岐追加、サンプル取得前提作業が明記されている |
| F004 | should_fix | 反映済み | バックエンド受け入れ基準セクションが4項目で新設されている |
| F005 | should_fix | 反映済み | 5項目のセキュリティ要件が明記されている |
| F006 | should_fix | 反映済み | 前提作業としてのサンプル取得フェーズが [前提作業] タグ付きで記載されている |
| F007 | nice_to_have | 反映済み | NavigationButtons コンポーネントのフォーカス管理方針、受け入れ基準への「既存操作に影響しないこと」追加 |
| F008 | nice_to_have | 反映済み | CLI ツール非依存の汎用設計方針がスコープ外セクションとエンドポイント設計に追記されている |

### Stage 3 指摘 (F301-F304): 全4件 反映済み

| ID | 重要度 | 反映状況 | 確認結果 |
|----|--------|----------|----------|
| F301 | must_fix | 反映済み | 検出分岐の優先順位が priority 2.5 ブロック内に図付きで明記され、返却値も定義されている |
| F302 | should_fix | 反映済み | 3層伝達パスと CurrentOutputResponse 型変更が記載されている |
| F303 | should_fix | 反映済み | テストセクションが新設され、パターンテスト・検出テスト・APIテスト・回帰テスト5項目が追加されている |
| F304 | should_fix | 反映済み | NavigationButtons コンポーネントでのハンドリング方針が SRP 根拠付きで明記されている |

### F305, F306 (nice_to_have)

| ID | 重要度 | 反映状況 | 確認結果 |
|----|--------|----------|----------|
| F305 | nice_to_have | 反映済み | 実装時の確認事項として OPENCODE_SKIP_PATTERNS への追加検討が記載されている |
| F306 | nice_to_have | 対応不要 | 元の指摘自体が「Issue への追記は不要」という結論だった |

---

## 新規指摘事項

### F501 [should_fix] special-keys API のレスポンス形式が未定義

**カテゴリ**: 設計の完全性
**箇所**: バックエンド: 新規 special-keys エンドポイント

リクエストボディ `{ cliToolId: string, keys: string[] }` は明記されているが、レスポンス形式（正常系/異常系）が未定義。

既存の terminal API のレスポンスパターン:
- 200: `{ success: true }`
- 400: `{ error: 'Invalid cliToolId parameter' }` / `{ error: 'Missing command parameter' }`
- 404: `{ error: 'Worktree not found' }` / `{ error: 'Session not found...' }`
- 500: `{ error: 'Failed to send command to terminal' }`

また `sendSpecialKeys()` は各キー間に100msディレイを持つため、keys 配列の最大長10キーの場合レスポンス時間は約1秒となる。フロントエンド側のタイムアウト設定に影響する可能性がある。

**改善案**: レスポンス形式を既存 terminal API 準拠で明記し、レスポンス時間特性（keys.length * 100ms）も注記する。

### F502 [should_fix] 検出分岐の優先順位図が実コードの priority 2.5 内部構造と齟齬がある

**カテゴリ**: 整合性
**箇所**: 検出分岐の優先順位（F301対応）

Issue の優先順位図では priority 2.5 ブロック内を以下の3分岐で記載している:

```
2.5. OpenCode固有検出
    ├── processing_indicator チェック（既存）
    ├── selection_list チェック（新規）
    └── response_complete チェック（既存）
```

しかし `status-detector.ts`（L202-263）の実コードでは:

```
2.5. OpenCode固有検出
    ├── (A) processing_indicator チェック（L204）
    ├── (B) detectThinking() による thinking チェック（L240）  ← Issue図で省略
    └── (C) OPENCODE_RESPONSE_COMPLETE チェック（L254）
```

分岐B（thinking チェック）が Issue 図から省略されているため、selection_list の正確な挿入位置が不明瞭。選択リスト表示中に `Thinking:` パターンが表示されることは通常ないため、挿入位置は (B) と (C) の間が妥当。

**改善案**: 優先順位図を `(A) processing_indicator -> (B) thinking -> (C) selection_list -> (D) response_complete` に修正する。

### F503 [nice_to_have] special-keys API での invalidateCache() 呼び出しが未記載

**カテゴリ**: 実装パターンの一貫性
**箇所**: バックエンド: 新規 special-keys エンドポイント

既存の terminal API（route.ts L82）は `sendKeys()` 後に `invalidateCache(sessionName)` を呼んでキャプチャキャッシュを無効化している（Issue #405）。新規 API でもキー送信後に画面状態が変化するため、同様のキャッシュ無効化が必要。呼ばない場合、キー送信後の UI 更新が tmux-capture-cache の TTL（2秒）分遅延する。

**改善案**: エンドポイント設計に `invalidateCache(sessionName)` 呼び出しを含める旨を追記する。

---

## 統計

| 重要度 | 件数 |
|--------|------|
| must_fix | 0 |
| should_fix | 2 |
| nice_to_have | 1 |
| **合計** | **3** |

---

## 総合評価

Issue #473 は Stage 1-4 の全14件の指摘（F001-F008, F301-F306）が適切に反映され、実装に必要な情報が十分に記載されている状態に到達している。

**特に良い点:**
- 新規 special-keys エンドポイントの設計が明確（パス、リクエスト形式、セキュリティ要件5項目）
- 検出分岐の優先順位が priority 2.5 ブロック内配置として具体的に定義されている
- フロントエンドへの状態伝達パスが 3 層（status-detector -> current-output API -> WorktreeDetailRefactored）で明確化されている
- テスト要件が回帰テスト（他CLIツール誤検知防止、既存テスト回帰）を含めて網羅的に定義されている
- MessageInput 変更不要の方針が SRP 根拠付きで明確であり、受け入れ基準にも含まれている
- 前提作業（tmux capture-pane サンプル取得）が明記されており、パターン未確定のリスクが管理されている
- prompt-response API の適用制限が正確に記述されている

**残存リスク（Issue 自体が認識済み）:**
- OpenCode TUI の具体的な出力パターンが未確定（前提作業として認識済み）
- OPENCODE_SKIP_PATTERNS への追加要否は具体的パターン確定後に判断（F305 として認識済み）

2回目の通常レビューで検出された3件はいずれも軽微であり、実装の進行を妨げるものではない。**Issue は実装着手可能な品質に達している。**
