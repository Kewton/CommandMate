# Architecture Review Report: Issue #600 Stage 1 - 設計原則レビュー

| 項目 | 内容 |
|------|------|
| Issue | #600 |
| Stage | 1 (通常レビュー) |
| Focus | 設計原則 (SOLID / KISS / YAGNI / DRY / コンポーネント設計 / 状態管理 / API設計) |
| Reviewer | opus |
| Date | 2026-04-01 |
| Status | conditionally_approved |
| Score | 3.5 / 5 |

---

## Executive Summary

Issue #600 の設計方針書「ホーム中心のUX刷新とWorktree Detail中心導線の再設計」に対して、設計原則の観点からレビューを実施した。

全体として、DBスキーマ変更なし、既存API後方互換、段階的Phase実装という3つの基本方針は堅実であり、Derived State パターンによる Review ステータスのリアルタイム算出も適切な判断である。一方、SOLID原則の観点で Must Fix 2件、Should Fix 5件の指摘がある。特に AppShell への条件分岐集中と worktree-status-helper への責務混在は、今後の保守性に直結する問題であり、実装前の設計修正を推奨する。

---

## Detailed Findings

### Must Fix (2件)

#### DR1-003: AppShell.tsx への pathname 条件分岐集中による SRP 違反

| 項目 | 内容 |
|------|------|
| Category | SOLID (SRP) |
| Location | セクション3-4 Conditional Layout パターン / Phase 1 実装計画 |

**問題**: 設計方針書では AppShell.tsx 内で `usePathname()` に基づき、サイドバー折りたたみ、GlobalMobileNav 表示/非表示、ローカルナビ表示/非表示などのレイアウト制御を行うと記載されている。これらの条件分岐が AppShell に集中すると、新画面追加のたびに AppShell を修正する必要がある。SidebarContext に `autoCollapsedPaths` を追加する設計も、レイアウト判断ロジックが Context と AppShell に分散する問題を生む。

**改善提案**: pathname に基づくレイアウト判断を専用の `useLayoutConfig(pathname)` フックに集約する。このフックが `{ showSidebar, showGlobalNav, showLocalNav, autoCollapseSidebar }` のようなフラグオブジェクトを返し、AppShell はそのフラグに基づいて描画するだけにする。新画面追加時はフック内のマッピングテーブルを更新するだけで済む。

#### DR1-010: worktree-status-helper.ts への Stalled 判定ロジック追加が DIP に違反

| 項目 | 内容 |
|------|------|
| Category | SOLID (DIP) |
| Location | セクション9 パフォーマンス設計 / Phase 2 実装計画 |

**問題**: worktree-status-helper.ts に Stalled 判定を追加し、auto-yes-manager.ts の `getLastServerResponseTimestamp()` を直接参照する設計。現在の worktree-status-helper.ts は既に auto-yes-manager からインポートしているが、Stalled 判定という新しいビジネスルール（閾値比較、`STALLED_THRESHOLD_MS`）をこのヘルパーに追加すると、セッション検出の責務と Review ビジネスルールの責務が混在する。

**改善提案**: Stalled 判定ロジックを `next-action-helper.ts`（または `stalled-detector.ts`）に配置し、worktree-status-helper.ts は純粋にセッションステータス検出に留める。API ルートハンドラが `?include=review` の場合のみ Stalled 判定モジュールを呼び出す構成にすることで、責務を明確に分離できる。

---

### Should Fix (5件)

#### DR1-001: MessageInput variant 追加による SRP 違反リスク

| 項目 | 内容 |
|------|------|
| Category | SOLID (SRP) |
| Location | セクション3-2 Variant パターン / セクション10 |

**問題**: MessageInput.tsx は既に474行あり、下書き永続化、スラッシュコマンド、画像添付、IME制御など多数の責務を持つ。simplified 版は「テキスト入力 + 送信ボタンのみ」であり、default 版と共有するロジックは送信処理のみ。共有部分が少ないにもかかわらず同一コンポーネントに押し込むのは SRP 的に不適切。

**改善提案**: 送信ロジックを `useSendMessage()` フックに抽出し、`MessageInput`（フル機能版）と `SimpleMessageInput`（軽量版）に分離する。

#### DR1-002: getNextAction() の OCP 違反

| 項目 | 内容 |
|------|------|
| Category | SOLID (OCP) |
| Location | セクション3-3 Derived State パターン |

**問題**: `getNextAction()` は if 文の連鎖で次アクションを決定しており、新しいステータス追加時に関数本体の修正が必要。

**改善提案**: アクションマッピングテーブルとして定義することを検討。ただし YAGNI とのバランスを考え、現時点では許容範囲でもある。

#### DR1-005: Sessions 画面とサイドバーの DRY 違反

| 項目 | 内容 |
|------|------|
| Category | DRY |
| Location | セクション6-2 Sessions 画面 / セクション10 |

**問題**: WorktreeList のフィルタリング・ソート・検索ロジックと Sidebar のソート・グループ化ロジック（sidebar-utils.ts）が並行して存在し続ける。

**改善提案**: 共通フック `useWorktreeList()` にデータ取得・加工ロジックを抽出し、Sessions 画面と Sidebar の両方が利用する。

#### DR1-007: WorktreeDetailRefactored（1966行）の分割戦略欠如

| 項目 | 内容 |
|------|------|
| Category | コンポーネント設計 |
| Location | セクション6-6 / セクション13 |

**問題**: 1966行のコンポーネントへの useSearchParams 移行、ヘッダー追加、deep link 対応が Phase 分割のみで軽減策とされているが、具体的な分割計画がない。

**改善提案**: 先行リファクタリングとして、(1) WorktreeDetailHeader 抽出、(2) useWorktreeTabState フック抽出、(3) Desktop/Mobile 分離を行う。

#### DR1-009: Review 画面のポーリングと他画面のポーリング競合

| 項目 | 内容 |
|------|------|
| Category | 状態管理 |
| Location | セクション9 / セクション6-4 |

**問題**: Review 画面（7秒）、Home 画面、Sidebar がそれぞれ独立して worktrees API をポーリングする可能性があり、不要な API 呼び出しやステータス更新のズレが発生する。

**改善提案**: ポーリングデータを共有キャッシュ（React Context または SWR/TanStack Query）で一元管理する方針を明記する。

---

### Nice to Have (3件)

#### DR1-004: deep link pane マッピングの複雑性

| 項目 | 内容 |
|------|------|
| Category | KISS |
| Location | セクション7 |

PC とモバイルで異なるタブ+サブタブの組み合わせへのマッピングが複雑。専用フック `useDeepLinkPane()` で抽象化を推奨。

#### DR1-006: More 画面のスコープが広い

| 項目 | 内容 |
|------|------|
| Category | YAGNI |
| Location | セクション6-5 |

Theme/Locale/Auth/Help は新規 UI 開発が必要であり、Issue #600 のスコープから逸脱する可能性がある。Phase 1 では ExternalAppsManager の移動のみとし、残りは別 Issue に分離を推奨。

#### DR1-008: include クエリパラメータの拡張設計が不明確

| 項目 | 内容 |
|------|------|
| Category | API設計 |
| Location | セクション5 |

将来の複数 include 値への対応方針が未記載。カンマ区切り対応の可否を明記することを推奨。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | WorktreeDetailRefactored（1966行）への大規模変更 | High | High | P1 |
| 技術的リスク | AppShell への条件分岐集中による保守性低下 | Medium | High | P1 |
| 技術的リスク | ポーリング競合によるパフォーマンス劣化 | Medium | Medium | P2 |
| 運用リスク | Sessions 画面とサイドバーの重複ロジック保守コスト | Low | High | P2 |
| 技術的リスク | MessageInput の複雑性増大 | Medium | Medium | P2 |

---

## Design Principles Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| Single Responsibility | 要改善 | AppShell への条件分岐集中、MessageInput への variant 追加 |
| Open/Closed | 概ね適合 | getNextAction() は軽微な違反だが許容範囲 |
| Liskov Substitution | 適合 | 該当する継承構造なし |
| Interface Segregation | 適合 | variant prop は軽量で ISP 違反なし |
| Dependency Inversion | 要改善 | worktree-status-helper への Stalled 判定混在 |
| KISS | 概ね適合 | deep link マッピングがやや複雑 |
| YAGNI | 概ね適合 | More 画面のスコープ注意 |
| DRY | 要改善 | Sessions 画面とサイドバーの重複 |

---

## Approval Status

**conditionally_approved** -- Must Fix 2件（DR1-003, DR1-010）の設計修正を反映後、実装着手を推奨する。Should Fix 5件は実装フェーズで対応可。

---

## Summary

| 指標 | 件数 |
|------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 3 |
| Total | 10 |
