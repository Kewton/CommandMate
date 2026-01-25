# 設計方針書: Worktree固有コマンド対応（修正版）

## Issue情報
- **Issue番号**: #56
- **関連問題**: MySwiftAgentの`acceptance-plan`コマンドが表示されない
- **作成日**: 2026-01-25
- **更新**: 再調査による修正

---

## 1. 再調査結果

### 確認事項

| 項目 | 結果 |
|------|------|
| MySwiftAgentメインリポジトリのコマンド数 | **15個** |
| worktree (feature-issue-113) のコマンド数 | **1個** |
| `.claude/` のgit管理 | **管理下にある** |
| MyCodeBranchDesk APIの動作 | **MyCodeBranchDeskのコマンドのみ返す** |

### 問題の本質（2つの問題）

#### 問題1: MyCodeBranchDesk UIの問題（当初の調査通り）

```typescript
// src/lib/slash-commands.ts:29-32
function getCommandsDir(): string {
  return path.join(process.cwd(), '.claude', 'commands');
  //              ↑ MyCodeBranchDeskのルートに固定
}
```

**影響**: UIのスラッシュコマンドセレクタには、対象worktree（MySwiftAgent等）のコマンドが表示されない

**API実測結果**:
```json
// GET /api/slash-commands の実際のレスポンス
{
  "groups": [
    { "category": "planning", "commands": ["design-policy", "issue-create", ...] },
    { "category": "development", "commands": ["bug-fix", "refactoring", "tdd-impl"] },
    ...
  ]
}
// ↑ MyCodeBranchDeskの12コマンドのみ
```

#### 問題2: Git Worktreeのブランチ差分

```
MySwiftAgent (メインリポジトリ)
  .claude/commands/
    ├── acceptance-plan.md    ← 15個のコマンド
    ├── acceptance-test.md
    ├── ... (13個)

MySwiftAgent-worktrees/feature-issue-113 (worktree)
  .claude/commands/
    └── skill-help.md         ← 1個のみ（古いブランチ）
```

**原因**:
- `.claude/` はgit管理下にある
- worktreeは作成時のブランチから分岐
- メインブランチで追加されたコマンドがworktreeのブランチにマージされていない

---

## 2. 調査結果の正確性

### 当初の調査結果: ✅ 正しい

| 項目 | 正確性 |
|------|--------|
| `process.cwd()` がMyCodeBranchDesk固定 | ✅ 正しい |
| APIがworktree IDを受け取らない | ✅ 正しい |
| 対象リポジトリのコマンドが表示されない | ✅ 正しい |

### 追加発見: git worktreeの問題

| 項目 | 詳細 |
|------|------|
| `.claude/` はgit管理下 | コミットされている |
| worktreeには古いコマンドしかない | ブランチがマージされていない |

---

## 3. 影響分析

### シナリオ別の動作

| シナリオ | コマンド数 | UI表示 |
|---------|-----------|--------|
| MyCodeBranchDeskで作業 | 12個 | ✅ 表示 |
| MySwiftAgentメインで作業 | 15個 | ❌ UI非表示（Claude Codeは認識可能） |
| MySwiftAgent worktreeで作業 | 1個 | ❌ UI非表示 + ブランチにコマンドがない |

### 重要な点

**Claude Code自体は対象リポジトリのコマンドを認識できる**

```
ユーザーが自由入力で /acceptance-plan と入力
    ↓
Claude Codeセッション（MySwiftAgent内で動作）
    ↓
MySwiftAgentの .claude/commands/acceptance-plan.md を読み込み
    ↓
コマンド実行 ✅
```

**問題はUIのセレクタに表示されないこと**

- モバイルではボトムシートからの選択のみ
- 自由入力が困難
- ユーザーがコマンド名を知らないと使えない

---

## 4. 解決策

### 解決策1: MyCodeBranchDesk UIの改善

**A. worktree固有コマンドの読み込み**

```typescript
// 新規API: GET /api/worktrees/{id}/slash-commands

export async function GET(request, { params }) {
  const worktree = await getWorktreeById(params.id);
  const groups = await getSlashCommandGroups(worktree.path);
  return NextResponse.json({ groups });
}
```

**B. 自由入力モードの追加**

```
┌─────────────────────────────────────┐
│ 🔤 その他のコマンドを入力...        │ ← 自由入力
├─────────────────────────────────────┤
│ ⭐ よく使う                         │
│   /clear, /compact, /status         │
├─────────────────────────────────────┤
│ 📂 Worktreeコマンド                 │ ← 対象リポジトリから読み込み
│   /acceptance-plan                  │
└─────────────────────────────────────┘
```

### 解決策2: Git Worktreeの運用改善

**A. 定期的なマージ**

```bash
# worktreeブランチにメインブランチをマージ
cd /path/to/worktree
git merge develop
```

**B. .claude/ をシンボリックリンクに**

```bash
# worktreeの.claudeを削除し、メインリポジトリへのリンクを作成
rm -rf .claude
ln -s ../MySwiftAgent/.claude .claude
```

---

## 5. 推奨実装

### 短期対応（UI改善）

1. **自由入力モード追加**: 任意のコマンドを入力可能に
2. **標準コマンド表示**: よく使うClaude Code標準コマンドを表示

### 中期対応（worktree対応）

1. **worktree固有API追加**: `GET /api/worktrees/{id}/slash-commands`
2. **コマンドローダー改修**: `basePath` 引数追加
3. **UIでworktreeコマンド表示**

### 運用対応（ユーザー向け）

1. worktreeブランチへの定期的なマージを推奨
2. または `.claude/` のシンボリックリンク化

---

## 6. 変更対象ファイル

| ファイル | 変更内容 | 優先度 |
|---------|---------|--------|
| `SlashCommandSelector.tsx` | 自由入力ボタン追加 | 高 |
| `standard-commands.ts` | 標準コマンド定義（新規） | 高 |
| `slash-commands.ts` | basePath引数追加 | 中 |
| `api/worktrees/[id]/slash-commands/route.ts` | 新規API | 中 |
| `useSlashCommands.ts` | worktreeId対応 | 中 |

---

## 7. 結論

### 調査結果の正確性: ✅ 確認済み

当初の調査結果は正しいです。追加で発見した問題：

1. **UI問題**: `process.cwd()` がMyCodeBranchDesk固定 → 対象リポジトリのコマンドが表示されない
2. **Git Worktree問題**: ブランチ差分により、worktreeには古いコマンドしかない場合がある

### 即効性のある解決策

**自由入力モードの追加**が最も即効性があります：
- 対象リポジトリにコマンドがあれば、Claude Codeは認識可能
- UIで自由入力できれば、ユーザーは任意のコマンドを実行可能
