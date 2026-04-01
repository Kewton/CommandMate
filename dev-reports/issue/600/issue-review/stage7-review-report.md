# Issue #600 Stage 7 レビューレポート

**レビュー日**: 2026-04-01
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目
**レビュアー**: opus (fallback from codex)

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

Stage 1-6のレビューと反映を経て、Issue本文は大幅に改善されている。Must Fixレベルの問題は残っていない。Should Fix 3件はいずれも「実装時の手戻りを防ぐための事前明確化」であり、Issueの方向性自体は妥当。

---

## Should Fix（推奨対応）

### S7-001: Stalled判定の参照先がIssue本文内で不統一

**カテゴリ**: 影響範囲の正確性
**場所**: 実装上の注意事項 > パフォーマンス節、Phase 2タスク

**問題**:
Issue本文の「実装上の注意事項 > パフォーマンス」節と Phase 2 タスクには「response-poller.ts の最終出力タイムスタンプを活用」と記載されている。しかし、実際のコードでは `getLastServerResponseTimestamp()` は `src/lib/auto-yes-poller.ts` で定義され、`src/lib/polling/auto-yes-manager.ts` 経由でエクスポートされている。`worktree-status-helper.ts` も既に `auto-yes-manager.ts` から import している。

**証拠**:
- `src/lib/auto-yes-poller.ts` L134: `export function getLastServerResponseTimestamp(compositeKey: string): number | null`
- `src/lib/session/worktree-status-helper.ts` L22: `import { getLastServerResponseTimestamp, buildCompositeKey } from '@/lib/polling/auto-yes-manager';`
- Issue本文のReview画面ステータス定義セクションは正しく `auto-yes-poller.ts` / `auto-yes-manager.ts` を参照しているが、他の2箇所が `response-poller.ts` のまま

**推奨対応**:
Issue本文のパフォーマンス節とPhase 2タスクの「response-poller.ts」を「auto-yes-poller.ts（auto-yes-manager.ts経由）」に統一する。

**影響ファイル**:
- `src/lib/auto-yes-poller.ts`
- `src/lib/polling/auto-yes-manager.ts`
- `src/lib/session/worktree-status-helper.ts`

---

### S7-002: deep link実装に伴うUI状態型・reducer・hookの更新が主要変更ファイルに記載されていない

**カテゴリ**: 影響ファイル漏れ
**場所**: 新規ファイル・変更ファイルの見込み > 主要変更ファイル

**問題**:
deep link戦略セクションでpane値9種（terminal|history|files|notes|logs|agent|timer|git|info）とMobileTabBarとの対応表が追加されているが、既存実装の以下4ファイルが「主要変更ファイル」に含まれていない:

1. `src/types/ui-state.ts` - `MobileActivePane`（5値）と `LeftPaneTab`（3値）の型定義
2. `src/types/ui-actions.ts` - `SET_MOBILE_ACTIVE_PANE` / `SET_LEFT_PANE_TAB` アクション定義
3. `src/hooks/useWorktreeUIState.ts` - reducerロジック
4. `src/components/worktree/LeftPaneTabSwitcher.tsx` - Desktop左ペインタブUI（独自に `LeftPaneTab` 型を再定義）

pane値9種をこれらの型と統合またはマッピングするには、全ファイルの更新が不可避。

**推奨対応**:
「主要変更ファイル」セクションに上記4ファイルを追加する。Phase 2のdeep linkタスクにこれらの型変更を含むことを注記する。

**影響ファイル**:
- `src/types/ui-state.ts`
- `src/types/ui-actions.ts`
- `src/hooks/useWorktreeUIState.ts`
- `src/components/worktree/LeftPaneTabSwitcher.tsx`

---

### S7-003: isStalledフィールドのHome/Sessions画面での利用方針が未定義

**カテゴリ**: テスト戦略の不足（API設計との整合性）
**場所**: 次アクションの定義、Review画面用API実装方針

**問題**:
受け入れ条件に「次アクションがすべてのSessionStatusパターンで正しく表示される」とあり、`getNextAction(status, promptType, isStalled)` のシグネチャが定義されている。`isStalled` 引数は `STALLED_THRESHOLD_MS` と `getLastServerResponseTimestamp()` によりサーバーサイドで算出する設計。

Issue本文では `isStalled` は `GET /api/worktrees?include=review` でのみ返す設計だが、視認性ルールは「すべてのsession/worktree行・カードに次アクションを表示する」と要求している。つまりHome画面やSessions画面でも次アクションを表示する場合、`isStalled` 情報が必要になるが、これらの画面が `include=review` を使うかどうかが未定義。

**推奨対応**:
以下のいずれかを明記する:
- (A) `isStalled` を常にworktrees APIレスポンスに含める（include不要）
- (B) Home/Sessions画面でも `include=review` を付与する
- (C) Home/Sessions画面では `isStalled=false` 固定の簡易版次アクションを使う

**影響ファイル**:
- `src/lib/session/next-action-helper.ts`
- `src/app/api/worktrees/route.ts`
- `src/app/page.tsx`
- `src/app/sessions/page.tsx`

---

## Nice to Have（あれば良い）

### S7-004: Phase 1タスクのReview画面がPhase 2のAPI拡張に暗黙依存

**カテゴリ**: Phase分割の妥当性

Phase 1に「Done / Approval / Stalled をリアルタイム算出して一元処理」とあるが、StalledはPhase 2の「Review画面用API拡張」と「Stalled判定実装」に依存する。Phase 1でDoneのみ先行実装し、Approval/StalledをPhase 2で追加する段階的アプローチが想定される場合、タスク記述にその旨を明記すると実装者の混乱を防げる。

---

### S7-005: WorktreeCard.tsxが影響ファイルに含まれていない

**カテゴリ**: 影響範囲の網羅性

視認性ルールが要求する「Repository名 / Branch名 / Agent / Status / 次アクション」の全表示には、現在のWorktreeCard.tsxのprops変更が必要になる可能性がある（現在、次アクション表示はない）。主要変更ファイルへの追加を検討すべき。

---

### S7-006: MessageInput simplified variantのテスト計画が未記載

**カテゴリ**: テスト戦略

MessageInputに `variant='simplified'` を追加する計画があるが、テスト戦略セクションに新バリアントのテスト計画が含まれていない。simplifiedバリアントの正常系テスト追加と、既存テストがデフォルトバリアントで引き続きパスすることの確認が必要。

---

## 影響範囲サマリー（検証結果）

### 新規ファイル（Issue記載の9個: 妥当）
Issue記載の新規ファイルリストは妥当。追加の新規ファイルは不要と判断。

### 主要変更ファイル（Issue記載 + 追加5個推奨）
Issue記載の11ファイルに加え、以下5ファイルの追加を推奨:
- `src/types/ui-state.ts`
- `src/types/ui-actions.ts`
- `src/hooks/useWorktreeUIState.ts`
- `src/components/worktree/LeftPaneTabSwitcher.tsx`
- `src/components/worktree/WorktreeCard.tsx`

### 認証（検証完了）
- `AUTH_EXCLUDED_PATHS` は `/login`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/status` のみ（auth-config.ts L31-36）
- 新規URL 4件（/sessions, /repositories, /review, /more）は含まれておらず、ワイルドカードmatcherにより自動保護される
- テストでの検証方針は妥当

### DB（変更不要: 確認済み）
- `Worktree.status` は `'todo' | 'doing' | 'done' | null`（models.ts L72-73）
- Review画面のDone判定は `worktree.status === 'done'` で算出可能

### CLI後方互換性（確認済み）
- `WorktreeItem`（cli/types/api-responses.ts）の全フィールドがオプショナル
- isStalled等の追加フィールドはオプショナルで追加すれば後方互換維持

### API変更
- `GET /api/worktrees?include=review` によるオプショナルフィールド追加方式は妥当
- ただし、Home/Sessions画面での次アクション表示にisStalledが必要な場合のAPIパラメータ方針が未定義（S7-003）

---

## 前回レビュー（Stage 3）からの改善確認

| Stage 3 指摘 | 反映状況 |
|---|---|
| S3-001: Home画面からの到達性保証 | 反映済み（受け入れ条件に1クリック導線を明記） |
| S3-002: deep link段階的実装 | 反映済み（Phase分割、段階的実装方針を明記） |
| S3-003: middleware認証テスト | 反映済み（テストで検証する方針に修正） |
| S3-004 - S3-013: 全Should Fix/Nice to Have | 全件反映済み |

Stage 3の全13件の指摘が適切に反映されていることを確認。
