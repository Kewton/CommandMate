# Issue #473 Stage 7: 影響範囲レビュー（2回目）

**レビュー日**: 2026-03-12
**対象Issue**: feat: OpenCode TUI選択リストのキーボードナビゲーション対応
**レビュー種別**: 影響範囲レビュー（2回目）

---

## 1. Stage 3 指摘の反映確認

Stage 3で指摘した6件（F301-F306）は **全て適切に反映されている**。

| ID | 反映状況 | 内容 |
|----|---------|------|
| F301 (must_fix) | 反映済み | 検出分岐の優先順位がIssue本文に明記された（priority 2.5内、B: thinkingの後、D: response_completeの前） |
| F302 (should_fix) | 反映済み | フロントエンドへの伝達パスが3層で記載された |
| F303 (should_fix) | 反映済み | テストセクションが受け入れ基準に新設された |
| F304 (should_fix) | 反映済み | 矢印キーインターセプトの実装場所が明記された |
| F305 (nice_to_have) | 反映済み | OPENCODE_SKIP_PATTERNS追加検討の注記が追加された |
| F306 (nice_to_have) | 反映済み（追記不要） | パフォーマンス影響は低い |

---

## 2. 新規指摘事項

### F701 [should_fix] keys配列内の不正キー名に対するHTTPステータスコードの明確化

**リスク**: medium

Issue のセキュリティ要件には「ALLOWED_SPECIAL_KEYS によるホワイトリスト検証（エンドポイント側でも二重チェック推奨）」と記載がある。しかし、tmux.ts の `ALLOWED_SPECIAL_KEYS` は `const`（非エクスポート）であるため、route.ts 側で二重チェックを実装する方法が2つある:

- **(a) tmux.ts から ALLOWED_SPECIAL_KEYS をエクスポートする** -- DRY原則に従い推奨
- **(b) route.ts 側に別途ホワイトリストを定義する** -- 2つのリストの同期維持が必要

Issue本文にどちらの方針を取るか明記されていない。また、エンドポイント側で事前バリデーションを行わない場合、tmux.ts 内部の throw が catch ブロックで 500 として返却される（レスポンス形式テーブルの 400 と矛盾）。

**提案**: tmux.ts から `ALLOWED_SPECIAL_KEYS` を export し、route.ts 側で再利用する方針をIssueに明記する。

---

### F702 [should_fix] 選択リスト検出時の isWaitingForResponse がサイドバーステータスに影響する

**リスク**: medium

`worktree-status-helper.ts` は `status === 'waiting'` を `isWaitingForResponse: true` にマッピングする（L92）。選択リスト検出時も `status: 'waiting'` が返るため、サイドバーで「応答待ち」ステータスが表示される。

検証結果:
- `hasActivePrompt: false` であるため、stale prompt cleanup は発動しない -- 正しい動作
- サイドバーの「応答待ち」表示は技術的には正しい（ユーザー操作待ち状態）
- ただし、通常の「プロンプト応答待ち」との区別がつかない

**提案**: これが意図された動作であることをIssueに注記する。将来 `hasActivePrompt` を変更する場合のリスクも記載すると安全。

---

### F703 [nice_to_have] 新規 special-keys API は認証ミドルウェアで自動保護される

**リスク**: low

`middleware.ts` の matcher パターンは `/api/worktrees/[id]/special-keys` にもマッチし、`AUTH_EXCLUDED_PATHS` にも含まれない。認証・IP制限ともに追加設定不要であることを確認した。

**提案**: Issue のセキュリティ要件に「認証ミドルウェア: 追加設定不要」と注記するとよい。

---

### F704 [nice_to_have] sendSpecialKeys 呼び出しパターンの分散

**リスク**: low

`sendSpecialKeys()` の呼び出しが `prompt-answer-sender.ts` と新規 `special-keys/route.ts` の2箇所に分散する。両者とも `invalidateCache()` を後続で呼ぶ必要があり、prompt-answer-sender.ts（L111）が既にこのパターンを実装している。現時点では過度な抽象化は不要。

**提案**: アクション不要。将来の共通処理追加時にファサード関数を検討。

---

## 3. 影響範囲の総合評価

### セキュリティモデルとの整合性
- 認証ミドルウェア: 自動的にカバーされる（追加設定不要）
- 入力バリデーション: terminal API の4層防御パターンを踏襲する設計で整合
- `ALLOWED_SPECIAL_KEYS` のエクスポート方針のみ要明確化（F701）

### 他CLIツールへの影響
- 選択リスト検出は `cliToolId === 'opencode'` ブロック内に閉じ込められるため、Claude/Codex/Gemini/vibe-local への影響は **なし**
- `detectSessionStatus()` の priority 2.5 OpenCode固有ブロック内に挿入する設計は、既存の検出フローを一切変更しない

### ポーリングアーキテクチャとの整合性
- `isSelectionListActive` フラグは既存の `current-output` レスポンスに追加する形式で、ポーリング頻度やキャッシュTTLに変更なし
- `invalidateCache()` の追加はterminal API と同じパターンで整合

### テスト要件の網羅性
- 受け入れ基準のテストセクションは網羅的。特に回帰テスト（他CLIツール誤検知防止、既存テストパス確認）が明記されている点は適切

---

## 4. 統計

| 分類 | 件数 |
|------|------|
| must_fix | 0 |
| should_fix | 2 |
| nice_to_have | 2 |
| **合計** | **4** |

---

## 5. 結論

Stage 3の全6件の指摘が適切に反映されており、Issueの品質は大幅に向上している。2回目の影響範囲レビューでは重大な問題（must_fix）は検出されなかった。should_fix 2件は実装前に対処することで実装品質を向上させることができるが、ブロッカーではない。全体として、本Issueは実装着手可能な状態にある。
