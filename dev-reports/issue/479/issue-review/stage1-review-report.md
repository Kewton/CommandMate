# Issue #479 Stage 1 レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #479は巨大ファイル分割のリファクタリングIssueであり、対象ファイルの行数は全て正確（仮説検証で確認済み）。分割案の方向性は妥当だが、実装レベルの具体性が不足しており、特にWorktreeDetailRefactored.tsx（2709行）の500行以下目標の実現可能性とdb.ts分割のリスク評価に課題がある。

---

## Must Fix（必須対応）

### F001: WorktreeDetailRefactored.tsx の500行以下目標は非現実的

**カテゴリ**: 正確性
**場所**: 対象ファイル表 / 受け入れ基準

**問題**:
WorktreeDetailRefactored.tsxは2,709行で、既にmemo化された7つの内部コンポーネント（WorktreeInfoFields, DesktopHeader, InfoModal, LoadingIndicator, ErrorDisplay, MobileInfoContent, MobileContent）と、メインコンポーネント内に10以上のセクション（state, effects, callbacks, render等）が存在する。500行以下に分割するには最低6ファイルが必要だが、Issueの分割案は「デスクトップ/モバイルレイアウト分離、ポーリングロジックをhookに抽出」の2点のみ。メインコンポーネント自体が1000行超のstate/effect/callbackを持ち密結合しているため、単純分割は困難。

**証拠**:
- メインコンポーネント: 約1,680行（L1028-L2709）
- 内部コンポーネント7つ: 約730行
- hook使用回数: 101箇所（useCallback/useEffect/useMemo/useState/useRef）

**推奨対応**:
目標行数を現実的に再設定する（例：メインファイル800行以下、分割後ファイル各500行以下）か、分割案をより具体的に記述する：
1. 内部memo化コンポーネント7個を個別ファイルに抽出
2. ポーリング・WebSocketロジックをカスタムhookに抽出
3. デスクトップ/モバイルレイアウトの分離
4. ユーティリティ関数（deriveWorktreeStatus, parseMessageTimestamps等）の分離

---

### F002: db.tsの分割は大規模なimport変更を伴うがリスク評価がない

**カテゴリ**: 不足情報
**場所**: 対象ファイル表 / 受け入れ基準「公開APIの変更なし」

**問題**:
db.tsは40以上のAPIルートおよびlibモジュールからimportされている。「ドメイン別分割（worktree-db, chat-db, session-db）」に分割した場合、全消費者のimport文を変更する必要がある。受け入れ基準「公開APIの変更なし」と矛盾する。

**証拠**:
- `src/app/api/` 配下: 25以上のルートファイルがdb.tsからimport
- `src/lib/` 配下: 7ファイルがdb.tsからimport（response-poller, worktrees, ws-server, session-cleanup, conversation-logger等）
- export関数数: 40以上

**推奨対応**:
バレルファイル戦略を明記する：
1. worktree-db.ts, chat-db.ts, session-db.ts, memo-db.ts等に分割
2. db.tsをバレルファイルとして残し、全関数をre-export
3. 将来的にバレルを廃止して直接importに移行（R-3と連携）

---

## Should Fix（推奨対応）

### F003: テスト戦略の具体的記載がない

**カテゴリ**: 不足情報
**場所**: 受け入れ基準セクション

**問題**:
対象10ファイルには合計30以上のテストファイルが存在する。分割後にテストのimportパスも変更が必要になるが、テスト更新の方針が記載されていない。

**推奨対応**:
テスト戦略セクションを追加：
- 既存テストのimport更新方針
- 分割後の循環依存チェック方法（madge等のツール活用）
- テストカバレッジが低下しないことの確認手段

---

### F004: 分割対象の優先順位が未設定

**カテゴリ**: 優先順位
**場所**: 対象ファイル表

**問題**:
10ファイルの分割を一度に行うのはリスクが高い。依存関係の複雑さやテスト数がファイルごとに異なるため、段階的に実施すべきだが実施順序の記載がない。

**推奨対応**:
実施フェーズを明記：
- **Phase 1（低リスク）**: MarkdownEditor.tsx, FileTreeView.tsx, schedule-manager.ts -- UIコンポーネントやcron解析は比較的独立
- **Phase 2（中リスク）**: WorktreeDetailRefactored.tsx, prompt-detector.ts, auto-yes-manager.ts, claude-session.ts -- 消費者が限定的
- **Phase 3（高リスク）**: db.ts, response-poller.ts -- 広範なimport変更を伴う

---

### F005: response-poller.tsの分割案がexport構造と不一致

**カテゴリ**: 整合性
**場所**: 対象ファイル表「ポーリング制御とレスポンス抽出を分離」

**問題**:
実際のexport構造には4つの責務が混在：TUI accumulator（6関数）、レスポンスクリーニング（3関数）、ポーリング制御（4関数）、判定ロジック（2関数）。2分割では不十分。

**推奨対応**:
3-4ファイルへの分割を検討：
1. `response-poller.ts` -- ポーリング制御のみ
2. `response-extractor.ts` -- 抽出・判定ロジック
3. `response-cleaner.ts` -- cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse
4. `tui-accumulator.ts` -- TUI関連6関数

---

### F006: Issue #481（R-3: src/lib再整理）との作業順序の依存関係が不明確

**カテゴリ**: 不足情報
**場所**: Issue本文（親Issue参照）

**問題**:
親Issue #475では「独立して実施可能、並行作業可」とされているが、db.tsの分割（R-1）とsrc/libの再整理（R-3）は同じディレクトリに影響し、コンフリクトが発生する可能性が高い。

**推奨対応**:
R-1とR-3の作業順序を明確化するか、db.ts分割についてはR-3と統合して一度に行うことを検討する旨を記載する。

---

## Nice to Have（あれば良い）

### F007: 分割後のファイル名案がない

**カテゴリ**: 不足情報

分割案は責務レベルでの記述のみで、具体的な分割後のファイル名が未記載。実装者によって命名が異なるリスクがある。各ファイルについて分割後のファイル名案を記載することを推奨。

---

### F008: CLAUDE.mdのモジュール一覧への反映方針がない

**カテゴリ**: 整合性

CLAUDE.mdには主要モジュール一覧が詳細に記載されており、ファイル分割後にこの一覧も更新が必要。受け入れ基準にCLAUDE.md更新を追加することを推奨。

---

## 参照ファイル

### コード（分割対象）
- `src/components/worktree/WorktreeDetailRefactored.tsx` (2,709行) -- 7内部コンポーネント、101 hook使用箇所
- `src/lib/db.ts` (1,403行) -- 40+ export関数、40+ 消費者
- `src/lib/response-poller.ts` (1,307行) -- 4責務混在、6消費者
- `src/lib/db-migrations.ts` (1,234行) -- 低優先（構造的問題ではない）判断に同意
- `src/components/worktree/MarkdownEditor.tsx` (1,027行)
- `src/lib/prompt-detector.ts` (965行)
- `src/components/worktree/FileTreeView.tsx` (963行)
- `src/lib/auto-yes-manager.ts` (866行)
- `src/lib/claude-session.ts` (838行)
- `src/lib/schedule-manager.ts` (761行)

### テスト（影響を受けるファイル）
- `tests/unit/db.test.ts` 他 db関連テスト7ファイル
- `tests/unit/lib/response-poller.test.ts` 他 response-poller関連3ファイル
- `tests/unit/prompt-detector.test.ts` 他1ファイル
- `tests/unit/lib/auto-yes-manager.test.ts` 他2ファイル
- `tests/unit/lib/claude-session.test.ts`
- `tests/unit/lib/schedule-manager.test.ts` 他1ファイル
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`
- `tests/unit/components/MarkdownEditor.test.tsx`
- `tests/unit/components/worktree/FileTreeView.test.tsx`

### ドキュメント
- `CLAUDE.md` -- 主要モジュール一覧の更新が必要
