# Issue #469 仮説検証レポート

## 検証日時
- 2026-03-11

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | FileTreeViewはrefreshTrigger propの変更時のみ再取得する | Confirmed | useEffect依存配列に`refreshTrigger`のみ（line 666） |
| 2 | FileTreeViewに自動ポーリングなし | Confirmed | setInterval/polling処理が存在しない |
| 3 | FilePanelContentは初回読み込み後一切再取得されない | Confirmed | polling/setInterval処理なし |
| 4 | chokidar/fs.watch等のファイル監視機構なし | Confirmed | ソース全体を検索して未検出 |
| 5 | ターミナルポーリングは2秒間隔でターミナル出力専用 | Confirmed | tmux-capture-cache.ts: CACHE_TTL_MS=2000 |

## 詳細検証

### 仮説 1: FileTreeViewはrefreshTrigger propの変更時のみ再取得する

**Issue内の記述**: `refreshTrigger` propの変更時のみ再取得

**検証手順**:
1. `src/components/worktree/FileTreeView.tsx` を確認
2. useEffectの依存配列を確認

**判定**: Confirmed

**根拠**:
```
// src/components/worktree/FileTreeView.tsx:594-666
useEffect(() => {
  let mounted = true;
  const reloadTreeWithExpandedDirs = async () => { ... };
  ...
  return () => { mounted = false; };
}, [fetchDirectory, refreshTrigger]);  // ← refreshTriggerのみが外部トリガー
```

**Issueへの影響**: なし（正確な記述）

---

### 仮説 2: 自動ポーリングなし

**Issue内の記述**: 「自動ポーリングなし — UI経由の操作でのみトリガーされる」

**検証手順**:
1. FileTreeView.tsxでsetInterval/polling等を検索

**判定**: Confirmed

**根拠**: FileTreeView.tsxにsetIntervalやポーリング処理が存在しない

---

### 仮説 3: FilePanelContentは初回読み込み後一切再取得されない

**Issue内の記述**: 「初回読み込み後、一切再取得されない」

**検証手順**:
1. `src/components/worktree/FilePanelContent.tsx` でpolling/setInterval等を検索

**判定**: Confirmed

**根拠**: FilePanelContent.tsxにsetIntervalやpolling処理が存在しない

---

### 仮説 4: chokidar/fs.watch等のファイル監視機構なし

**Issue内の記述**: 「chokidar / fs.watch等のファイル監視機構なし」

**検証手順**:
1. src/以下全体でchokidar/FSWatcher/fs.watchを検索

**判定**: Confirmed

**根拠**: 検索結果0件

---

### 仮説 5: ターミナルポーリングは2秒間隔でターミナル出力専用

**Issue内の記述**: 「ターミナルポーリング（2秒間隔）は存在するが、ターミナル出力専用でファイル変更検知には使われていない」

**検証手順**:
1. `src/lib/tmux-capture-cache.ts` でTTL設定を確認

**判定**: Confirmed

**根拠**:
```
// src/lib/tmux-capture-cache.ts:36
export const CACHE_TTL_MS = 2000;  // 2秒
```
tmuxキャプチャキャッシュはターミナル出力専用であり、ファイル変更検知には使用されていない。

---

## Stage 1レビューへの申し送り事項

- 全仮説が確認済み。特別な申し送り事項なし。
- 対策案A+B（案C）の実装方針の明確化を確認すること。
- ポーリング間隔（5〜10秒）の具体値と、差分検知方法の設計詳細を確認すること。
