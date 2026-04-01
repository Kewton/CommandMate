# Issue #600 Stage 3: Impact Analysis Review (影響範囲分析)

## Review Metadata

| Item | Value |
|------|-------|
| Issue | #600 - Home中心のUX刷新とWorktree Detail中心導線の再設計 |
| Stage | 3: 影響範囲分析 |
| Reviewer | Claude Opus (fallback from Codex) |
| Date | 2026-04-01 |
| Target | dev-reports/design/issue-600-ux-refresh-design-policy.md |
| Prior Reviews | Stage 1 (設計原則), Stage 2 (整合性) |

## Summary

Must Fix: 2 / Should Fix: 5 / Nice to Have: 3

設計方針書は既存コードベースの構造を適切に理解した上で設計されているが、実装時に想定外の波及が生じる箇所が複数確認された。特に、useSendMessage()フックの責務範囲の曖昧さ(MessageInputの複雑な副作用チェーンとの統合方法が未定義)と、useWorktreeList()共通化がSidebarContextのlocalStorage永続化パターンと衝突する問題がMust Fixとして指摘される。Phase依存関係ではuseWorktreesCache()のPhase 2配置による手戻りリスクが存在する。テスト影響範囲は38ファイル以上に及び、設計方針書の見積もりを上回る。

---

## Findings

### DR3-001 [Must Fix] - 波及効果

**MessageInput送信ロジック抽出がuseImageAttachment・WorktreeDetailRefactoredの状態管理に波及する**

useSendMessage()フックの責務範囲が設計方針書で明確でない。現在のMessageInputの送信処理はWorktreeDetailRefactored内のonSendMessage経由で実行されており、useImageAttachment(resetAfterSend)、chat-db永続化、terminal APIキー送信(session-key-sender)、pasted-text-helperによるEnter再送など複数の副作用と連携している。これらの副作用のうち何をフックに含め、何をコールバックに残すかが未定義。

**Recommendation**: useSendMessage()はAPI呼び出し(terminal API送信 + chat-db永続化)のみを責務とし、画像添付リセット・pasted-text処理はMessageInput側のonSuccess/onErrorコールバックで処理する設計を明記する。

---

### DR3-002 [Should Fix] - テスト範囲

**WorktreeDetailRefactored分割に伴う既存テスト38ファイルへの波及が過小評価されている**

テスト戦略の「23ファイル以上」は実際には38ファイル以上。WorktreeDetailRefactored-mobile-overflow.test.tsx、WorktreeDetailRefactored-cli-tab-switching.test.tsx、WorktreeDetailRefactored.test.tsx、worktree-detail-integration.test.tsxの4ファイルは分割後のコンポーネント構造に合わせた根本的書き換えが必要。

**Recommendation**: テスト数を修正し、上記4ファイルの書き換え工数をPhase 2の独立タスクとして明記する。

---

### DR3-003 [Should Fix] - 波及効果

**page.tsxの全面書き換えがRepositoryManager等の移動先への導線設計が不足**

Phase 1でRepositoryManagerを/repositories、WorktreeListを/sessions、ExternalAppsManagerを/moreに移動する際、/(ルート)にアクセスした従来ユーザーの混乱リスクがある。

**Recommendation**: Home画面に移動先への目立つショートカットカードを配置し、初回アクセス時のUI変更案内を検討する。

---

### DR3-004 [Should Fix] - Phase依存

**Phase 2のuseWorktreesCache()導入がPhase 1作成済み画面に後方修正を要求する**

Phase 1で各画面が独自にfetchする実装になった後、Phase 2でキャッシュ層に統合する際にPhase 1全画面のデータ取得ロジック書き換えが必要。一時的にDR1-009(ポーリング競合)問題を抱える。

**Recommendation**: useWorktreesCache()をPhase 1に前倒しするか、Phase 1でフェッチロジックをキャッシュフックのインターフェースに合わせた薄いラッパーで実装する。

---

### DR3-005 [Should Fix] - 波及効果

**useLayoutConfig()導入時のデフォルト値が既存2画面の挙動を変更するリスク**

現在のAppShellにはGlobalMobileNav表示/非表示の概念がなく、useLayoutConfig()導入と同時にこの概念を追加すると、/worktrees/:idの既存MobileTabBarとの整合性に注意が必要。

**Recommendation**: useLayoutConfig()のデフォルト値が導入前後で既存画面の挙動を変化させないことを検証するユニットテストをPhase 1テスト戦略に追加する。

---

### DR3-006 [Nice to Have] - パフォーマンス

**Stalled判定のO(1)記述がAPIルート全体のO(N)と混同されうる**

各worktreeのStalled判定はO(1)だが、API全体ではworktree数に比例してO(N)。worktree < 50では問題ないが、記述の明確化を推奨。

---

### DR3-007 [Nice to Have] - 後方互換性

**新規4画面URL追加のmiddleware保護テスト具体化**

AUTH_EXCLUDED_PATHSへの誤追加検出とconfig.matcherパターンの正規表現テストの追加を推奨。

---

### DR3-008 [Nice to Have] - 後方互換性

**CLI側コマンドのAPI後方互換性テスト具体化**

src/cli/types/api-responses.tsとsrc/cli/commands/ls.tsを検証対象として明記し、?include=reviewなし時のレスポンスに追加フィールドが混入しないことのアサーションを推奨。

---

### DR3-009 [Must Fix] - 波及効果

**useWorktreeList()共通フック抽出がSidebarContextのソート状態管理と衝突する**

SidebarのソートはSidebarContext.tsx(localStorage永続化)で管理されている。useWorktreeList()がソートロジックを含む場合、Sessions画面のソート状態をSidebarContextと共有するとSidebar変更がSessions画面に波及する。独立したソート状態の保持方法が未定義。

**Recommendation**: useWorktreeList({ worktrees, sortKey, sortDirection, viewMode, searchQuery })のように外部から状態を注入するインターフェースとし、状態の保持は呼び出し側(SidebarContext or Sessions画面ローカルstate)に委ねる設計を明記する。

---

### DR3-010 [Should Fix] - パフォーマンス

**Review画面ポーリングとuseWorktreesCache()の2系統並行リスク**

Review画面の?include=review付き7秒ポーリングと共有キャッシュの通常ポーリングが並行する。

**Recommendation**: Review画面在中時は共有キャッシュのフェッチが?include=reviewを付与し、baseデータとreviewデータの両方を更新する拡張モードを設ける。

---

## Impact Matrix

| Affected Area | Files | Severity | Phase |
|--------------|-------|----------|-------|
| MessageInput副作用チェーン | MessageInput.tsx, WorktreeDetailRefactored.tsx, useImageAttachment.ts, session-key-sender.ts | Must Fix | Phase 2 |
| SidebarContext状態管理 | SidebarContext.tsx, Sidebar.tsx, sidebar-utils.ts, SortSelector.tsx | Must Fix | Phase 1 |
| テストファイル群 | 38ファイル (unit 15 + integration 23) | Should Fix | Phase 2-3 |
| Home画面コンポーネント移動 | page.tsx, RepositoryManager.tsx, ExternalAppsManager.tsx | Should Fix | Phase 1 |
| ポーリングキャッシュ統合 | useWorktreesCache.ts, Review画面, Home画面, Sessions画面 | Should Fix | Phase 1-2 |
| useLayoutConfig既存画面 | AppShell.tsx, page.tsx, worktrees/[id]/page.tsx | Should Fix | Phase 1 |

---

## Review Result File

`/Users/maenokota/share/work/github_kewton/commandmate-issue-600/dev-reports/issue/600/multi-stage-design-review/stage3-review-result.json`
