# Issue #525 セキュリティレビュー (Stage 4)

**対象**: Auto-Yesエージェント毎独立制御 設計方針書
**レビュー種別**: セキュリティ (OWASP Top 10 準拠確認)
**日付**: 2026-03-20
**ステータス**: conditionally_approved
**スコア**: 4/5

---

## Executive Summary

Issue #525 の設計方針書は、Auto-Yes機能の状態管理キーを `worktreeId` 単体から `worktreeId:cliToolId` 複合キーに変更する設計である。セキュリティ観点から、既存のセキュリティ機構（worktreeIdバリデーション、cliToolIdホワイトリスト、duration/stopPatternバリデーション、認証ミドルウェア、MAX_CONCURRENT_POLLERS制限）は全て維持される設計となっており、基本的なセキュリティ水準は確保されている。

compositeKeyの生成・分解に関するバリデーション戦略（MF-001）が設計に組み込まれている点は評価できる。ただし、extractWorktreeIdの全使用箇所でのバリデーション保証が不十分であり、1件のMust Fix項目を指摘する。

---

## OWASP Top 10 チェックリスト

| # | カテゴリ | 判定 | 詳細 |
|---|---------|------|------|
| A01 | Broken Access Control | PASS (注記あり) | worktreeId/cliToolIdバリデーション維持。GET APIにisValidWorktreeId欠落(SEC4-SF-003) |
| A02 | Cryptographic Failures | PASS | 暗号化・機密情報に関する変更なし |
| A03 | Injection | 条件付きPASS | compositeKey分解時のバリデーション保証が一部不十分(SEC4-MF-001) |
| A04 | Insecure Design | PASS (注記あり) | per-worktreeポーラー上限の欠如(SEC4-SF-001)、区切り文字の暗黙的依存(SEC4-SF-004) |
| A05 | Security Misconfiguration | PASS (注記あり) | GET APIのworktreeIdバリデーション不一致(SEC4-SF-003) |
| A06 | Vulnerable Components | PASS | 新たな外部依存なし |
| A07 | Identification/Authentication | PASS | 認証ミドルウェア変更なし |
| A08 | Data Integrity | PASS | in-memory状態管理の整合性はcompositeKeyで担保 |
| A09 | Logging/Monitoring | PASS (注記あり) | バリデーション失敗時ログ出力の推奨(SEC4-C-001) |
| A10 | SSRF | N/A | 外部リクエスト処理なし |

---

## セキュリティ分析: 入力バリデーションの網羅性

### 既存バリデーション (変更なし)

| バリデーション | 対象 | 実装箇所 | 状態 |
|--------------|------|---------|------|
| isValidWorktreeId() | worktreeId形式 | path-validator.ts | 維持 |
| isAllowedDuration() | durationホワイトリスト | auto-yes-config.ts | 維持 |
| validateStopPattern() | stopPattern ReDoS防止 | auto-yes-config.ts | 維持 |
| isValidCliTool() / isCliToolType() | cliToolIdホワイトリスト | route.ts / cli-tools/types.ts | 維持 |

### 新規バリデーション (設計方針書で定義)

| バリデーション | 対象 | 設計箇所 | 評価 |
|--------------|------|---------|------|
| MF-001 compositeKeyバリデーション | deleteAutoYesState, checkStopCondition | Section 4-1 | 適切。extractWorktreeId + isValidWorktreeId + extractCliToolId + isValidCliToolの多段バリデーション |
| isCliToolType()統合 | current-output/route.ts | Section 4-3 (CS-SF-002) | 適切。バリデーション追加 |
| POST cliToolId検証 | auto-yes/route.ts POST | Section 4-3 | 適切。isValidCliTool + 400エラー返却 |

### 網羅性の評価

設計方針書では `deleteAutoYesState` と `checkStopCondition` の2関数についてcompositeKeyバリデーション方針を定義しているが、`extractWorktreeId` を使用する他の箇所での保証が明示的でない。

**extractWorktreeIdの使用箇所と安全性:**

| 使用箇所 | バリデーション | 安全性 |
|---------|--------------|--------|
| deleteAutoYesState() | MF-001で明示的に定義 | 安全 |
| checkStopCondition() | MF-001で明示的に定義 | 安全 |
| incrementErrorCount() | compositeKeyはpollerStatesから取得（信頼済み） | 条件付き安全 |
| stopAutoYesPollingByWorktree() | worktreeIdは引数として受け取り、compositeKeyは自Map走査 | 条件付き安全 |
| cleanupOrphanedMapEntries() | compositeKeyはautoYesStatesから取得。extractした値をDB照合に使用 | **要検証** |

---

## セキュリティ分析: compositeKeyの攻撃ベクトル

### 1. compositeKey生成 (buildCompositeKey)

```
入力: worktreeId (string) + cliToolId (CLIToolType)
出力: "worktreeId:cliToolId"
```

**攻撃ベクトル**: cliToolIdは型レベルでCLIToolTypeに制限されているため、buildCompositeKeyの入力段階では安全。worktreeIdについてはAPI層のisValidWorktreeId()バリデーションが必須の前提。

**評価**: 設計方針書で「入力のworktreeIdとcliToolIdは呼び出し前に既存バリデーションで検証済みを前提」と明記されており適切。ただし、この前提の遵守はコードレビューに依存する。

### 2. compositeKey分解 (extractWorktreeId / extractCliToolId)

```
入力: compositeKey (string)
処理: lastIndexOf(':')で分割
出力: worktreeId部分 / cliToolId部分
```

**攻撃ベクトル**:
- コロンを含まないキー: extractWorktreeIdは元の文字列をそのまま返す。extractCliToolIdはnullを返す。
- 複数コロンを含むキー: lastIndexOfにより最後のコロンで分割。worktreeId部分にコロンが含まれる結果になる。

**評価**: 現時点ではisValidWorktreeId()が英数字+ハイフンに制限しているため複数コロンのケースは発生しないが、この依存関係が暗黙的である点を SEC4-SF-004 で指摘。

### 3. Map操作における安全性

compositeKeyをMapのキーとして使用する設計はインジェクション攻撃に対して本質的に安全である。MapのキーはJavaScript文字列として厳密に比較されるため、不正なキーは既存エントリと一致せず、不正なエントリの読み取りや上書きは発生しない。

---

## セキュリティ分析: リソース枯渇攻撃

### ポーラー数制限

| 項目 | 変更前 | 変更後 |
|------|--------|--------|
| ポーラー数/worktree | 最大1 | 最大5 |
| 全体上限 | MAX_CONCURRENT_POLLERS=50 | 同上（維持） |
| 上限到達条件 | 50 worktrees | 10 worktrees x 5 agents |
| tmux capture頻度 | 2秒/worktree | 2秒/agent/worktree |

**攻撃シナリオ**: 認証済みクライアントが全worktreeの全エージェントに対してauto-yesを有効化し、50ポーラーを飽和させる。これにより新規のauto-yes有効化が拒否される。

**既存の緩和策**:
- MAX_CONCURRENT_POLLERS=50 による絶対上限
- 認証ミドルウェアによる未認証アクセス拒否
- 1時間のauto-yesタイムアウト（自動期限切れ）
- 指数バックオフによるエラー時のポーリング間隔拡大
- MAX_CONSECUTIVE_ERRORS による連続エラー時の自動停止

**評価**: 既存の緩和策は十分だが、per-worktreeのポーラー上限がないため、少数のworktreeで全ポーラー枠を消費できる点を SEC4-SF-001 で指摘。

---

## セキュリティ分析: 認証・認可の一貫性

| APIエンドポイント | 認証 | worktreeId検証 | cliToolId検証 | 評価 |
|-----------------|------|---------------|--------------|------|
| POST /auto-yes | middleware.ts | isValidWorktreeId + DB存在 | isValidCliTool | 適切 |
| GET /auto-yes | middleware.ts | DB存在のみ | isValidCliTool (指定時) | **SEC4-SF-003** |
| GET /current-output | middleware.ts | isValidWorktreeId + DB存在 | isCliToolType (CS-SF-002で追加) | 適切 |

GET /auto-yes のworktreeIdフォーマットバリデーション欠落は既存実装にも存在する問題だが、compositeKey化に伴う本変更で修正すべきである。

---

## セキュリティ分析: クリーンアップ処理

### session-cleanup.ts

byWorktreeヘルパー方式の採用により、auto-yesの内部キー構造がクリーンアップ側に露出しない設計は適切。クリーンアップ処理自体はworktreeId指定で呼ばれるため、追加のバリデーションリスクは低い。

### resource-cleanup.ts

cleanupOrphanedMapEntries内でextractWorktreeIdの結果をDB照合に使用するフローでは、compositeKeyはautoYesStates Mapから取得されるため、Map内に不正なキーが存在しない限り安全である。Map内のキーはbuildCompositeKey経由で生成されるため、API層のバリデーションが正しく機能していればMap内のキーの正当性は担保される。

**残存リスク**: globalThisの直接操作やモジュールバグによりMap内に不正なキーが混入した場合の防御がない。SEC4-MF-001で指摘。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| セキュリティ | extractWorktreeIdの戻り値が未検証のまま使用される可能性 | Medium | Low | P2 |
| セキュリティ | per-worktreeポーラー上限の欠如によるリソース枯渇 | Low | Low | P3 |
| セキュリティ | GET APIのworktreeIdフォーマット検証欠落 | Low | Low | P3 |
| セキュリティ | 不正cliToolIdのフォールバック動作の不一致 | Medium | Low | P2 |
| セキュリティ | compositeKey区切り文字の暗黙的依存 | Low | Very Low | P3 |

---

## 改善勧告

### 必須改善項目 (Must Fix): 1件

**SEC4-MF-001**: extractWorktreeIdの全使用箇所でのバリデーション保証

設計方針書Section 7（セキュリティ設計）に以下を追記すること:

- extractWorktreeIdの戻り値をDB照合やセキュリティ境界を越える処理に使用する全ての箇所で、isValidWorktreeId()による事後バリデーションを必須とするルールの明記
- 特にresource-cleanup.tsのcleanupOrphanedMapEntries内での防御的バリデーション追加
- または、extractWorktreeId自体にバリデーションを組み込む設計変更の検討

### 推奨改善項目 (Should Fix): 4件

**SEC4-SF-001**: MAX_CONCURRENT_POLLERS制限の再評価
- per-worktreeポーラー上限の検討結果を設計方針書に明記

**SEC4-SF-002**: POST API cliToolIdバリデーションの統一
- 不正なcliToolIdに対してフォールバックではなく400エラーを返す設計を明確化

**SEC4-SF-003**: GET APIのisValidWorktreeId追加
- POST側と同等のセキュリティレベルをGET側にも適用

**SEC4-SF-004**: compositeKey区切り文字の防御的検証
- buildCompositeKey内でのアサーション追加を設計に盛り込む

### 検討事項 (Consider): 3件

**SEC4-C-001**: compositeKeyバリデーション失敗時のセキュリティログ出力
**SEC4-C-002**: byWorktreeヘルパーの線形走査によるタイミング攻撃（実質リスク極低）
**SEC4-C-003**: auto-yes APIエンドポイントのレート制限（既知の課題、将来Issue推奨）

---

## 既存セキュリティ機構の維持確認

| セキュリティ機構 | 維持状態 | 根拠 |
|----------------|---------|------|
| worktreeId形式検証 (SEC-MF-001) | 維持 | 設計方針書Section 7で明記 |
| durationホワイトリスト (SEC-SF-002) | 維持 | 設計方針書Section 7で明記 |
| stopPattern ReDoS防止 (SEC-SF-003) | 維持 | 設計方針書Section 7で明記 |
| cliToolIdホワイトリスト (SEC-SF-004) | 維持 | 設計方針書Section 7で明記 |
| 認証ミドルウェア | 維持 | 変更なし |
| MAX_CONCURRENT_POLLERS=50 | 維持 | 設計方針書Section 8で明記 |
| tmuxコマンドサニタイズ | 維持 | 変更なし |
| 指数バックオフ | 維持 | 変更なし |
| 1時間タイムアウト | 維持 | 変更なし |

---

## 結論

設計方針書は既存のセキュリティ機構を適切に維持しつつ、compositeKeyに関する新たなバリデーション戦略（MF-001）を定義している点で評価できる。Must Fix 1件（extractWorktreeIdのバリデーション保証の明示化）を対応することで、セキュリティ観点から承認可能である。

全体として、本設計変更によるセキュリティリスクの増加は軽微であり、既存の多層防御（認証ミドルウェア、入力バリデーション、リソース上限、タイムアウト、バックオフ）が引き続き有効に機能する。

---

*Reviewed by: Architecture Review Agent (Stage 4 - Security)*
*Date: 2026-03-20*
