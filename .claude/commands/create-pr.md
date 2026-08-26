---
model: opus
description: "Pull Request自動作成、タイトル・説明自動生成"
---

# PR作成スキル

## 概要
Pull Request作成を自動実行するスキルです。Issue情報から自動でタイトル・説明を生成し、高品質なPRを作成します。

## 使用方法
- `/create-pr`（Issue番号は自動検出）
- `/create-pr [Issue番号]`（明示的に指定）
- `/create-pr --draft`（Draft PRとして作成）

## 実行内容

あなたはPR作成の専門家として、高品質なPull Requestを自動生成します。

---

## 実行フェーズ

### Phase 1: ブランチとIssue情報の取得

#### 1-1. 現在のブランチ確認

```bash
git branch --show-current
```

期待されるブランチ名: `feature/{issue_number}-xxx` または `fix/{issue_number}-xxx`

#### 1-2. Issue番号の検出

パラメータで`issue_number`が指定されていない場合、ブランチ名から抽出：

- `feature/145-add-dark-mode` → Issue #145
- `fix/127-fix-login-error` → Issue #127

#### 1-3. Issue情報取得

```bash
gh issue view {issue_number} --json title,body,labels,assignees
```

---

### Phase 2: PR作成前の最終チェック

#### 2-1. 未コミットの変更確認

```bash
git status --porcelain
```

未コミットの変更がある場合はエラー。

#### 2-2. 全チェック実行

```bash
npm run lint && npx tsc --noEmit && npm run test:unit && npm run build
```

**重要**: このチェックが失敗した場合はPR作成を中止。

---

### Phase 3: PRタイトルの生成

#### 3-1. ラベルからプレフィックス判定

| Issue Label | PR Prefix |
|-------------|-----------|
| feature | feat |
| bug, bugfix | fix |
| hotfix | hotfix |
| refactor | refactor |
| docs | docs |
| test | test |
| chore | chore |

#### 3-2. タイトル生成

**形式**: `[prefix]: [簡潔な説明]`

**例**:
- `feat: add dark mode toggle`
- `fix: resolve login error on mobile`

**ルール**:
- 50文字以内
- 命令形（"Add" not "Added"）

---

### Phase 4: PR説明の生成

以下の構成でMarkdownを生成：

```markdown
## Summary

[Issueの概要を1-2文で簡潔に記述]

Closes #{issue_number}

## Changes

### Added
- [追加した機能1]
- [追加した機能2]

### Changed
- [変更した既存機能1]

### Fixed (該当する場合)
- [修正したバグ1]

## Test Results

### Unit Tests

```
npm run test:unit
Tests: X passed
```

### Lint & Type Check

- ESLint: 0 errors
- TypeScript: 0 errors

### Build

```
npm run build
Build successful
```

## Checklist

- [x] Unit tests pass
- [x] Lint check passes
- [x] Type check passes
- [x] Build succeeds
- [x] No console.log in production code

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Phase 4-2: opencode セッションの添付（任意 / opencode を使った場合のみ）

このブランチの作業を **opencode** で進めた場合、その作業の「かたち」を PR に添付できる。
opencode 1.18.22 で実測した内容にもとづく手順なので、そのとおりに実行すること
（記録: `docs/design/opencode-server-live-verification.md` §23）。

#### 4-2-1. セッション ID を得る

```bash
# CommandMate が覚えている opencode セッション（worktree ごと）
curl -sS "http://127.0.0.1:${CM_PORT:-3000}/api/worktrees/<worktree-id>/opencode/session" | jq -r '.instances[].sessionId'
```

#### 4-2-2. sanitize した JSON を取り出す

```bash
opencode export --sanitize <sessionID> > /tmp/opencode-session.json
```

**必ず `<sessionID>` を渡すこと。** 実測: 引数なしの `opencode export` は失敗せず、
対話ピッカーを開いて**そのまま止まる**。存在しない ID は exit 1・stdout 空・
stderr に `Error: Session not found: <id>`。進捗行 `Exporting session: <id>` は
**stderr** に出るので、stdout はそのまま JSON として読める。

#### 4-2-3. `--sanitize` が落とすもの / 落とさないもの（実測）

**落とす**（すべて `[redacted:…]` に置換される）:
`info.directory` / `info.title` / `messages[].info.path.cwd` / `.root` /
`messages[].parts[].text`（**利用者の発話もエージェントの応答も両方**）/
`parts[].snapshot` / `parts[].state.output` / `parts[].state.title` /
`parts[].state.input` / `parts[].state.metadata` / `parts[].metadata`。

**落とさない**:
各種 ID（session / message / part / `callID`）・`slug`・`projectID`・`agent`・
`model.id` / `providerID` / `variant`・`version`・全タイムスタンプ・全トークン数・
コスト・`finish`・`state.status`・各 part の `type`・差分の `summary` 件数、そして
**ツール名**（`read` など）。

つまり **sanitize 済み JSON に会話は 1 文字も残らない。** これは「伏せ字にした議事録」
ではなく「セッションの形（何ターン・どのツール・いくら・どれだけ掛かったか）の記録」である。
PR に貼るなら**その前提で貼ること** — 生 JSON を貼っても大半は伏せ字トークンで情報量が無い。
日次レポートの `## opencode session transcripts (sanitized)` 節と同じ要約表にするのが望ましい。

判断が要った 2 点:

- `projectID` は**作業ディレクトリの絶対パスから導出されたハッシュ**。復元はできないが
  同一チェックアウトを指す安定した指紋にはなる。PR は元々リポジトリ名を明示しているので
  開示にはあたらないと判断し、残している。
- **ツール名**も同じ判断で残している（要約の価値のほとんどがここにある）。

#### 4-2-4. 貼らないもの

- `opencode export`（`--sanitize` なし）の出力は **PR に貼らないこと。** 実測で、
  会話本文・読んだファイルの中身・絶対パス・利用者名がそのまま入る。
- `POST /session/:id/share` が発行する `https://opncd.ai/share/…` の URL も
  **PR には貼らないこと。** 実測で、公開ページは会話を**伏せ字なしで**載せる
  （プロンプト・応答・セッションの絶対パス）。共有は UI の確認ダイアログを通した
  意図的な操作としてのみ行う。

---

### Phase 5: PR作成実行

#### 5-1. PR作成コマンド実行

```bash
gh pr create \
  --base main \
  --title "${pr_title}" \
  --body "${pr_body}" \
  --label "${labels}" \
  ${draft_flag}
```

#### 5-2. PR URL取得

```bash
pr_url=$(gh pr view --json url --jq '.url')
```

---

### Phase 6: 完了報告

```
✅ Pull Request作成完了！

📋 PR情報:
  URL:      {pr_url}
  タイトル:  {pr_title}
  ベース:    main
  ステータス: {draft ? "Draft" : "Ready for review"}

🚀 次のステップ:
  1. PR画面でCI結果を確認
  2. レビュアーをアサイン
  3. レビュー承認後にマージ
```

---

## 品質基準

### PRタイトル

- Conventional Commits形式に従う
- 50文字以内
- 命令形（"Add" not "Added"）

### PR説明

- 概要が明確（1-2文）
- Closes #xxx で自動クローズ設定
- 変更内容が箇条書きで明確
- テスト結果を含む
- チェックリストが全てチェック済み

### 実行前条件

- CIチェック全パス
- 未コミットの変更なし

## エラーハンドリング

### Issue番号が検出できない

明確なエラーメッセージを表示し、対処方法を提示。

### CIチェック失敗

PR作成を中止し、修正方法を提示：
1. エラー内容を確認
2. 修正後に再度 `/create-pr` を実行
