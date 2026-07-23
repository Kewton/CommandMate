[English](../en/user-guide/tutorial.md)

# チュートリアル

わざとバグを2つ残したサンプルリポジトリを使って、CommandMate の中核を15分ほどで一通り体験します。**サンプルリポジトリを fork してから始める**ので、あなたの操作が元のリポジトリ（upstream）に影響することはありません。

- サンプルリポジトリ: [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial)
- 依存パッケージはゼロです。`npm install` は不要で、`npm test` と `npm start` がそのまま動きます

このドキュメントは、サンプルリポジトリの README に書かれた流れに、**CommandMate 側の画面操作**（fork したリポジトリの登録・Skills の導入・External Apps・worktree 並列）を補ったものです。

---

## 前提条件

- CommandMate が起動していること（まだなら `npx commandmate@latest`）
- Node.js 22 以上
- エージェント CLI がいずれか1つ使えること（Claude Code / Codex / Antigravity）
- GitHub アカウント（サンプルリポジトリを fork するために使います）

---

## このチュートリアルで体験すること

| ステップ | 体験する CommandMate の機能 |
|---------|---------------------------|
| 1 | サンプルリポジトリの fork とクローン、管理ルートへの登録 |
| 1.5 | Skills を Catalog から UI で導入 → セッション再起動 → 使う |
| 2 | External Apps による開発サーバーのプロキシ |
| 3 | セッション上でのエージェント CLI 実行（ブラウザ／スマホから） |
| 4 | worktree ごとのセッション並列実行 |

---

## Step 1: サンプルリポジトリを Fork してクローンする

まず GitHub 上で **fork** し、その fork を CommandMate にクローンします。fork を経由するのは、クローン元（`origin`）を**あなた自身の fork** に向けるためです。こうすると、あとで誤って push しても変更は自分の fork に入るだけで、元のサンプルリポジトリ（upstream）を汚しません。

### 1-1. GitHub で fork する

1. [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial) を開く
2. 右上の **Fork** をクリックし、自分のアカウントに fork を作成する

fork の URL は `https://github.com/<あなたのユーザー名>/commandmate-tutorial.git` になります。

### 1-2. 自分の fork を CommandMate にクローンする

CommandMate の画面から直接クローンできます。

1. **リポジトリ** 画面を開く
2. **リポジトリを追加** をクリック
3. **クローン URL** タブを選ぶ
4. **自分の fork の URL** を貼り付けて **クローン** を実行

```
https://github.com/<あなたのユーザー名>/commandmate-tutorial.git
```

クローン先は CommandMate の管理ルート（`CM_ROOT_DIR`）配下になり、完了するとセッションとして一覧に現れます。origin は貼り付けた fork の URL になるので、この先の操作はすべて自分の fork に対して行われます。

> **補足**: CommandMate は管理ルート外のパスを登録できません。この後 Step 4 で作る worktree も、必ずルート配下に置く必要があります。

> **上級者向け（任意）**: このチュートリアルは push も PR も行わないローカル完結型なので、upstream を追う設定は不要です。もし元リポジトリの更新を取り込みたくなったら、ターミナルで `git remote add upstream https://github.com/Kewton/commandmate-tutorial.git` を追加してください。

---

## Step 1.5: Skills を入れて使う

CommandMate は公式 Catalog から **Agent Skill** を worktree ごとに導入できます。ここでは**リポジトリを書き換えない read-only の Skill** を1つ入れて、**Catalog を見る → UI で導入する → セッションを再起動する → 使う** という一連の流れを、安全な題材で体験します。

### 1.5-1. Skills ペインを開く

クローンしたリポジトリのセッション（worktree 詳細画面）を開きます。

- **PC**: アクティビティバーの **スキル**（✨ アイコン）を開く
- **スマホ**: **Tools** タブ → **Skills** を開く

同じ Skills ペインが表示され、上段に「このワークツリーに導入済み」、下段に「Catalogから導入」が並びます。

### 1.5-2. read-only の Skill を導入する

1. 「Catalogから導入」から **`cmate-repository-analysis`** を選ぶ（リポジトリを分析するだけの read-only な Skill で、risk バッジは **low** です）
2. 詳細画面で **install planを作成** を押す。この時点では何も書き込まれず、「何がインストールされるか」（`.agents/skills/cmate-repository-analysis/` 配下）がプレビューされるだけです
3. 内容を確認して **このworktreeへ導入する** を押す

導入が完了すると「以下のagentセッションを再起動すると利用を開始できます」と表示されます。

### 1.5-3. セッションを再起動して使う

エージェントは**起動時に** worktree の Skills を読み込みます。導入しただけでは使えないので、**このリポジトリのセッションを再起動**してください。再起動後、セッションで次のように指示すると、導入した Skill が使われます。

> このリポジトリを分析して

> **重要な注意**
> - **導入後はセッション再起動が必須**です（エージェントは起動時にしか Skills を読み込みません）。
> - **同じ場所への入れ直し・更新はできません**（一発性）。バージョンを変えたいときは、一度アンインストールしてから入れ直してください。
> - `cmate-worktree-cleanup` / `cmate-orchestrate` などの **high-risk な Skill は初回チュートリアルでは使わない**でください。
> - Skills 機能の詳細・制約は [Agent Skills 配布](./skills.md) を参照してください。

---

## Step 2: 動かしてブラウザで眺める

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

見出しには感嘆符がありません。

> # Hello, CommandMate

これが1つ目のバグで、**目で見えています**。このページは開いたままにしておいてください。

> **セキュリティ**: プロキシしたアプリは CommandMate と同一オリジンで動作し、CommandMate の API にアクセスできます。信頼できるアプリだけを登録してください。

---

## Step 3: エージェントに直させ、再起動して確かめる

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

### 再起動して初めて画面が変わる

修正しただけでは、Step 2 で開いたページをリロードしても**見出しは変わりません**。アプリを再起動してください（`Ctrl+C` してから `npm start`）。

再起動してリロードすると、見出しが変わります。

> # Hello, CommandMate!

これが **エージェントがコードを変える → 再起動する → その結果を自分の目で確認する** というループです。

> **なぜ再起動が要るのか**: `src/server.js` は `greet` をプロセス起動時に一度だけ import します。そのため稼働中のサーバーは、ディスク上のコードが変わっても起動時に読み込んだコードを返し続けます。このチュートリアル特有の癖ではなく、起動時に読み込んだコードを変更したときに実際の開発サーバーで再起動が必要になるのと同じ理由です。

---

## Step 4: worktree で並列作業にする

CommandMate は **worktree 1つにつきセッション1つ**を割り当て、並べて動かします。ただし worktree を**作る**のは CommandMate ではありません。CommandMate は既存の worktree を**見つけて登録する**だけなので、作成はエージェントに任せます。

### Claude Code / Codex の場合

サンプルリポジトリに `worktree-new` スキルが同梱されています。

```
/worktree-new fix/shout
```

> **発展（任意）**: 同梱の `worktree-new` の代わりに、Step 1.5 と同じ要領で公式 Catalog の **`cmate-worktree-setup`**（risk バッジは **moderate**）を導入して worktree 作成に使うこともできます。導入後のセッション再起動が必要な点と、同梱スキルとは挙動が一部異なる点に注意してください。

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
