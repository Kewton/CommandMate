# Issue #548 影響範囲レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー (Impact Scope)
**ステージ**: 3 (影響範囲レビュー 1回目)

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

## 影響範囲の全体像

修正対象の `<main>` コンテナ (WorktreeDetailRefactored.tsx L1762) はモバイルレイアウト専用であり、デスクトップレイアウトには影響しない。ただし、このコンテナはモバイルの全5タブ (terminal, history, files, memo, info) の共通親要素であるため、CSS変更は files タブだけでなく全タブに波及する。

### 影響マトリクス

| 対象 | 影響 | リスク |
|------|------|--------|
| files タブ | 直接修正対象 | 中 |
| terminal タブ | 親 overflow 変更で挙動変化の可能性 | 中 |
| history タブ | 同上 | 低 |
| memo タブ | 同上 | 低 |
| info タブ | 同上 | 低 |
| デスクトップレイアウト | 影響なし (別 render path L1512) | なし |
| MessageInput (fixed) | padding 変更で重なり発生の可能性 | 中 |
| MobileTabBar (fixed) | 同上 | 中 |
| SearchBar (files内) | 影響なし (nested flex-col内) | なし |
| ダークモード | 追加リスクなし (同一CSS、不透明背景) | なし |
| safe-area-inset | 低リスク (env() 既に正しく使用) | 低 |

---

## Must Fix (必須対応)

### MF-1: overflow-hidden 除去は全モバイルタブに影響する

**カテゴリ**: 影響ファイル

**問題**:
`overflow-hidden` を単純に除去すると、全5タブの挙動が変わる。各タブのコンテンツは親要素が境界を確立していることを前提にしている:

- **TerminalDisplay**: 自身で `overflow-y-auto` を持つ (TerminalDisplay.tsx L161) が、親の境界がないと高さが無制限に膨張する可能性がある
- **FileTreeView**: `overflow-auto` (FileTreeView.tsx L448) は親の境界内でスクロールする前提
- **NotesAndLogsPane**: 内部に `overflow-hidden` を持つ (NotesAndLogsPane.tsx L117)

**推奨対応**:
`overflow-hidden` を `overflow-auto` (または `overflow-y-auto`) に置換する。これにより境界は維持しつつ、子コンテンツのスクロールが可能になる。全5タブでの動作確認が必須。

---

## Should Fix (推奨対応)

### SF-1: パディング統合後の clearance 不足リスク

**カテゴリ**: 破壊的変更

**問題**:
`pb-32` (128px) を除去して inline style の `calc(8rem + safe-area)` のみにすると、実効パディングは約128px + safe-area になる。しかし、固定配置の MessageInput と MobileTabBar の合計高さは以下の通り:

- MobileTabBar: 約4rem (固定 bottom:0)
- MessageInput: 約3-4rem (bottom: calc(4rem + safe-area) に配置)
- NavigationButtons (OpenCode TUI時): 追加 ~2rem

合計は約9-10rem になりうるため、`8rem` では不足する場合がある。

**推奨対応**:
パディング値を `calc(10rem + env(safe-area-inset-bottom, 0px))` 程度に調整するか、NavigationButtons 表示時の追加パディングを考慮した動的計算を検討する。

### SF-2: テストカバレッジの不足

**カテゴリ**: テスト範囲

**問題**:
モバイルレイアウトの CSS プロパティ (pb-32, overflow-hidden, paddingBottom) に関するテストが存在しない。修正後の回帰を検知できない。

**推奨対応**:
以下のテストを追加:
1. FileTreeView がスクロール可能であることの検証
2. コンテンツが MobileTabBar と重ならないことの検証
3. Playwright でモバイルビューポートの E2E テスト

### SF-3: ダークモードでの目視確認

**カテゴリ**: 依存関係

**問題**:
overflow 変更後、スクロールされたコンテンツが固定要素 (MessageInput, MobileTabBar) の背後に透けて見えないことの確認が必要。両要素は `bg-white dark:bg-gray-900` で不透明だが、手動確認が推奨される。

**推奨対応**:
ダークモードで各タブをスクロールし、固定要素との境界が視覚的に正常であることを確認する。

---

## Nice to Have (あれば良い)

### NTH-1: SearchBar への影響なしの明記

**カテゴリ**: ドキュメント更新

Issue の影響範囲セクションに、files タブ内の SearchBar (ファイル検索バー) が影響を受けないことを明記すると、レビュー時の確認コストが下がる。

### NTH-2: iOS/Android 実機での safe-area 検証

**カテゴリ**: 移行考慮

パディング統合後、iOS Safari (ノッチ/Dynamic Island 端末) と Android Chrome の両方で safe-area-inset-bottom が正しく反映されることを実機で確認すると安心。`env(safe-area-inset-bottom, 0px)` のフォールバック指定は既に正しい。

---

## 参照ファイル

### コード

| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L1761-1766 | 修正対象: main コンテナ CSS |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L1806-1838 | 固定配置の MessageInput / MobileTabBar |
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | L755-921 | MobileContent: 全5タブの描画 |
| `src/components/worktree/FileTreeView.tsx` | L443-449 | FileTreeView の overflow-auto |
| `src/components/mobile/MobileTabBar.tsx` | L145-170 | 固定タブバー (z-40) |
| `src/components/worktree/NotesAndLogsPane.tsx` | L117 | 内部 overflow-hidden |
| `src/components/worktree/TerminalDisplay.tsx` | L161-162 | Terminal の overflow-y-auto |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | 既存テストにモバイルレイアウト CSS の検証なし |
