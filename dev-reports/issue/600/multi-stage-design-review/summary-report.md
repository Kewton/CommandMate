# マルチステージ設計レビュー完了報告

## Issue #600: ホーム中心のUX刷新とWorktree Detail中心導線の再設計

### ステージ別結果

| Stage | レビュー種別 | レビュアー | Must Fix | Should Fix | Nice to Have | 対応数 | ステータス |
|-------|------------|-----------|---------|-----------|-------------|-------|----------|
| 1 | 通常レビュー（設計原則） | opus | 2 | 5 | 3 | 7/7 | 完了 |
| 2 | 整合性レビュー | opus | 2 | 6 | 4 | 10/10 | 完了 |
| 3 | 影響分析レビュー | opus (fallback) | 2 | 5 | 3 | 8/8 | 完了 |
| 4 | セキュリティレビュー | opus | 2 | 5 | 3 | 10/10 | 完了 |
| **合計** | | | **8** | **21** | **13** | **35/35** | **完了** |

### 主要な設計改善

#### Stage 1（設計原則）
- `useLayoutConfig()` フック導入でAppShell.tsxのSRP準拠
- Stalled判定を `stalled-detector.ts` に分離（DIP準拠）
- `SimpleMessageInput` + `useSendMessage()` フック方式に変更
- `useWorktreeList()` 共通フック、`useWorktreesCache()` キャッシュ設計
- WorktreeDetailRefactored事前分割戦略

#### Stage 2（整合性）
- Issue本文と設計方針書の矛盾解消（SimpleMessageInput方式、useLayoutConfig方式）
- `DeepLinkPane` 型新設、既存型との変換ロジック設計
- Phase依存関係マトリクス追加
- APIレスポンス全体構造の明確化

#### Stage 3（影響分析）
- `useSendMessage()` の責務範囲明確化（API呼び出しのみ、副作用はコールバック）
- `useWorktreeList()` のステートレス設計（ソート状態は呼び出し側）
- テスト影響範囲を38ファイル以上に修正
- `useWorktreesCache()` をPhase 1に前倒し配置

#### Stage 4（セキュリティ）
- 新規4画面の認証保護テストをMust Fix昇格
- `?pane=xxx` ランタイムホワイトリスト検証（`isDeepLinkPane()` 型ガード）
- `?include=review` パラメータの許可値検証
- SimpleMessageInputのサニタイズ方針（XSS対策）
- CSP方針の明記

### 設計方針書の品質

- SOLID/KISS/YAGNI/DRY原則への準拠: 確認済み
- OWASP Top 10準拠: 確認済み
- 既存コードベースとの整合性: 確認済み
- Phase間依存関係: マトリクスで明確化済み

### 次のアクション

- [ ] 設計方針書の最終確認
- [ ] /work-plan で作業計画立案
- [ ] /pm-auto-dev でTDD実装開始
