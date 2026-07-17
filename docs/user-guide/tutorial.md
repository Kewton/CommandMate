[English](../en/user-guide/tutorial.md)

# チュートリアル

わざとバグを2つ残したサンプルリポジトリを使って、CommandMate の中核を10分ほどで一通り体験します。

- サンプルリポジトリ: [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial)
- 依存パッケージはゼロです。`npm install` は不要で、`npm test` と `npm start` がそのまま動きます

このドキュメントは、サンプルリポジトリの README に書かれた4ステップの流れに、**CommandMate 側の画面操作**を補ったものです。

---

## 前提条件

- CommandMate が起動していること（まだなら `npx commandmate@latest`）
- Node.js 22 以上
- エージェント CLI がいずれか1つ使えること（Claude Code / Codex / Antigravity）

---

## このチュートリアルで体験すること

| ステップ | 体験する CommandMate の機能 |
|---------|---------------------------|
| 1 | リポジトリのクローンと管理ルートへの登録 |
| 2 | セッション上でのエージェント CLI 実行（ブラウザ／スマホから） |
| 3 | External Apps による開発サーバーのプロキシ |
| 4 | worktree ごとのセッション並列実行 |

---

## Step 1: リポジトリをクローンする

CommandMate の画面から直接クローンできます。

1. **リポジトリ** 画面を開く
2. **リポジトリを追加** をクリック
3. **クローン URL** タブを選ぶ
4. 次の URL を貼り付けて **クローン** を実行

```
https://github.com/Kewton/commandmate-tutorial.git
```

クローン先は CommandMate の管理ルート（`CM_ROOT_DIR`）配下になり、完了するとセッションとして一覧に現れます。

> **補足**: CommandMate は管理ルート外のパスを登録できません。この後 Step 4 で作る worktree も、必ずルート配下に置く必要があります。

---

## Step 2: 失敗するテストをエージェントに直させる

このリポジトリでは、テストが**わざと2つ失敗**します。

```bash
npm test
```

```
✖ greet ends with an exclamation mark
    actual:   'Hello, World'
    expected: 'Hello, World!'
✖ shout uppercases the greeting
    Error: shout() is not implemented yet
```

セッションを開き、エージェントに次のように指示します。

> `npm test` が失敗します。1つ目の失敗だけを修正して、もう一度テストを実行してください。

修正内容は `src/greet.js` の1文字だけです。狙いは難易度ではなく、**エージェントがテストを実行し、コードを直し、再実行する流れをブラウザ（やスマホ）から眺められること**にあります。

2つ目の失敗（`shout()` 未実装）は Step 4 で使うので、ここでは残しておきます。

---

## Step 3: 変更をブラウザで確認する

アプリを起動します。

```bash
npm start
```

**ポート 4173** で待ち受けます。これを CommandMate 経由で開けるように登録します。

1. **その他** 画面の External Apps を開く
2. アプリを追加し、次のように入力する

| 項目 | 値 |
|------|-----|
| 表示名 | `Tutorial` |
| 識別名 | `tutorial` |
| パスプレフィックス | `tutorial` |
| ポート番号 | `4173` |
| アプリ種別 | `Other` |

3. **アプリを有効にする** をオンにして保存

`/proxy/tutorial/` で開けるようになります。別タブでポートを直接開く必要はなく、スマホからも同じ URL で見られます。

ページの見出しは Step 2 で直した `greet()` の戻り値です。

- 修正前: `Hello, CommandMate`
- 修正後: `Hello, CommandMate!`

これが **エージェントがコードを変える → その結果を自分の目で確認する** というループです。

> **セキュリティ**: プロキシしたアプリは CommandMate と同一オリジンで動作し、CommandMate の API にアクセスできます。信頼できるアプリだけを登録してください。

---

## Step 4: worktree で並列作業にする

CommandMate は **worktree 1つにつきセッション1つ**を割り当て、並べて動かします。ただし worktree を**作る**のは CommandMate ではありません。CommandMate は既存の worktree を**見つけて登録する**だけなので、作成はエージェントに任せます。

### Claude Code / Codex の場合

サンプルリポジトリに `worktree-new` スキルが同梱されています。

```
/worktree-new fix/shout
```

### Antigravity の場合

`worktree-new` スキルは Claude Code（`.claude/skills/`）と Codex（`.agents/skills/`）で動作確認済みですが、**Antigravity では未確認**です。代わりに次の指示文を貼り付けてください。

> `fix/shout` という新しいブランチ用の git worktree を作成してください。
> このリポジトリの隣に `commandmate-tutorial-fix-shout` という名前の兄弟ディレクトリとして、
> `git worktree add -b fix/shout ../commandmate-tutorial-fix-shout` で作成します。
> そのディレクトリが既に存在する場合は中断してください。作成したパスを表示してください。
> `--force` は使わないでください。

### worktree を CommandMate に認識させる

1. **リポジトリ** 画面を開く
2. **すべて同期** を実行

新しい worktree が2つ目のセッションとして現れます。そのセッションに、残しておいた2つ目の失敗（`shout()` の実装）を指示してください。1つ目のセッションはそのまま維持されます。

**2ブランチ、2エージェント、ブラウザ1つ。**

---

## 注意点

- worktree は **CommandMate の管理ルート配下**に置く必要があります。このリポジトリの兄弟ディレクトリはルート配下に収まります
- Antigravity の非対話モード（`agy --print`）は、新しいプロジェクトの初回実行時にトラストダイアログで**無言のままタイムアウト**します。一度対話モードで承認するか、内容を理解した上で `--dangerously-skip-permissions` を渡してください

---

## 後片付け

```bash
git worktree remove ../commandmate-tutorial-fix-shout
```

そのあと **リポジトリ** 画面からリポジトリを削除し、**その他** 画面の External Apps から `tutorial` を削除してください。

---

## 次のステップ

- [クイックスタートガイド](./quick-start.md) - スラッシュコマンドとエージェントを使った開発フロー
- [CLI セットアップガイド](./cli-setup-guide.md) - インストールと設定の詳細
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例
