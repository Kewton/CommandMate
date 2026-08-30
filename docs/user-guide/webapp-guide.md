[English](../en/user-guide/webapp-guide.md)

# Webアプリ基本操作ガイド

CommandMate のWebアプリを使った基本操作を説明します。
初めてアプリを使う方向けの手順書です。

> **技術者向け詳細**: UI実装の詳細は [UI/UXガイド](../UI_UX_GUIDE.md) を参照してください。

---

## 目次

1. [アプリの起動とアクセス](#アプリの起動とアクセス)
2. [リポジトリの登録](#リポジトリの登録)
3. [リポジトリの削除](#リポジトリの削除)
4. [ワークツリーの選択](#ワークツリーの選択)
5. [メッセージの送信](#メッセージの送信)
6. [Auto Yesモード](#auto-yesモード)
7. [チャット履歴の確認](#チャット履歴の確認)
8. [ステータスインジケーター](#ステータスインジケーター)
9. [Markdownログビューア](#markdownログビューア)
10. [メモ機能](#メモ機能)
11. [エージェント設定](#エージェント設定)
12. [実行契約と検証結果](#実行契約と検証結果)
13. [モバイルからのアクセス](#モバイルからのアクセス)
14. [スマホ通知（プッシュ通知）](#スマホ通知プッシュ通知)

---

## アプリの起動とアクセス

### 1. サーバーの起動

#### npm グローバルインストールの場合（推奨）

```bash
# バックグラウンドで起動
commandmate start --daemon

# ステータス確認
commandmate status

# 停止
commandmate stop
```

#### 開発環境（git clone）の場合

```bash
cd CommandMate

# 開発サーバー
npm run dev

# 本番ビルド
npm run build
npm start
```

> **Note**: 初めて使う場合は `commandmate init` で初期設定を行ってください。詳しくは [CLI セットアップガイド](./cli-setup-guide.md) を参照してください。

### 2. ブラウザでアクセス

ブラウザで以下のURLにアクセスします:

```
http://127.0.0.1:3000
```

> **ポート変更**: `commandmate start --port 3001` または `.env` ファイルで `CM_PORT=3001` のように変更できます。

> **`localhost` ではなく `127.0.0.1`**: CommandMate は既定で `127.0.0.1` に bind します（`CM_BIND`）。
> `localhost` は環境によって `::1`（IPv6）を先に解決しますが、そこは CommandMate が listen していない
> アドレスです。別プロセスが掴んでいると、ブラウザは黙ってそちらに繋がります。

---

## リポジトリの登録

CommandMate でワークツリーを管理するには、まずリポジトリを登録します。
登録方法は2つあります。

### 方法1: ローカルパスからスキャン

PC上の既存リポジトリをスキャンして登録します。

1. トップページ右上の **「リポジトリを追加」** ボタンをクリック
2. **「ローカルパス」** タブを選択
3. リポジトリのパスを入力（例: `/Users/yourname/projects/my-repo`）
4. **「スキャン」** をクリック
5. 検出されたワークツリー一覧を確認し、**「登録」** をクリック

### 方法2: URLからクローン

GitHub等のリモートリポジトリをクローンして登録します。

1. トップページ右上の **「リポジトリを追加」** ボタンをクリック
2. **「URLクローン」** タブを選択
3. リポジトリURLを入力
   - HTTPS: `https://github.com/username/repo.git`
   - SSH: `git@github.com:username/repo.git`
4. **「クローン」** をクリック
5. クローン完了後、自動的にワークツリーが登録されます

> **注意**: SSH URLを使用する場合は、SSH鍵がセットアップされている必要があります。

---

## リポジトリの削除

不要になったリポジトリを削除できます。

1. トップページのリポジトリ一覧で、削除したいリポジトリの **「⋯」** メニューをクリック
2. **「削除」** を選択
3. 確認ダイアログで `delete` と入力
4. **「削除」** ボタンをクリック

> **警告**: 削除すると、関連するワークツリー情報・メモ・履歴もすべて削除されます。リポジトリのファイル自体は削除されません。

---

## ワークツリーの選択

登録したリポジトリのワークツリー（ブランチ）を選択して操作します。

### デスクトップの場合

1. 左側のサイドバーにワークツリー一覧が表示されます
2. 操作したいワークツリーをクリック
3. 右側に詳細画面が表示されます

### モバイルの場合

1. トップページにワークツリー一覧が表示されます
2. 操作したいワークツリーをタップ
3. ワークツリー詳細画面に移動します

![デスクトップ表示](../images/screenshot-worktree-desktop.png)
*デスクトップ: 2カラムレイアウト*

![モバイル表示](../images/screenshot-worktree-mobile.png)
*モバイル: タブベースレイアウト*

---

## メッセージの送信

Claude Code にメッセージを送信して指示を出します。

### 送信手順

1. ワークツリーを選択
2. 画面下部の入力欄にメッセージを入力
3. **「送信」** ボタンをクリック（または Enter キー）

### Claude からの確認への応答

Claude が yes/no や選択肢の確認を求めてきた場合:

1. 確認ダイアログが自動的に表示されます
2. **「Yes」** または **「No」** をクリック
3. 複数選択の場合は、選択肢をクリックして回答

![モバイル Terminal](../images/screenshot-worktree-mobile-terminal.png)
*モバイル: Terminal タブでのメッセージ送信*

---

## Auto Yesモード

Claude からの確認を自動的に承認するモードです。
連続した処理を中断なく実行したい場合に便利です。

### 使い方

1. ワークツリー詳細画面を開く
2. 画面上部の **「Auto Yes」** トグルをオンにする
3. 確認ダイアログが表示される
4. **有効時間を選択**（1時間 / 3時間 / 8時間）
   - デフォルトは **1時間** です
   - 作業に必要な最小限の時間を選択してください
5. 選択した時間に応じて説明文が動的に変わります（例：「3時間後に自動でOFFになります。」）
6. **「同意して有効化」** をクリック

### 有効時間

| 選択肢 | ミリ秒値 | 想定ユースケース |
|--------|---------|---------------|
| **1時間**（デフォルト） | 3,600,000 | 通常の開発作業、短時間のタスク |
| **3時間** | 10,800,000 | 中規模の実装作業 |
| **8時間** | 28,800,000 | 長時間のバッチ処理的タスク（定期的な進捗確認を推奨） |

カウントダウンタイマーにより残り時間が常時表示されます。
- **1時間未満**: `MM:SS` 形式（例: `45:30`）
- **1時間以上**: `H:MM:SS` 形式（例: `2:15:30`）

### API仕様（開発者向け）

Auto-Yes有効化APIは以下のパラメータを受け付けます：

```typescript
POST /api/worktrees/:id/auto-yes

{
  "enabled": true,
  "duration": 3600000 | 10800000 | 28800000  // オプショナル（デフォルト: 3600000）
}
```

- **duration省略時**: デフォルトで1時間（3,600,000ミリ秒）が適用されます（後方互換性）
- **不正なduration値**: 400エラーが返されます
- **セキュリティ**: worktreeIdフォーマット検証 → JSON parse検証 → 型検証 → ホワイトリスト検証の5層防御

### 注意事項

- Auto Yes が有効な間、すべての確認に自動で「Yes」と回答します
- 重要な変更（ファイル削除など）も自動承認されるため、注意して使用してください
- 必要に応じてトグルをオフにして無効化できます
- 選択した有効時間が経過すると自動でOFFになります
- **セキュリティのベストプラクティス**:
  - 作業に必要な **最小限の時間** を選択する（迷った場合は1時間を推奨）
  - `CM_ROOT_DIR` を作業対象のworktreeディレクトリに限定する
  - 長時間離席する場合は、残り時間に関わらず手動でOFFにする
  - 詳細は [Trust & Safety](../TRUST_AND_SAFETY.md#auto-yes-有効時間に関するリスクと推奨事項) を参照

---

## チャット履歴の確認

過去のメッセージ履歴を確認できます。

### デスクトップの場合

左ペインの **History Pane** に履歴が表示されます。
- ユーザーのメッセージと Claude の応答が時系列で表示
- スクロールで過去の履歴を確認

### モバイルの場合

画面下部のタブバーから **「History」** タブをタップします。
- 過去のやり取りを一覧表示
- タップで詳細を確認

---

## ステータスインジケーター

サイドバーの各ワークツリーに表示されるインジケーターで、現在の状態がわかります。

| 表示 | ステータス | 意味 |
|------|-----------|------|
| ● グレー | idle | セッション未起動 |
| ● 緑 | ready | 入力待ち（新しいメッセージを送信可能） |
| ⟳ 青スピナー | running | Claude が処理中 |
| ● 黄 | waiting | ユーザー入力待ち（yes/no 確認など） |
| ⟳ 青スピナー | generating | レスポンス生成中 |

> **詳細**: ステータス検出の仕組みについては [ステータスインジケーター詳細](../features/sidebar-status-indicator.md) を参照してください。

---

## Markdownログビューア

Claude の詳細な出力をMarkdown形式で閲覧できます。

### モバイルの場合

1. 画面下部のタブバーから **「Logs」** タブをタップ
2. ログファイル一覧から閲覧したいファイルをタップ
3. Markdown形式でレンダリングされた内容を確認

### デスクトップの場合

1. **「Info」** ボタンをクリックしてモーダルを開く
2. ログファイル一覧から選択して閲覧

---

## メモ機能

各ワークツリーにメモを保存できます。
作業内容や TODO を記録するのに便利です。

### メモの編集

#### デスクトップの場合

1. 画面右上の **「Info」** ボタンをクリック
2. モーダル内の **「メモ」** セクションで編集
3. 入力内容は自動保存されます

#### モバイルの場合

1. 画面下部のタブバーから **「Info」** タブをタップ
2. **「メモ」** セクションで編集
3. 入力内容は自動保存されます

---

## エージェント設定

ワークツリーごとに使用するCLIエージェントを選択できます。

### 設定方法

1. ワークツリーを選択
2. **「CMATE」** タブをクリック
3. **「Agent」** サブタブをクリック
4. 使用したいエージェントを**2つ**選択（チェックボックス）
5. 設定は自動的に保存されます

### 選択可能なエージェント

| エージェント | 説明 |
|-------------|------|
| **Claude** | Claude Code CLI |
| **Codex** | OpenAI Codex CLI |
| **Gemini** | Google Gemini CLI |
| **Vibe-Local** | Ollama ローカルLLM |

- 常に**2つ**のエージェントを選択する必要があります
- 選択したエージェントがターミナルヘッダーのタブとして表示されます

### Ollamaモデルの選択（Vibe-Local）

Vibe-Localを選択した場合、使用するOllamaモデルを指定できます。

1. Agent設定画面の **「Ollama Model」** セレクターからモデルを選択
2. Ollamaが起動していない場合は「Ollama is not running」と表示されます

> **Note**: 選択したモデルはスケジュール実行（CMATE.md）でも使用されます。

---

## 実行契約と検証結果

`commandmate send --contract` で渡した**実行契約**と、`commandmate verify` が下した
**検証ゲートの判定**を、CLI の stdout を読まずに画面で確認できます（Issue #1816）。

### ヘッダの状態チップ

契約つきで作業を委任したワークツリーには、ヘッダに状態チップが出ます。
チップには「タスク名 / TaskStatus / 直近の検証ランの RESULT」が並びます。

- 契約を 1 件も持たないワークツリーでは**チップは出ません**
- チップをホバー（またはスクリーンリーダーで読む）と、**判定の理由**が読めます
  — 直近ランで不合格だったゲート ID まで含まれます
- チップをクリックすると **Verification** ペインが開きます

### Verification ペイン

| 画面 | 開き方 |
|------|--------|
| デスクトップ | 左端のアクティビティバーの盾アイコン（Verification） |
| モバイル | 下部タブバーの **Tools** → **検証** サブタブ |

ペインは上から 3 段です。

1. **実行契約** — タスク名 / goal 冒頭 / `scope.allow` / `verify.gates` / `autoYes.mode` /
   契約ファイルのパス。契約が無い場合は作り方（`commandmate send --contract` か
   Skill `cmate-task-contract`）を案内します
2. **検証ラン** — 新しい順の一覧（開始時刻・RESULT・run id・trigger）と **「再検証」** ボタン。
   ラン行をクリックすると 3 段目がそのランに切り替わります
3. **ゲート** — 選択中ランのゲート表（gate id / PASS・FAIL・TIMEOUT・SKIP / exit code /
   duration / ログ末尾 40 行）。不合格ゲートはログを開いた状態で表示します

### 「再検証」ボタン

`POST /api/worktrees/:id/verify` を呼び、202 と run id が返った時点で一覧を読み直します。
ゲートは分単位で走るため、**判定を待たずに** 202 で戻り、以降はワークツリー詳細の
ポーリングに相乗りして進捗が反映されます。既に別のランが走っている場合は
「検証ランが既に実行中です（run N）」と表示します。

> **表示は読み取り専用です。** 契約 YAML の編集 UI はありません。契約は
> `.commandmate/tasks/<name>.yaml` を直接編集し、`commandmate send --contract` で
> 送り直してください（scope は**送信時スナップショット**で裁定されるため、
> YAML を直すだけでは判定は変わりません）。

---

## モバイルからのアクセス

スマートフォンから CommandMate にアクセスする方法です。

経路は 2 つあります。**まず `commandmate remote` を試してください。**
Provider のツール（`tailscale` / `cloudflared`）を入れたくない、あるいは LAN 内で完結させたい場合に限り、
[方法2: 同一 LAN 内から直接つなぐ](#方法2-同一-lan-内から直接つなぐcloudflared-を使わない場合) を使います。

| | 方法1: `commandmate remote` | 方法2: 同一 LAN 内から直接つなぐ |
|---|---|---|
| **認証** | あり（ペアリングしたスマホだけ） | **なし** |
| **暗号化** | あり（外側が HTTPS） | **なし**（平文 HTTP） |
| **届く範囲** | 外出先からも（tailnet またはインターネット経由） | 同じ Wi-Fi の中だけ |
| **必要なもの** | `tailscale` または `cloudflared` | なし |
| **サーバの bind** | `127.0.0.1` のまま | `0.0.0.0`（全インターフェース） |

### 方法1（推奨）: `commandmate remote` で QR ペアリング

`commandmate remote` は **サーバの起動・外への公開・スマホとのペアリング**を 1 コマンドで
行います。ターミナルに QR コードが表示されるので、スマホのカメラで読むだけです。

```bash
commandmate remote
```

やっていることは次の 4 つです。

1. Provider（外へ出す口）を検出して選ぶ
2. **公開 Tunnel を作る前に、あなたに確認を取る**（下記「公開前の確認」）
3. 認証を有効にした CommandMate サーバを起動する
4. 1 回限りのペアリングコードを埋めた URL `https://<公開URL>/login#code=<コード>` を
   QR コードにして表示する

スマホでその QR を読むとログインが完了します。**ペアリングコードは一度しか使えず、
既定 10 分で失効します。** コードが表示されるのはこのときだけで、
`commandmate remote status` は URL は見せてもコードは二度と見せません。

#### 公開前の確認

`commandmate remote` は 2 つの Provider のどちらかで公開できます。

| Provider | `--provider` | 公開先 |
|---|---|---|
| Tailscale Serve | `tailscale` | **自分の tailnet の中だけ**。インターネットには出ません。先に試されます |
| Cloudflare Quick Tunnel | `cloudflare` | `https://<ランダム>.trycloudflare.com` という一時的な**インターネット上のアドレス** |

Cloudflare 経路はこの PC をインターネット上に出すため、`commandmate remote` は
Tunnel を作る前に警告を出して y/n を尋ねます。非対話環境（スクリプトや CI）では
**プロンプトを出せないので既定で拒否**し、`CONFIG_ERROR`（exit 2）で止まります。
意図して公開する場合だけ `--yes` を付けてください。

```bash
commandmate remote --yes    # 確認をスキップして公開 Tunnel を作る
```

> **この確認を求めるのは Cloudflare 経路だけです。** Tailscale Serve は自分の tailnet の
> 中に閉じていてインターネットには出ないため、`--provider tailscale` に `--yes` は要りません。

> **使える Provider が 1 つも無いときは `DEPENDENCY_ERROR`（exit 1）で止まります。**
> Tailscale が使えなかったからといって、勝手に公開 Tunnel へ切り替わることはありません。

> **修正済み — Cloudflare 経路が `commandmate remote` の終了と同時に死ぬ不具合
> （[#2146](https://github.com/Kewton/CommandMate/issues/2146)、CLOSED）。**
> 2026-08-29 の実測では、`cloudflared` が `remote` の返却と同時に終了し、払い出されたばかりの
> URL が数秒で HTTP 530 になるため、QR を読む時間がありませんでした（不具合 **D-1**）。
> 原因は spawn の形で、子の stderr を親と一緒に閉じるパイプに繋いだままだったことです。
> [**#2148**](https://github.com/Kewton/CommandMate/pull/2148) **で fd 2 をパイプではなく
> ファイル（`~/.commandmate/cloudflared.log`）へ向け、`detached: true` と `unref()` を併用**して
> 解消し、[#2149](https://github.com/Kewton/CommandMate/pull/2149) が実物の `cloudflared`
> 2025.4.0 で再確認しました。公開 URL は **`up` 返却後 t+22.6 ／ +56.7 ／ +60.3 秒のいずれでも
> 530 ではなく**、**`remote stop` 後 2.3 秒で 530**（公開中は生きていて、撤収で失効する）。
> 両方の実測は [`docs/qa/1937-remote-uat-record.md`](../qa/1937-remote-uat-record.md)
> （D-1 は §3.6、解消は §6）にあります。

#### 状態の確認と撤収

```bash
commandmate remote status   # Provider / URL / 期限 / ペアリング状態
commandmate remote stop     # 外への口を閉じる
```

`remote stop` が片付けるのは **CommandMate 自身が作った設定だけ**です。
状態ファイルが読めないときは Provider を推測して片付けにいかず、
「片付けるものが分からない」と言って正常終了します。

**期限が切れたときに閉じるのは外への口だけで、サーバは落としません。**
PC でのローカル利用まで巻き添えにしないためです。

> **Tailscale の撤収は必ず `commandmate remote stop` で行ってください。**
> `tailscale serve` に成功すると Tailscale 自身が、パスを付けずにポートと `off` だけを
> 指定して `serve` を再実行する撤収方法を案内します。この形はそのポートの**すべて**の
> ハンドラ（あなた自身が設定したものを含む）を、警告も無く exit 0 で消します。

#### 主なオプション

| オプション | 既定 | 説明 |
|-----------|------|------|
| `--provider <tailscale\|cloudflare>` | 自動選択 | Provider を明示指定 |
| `--expires <duration>` | `8h` | remote セッションの TTL（`1h`〜`30d`） |
| `--pairing-expires <duration>` | `10m` | ペアリングコードの TTL（`1m`〜`24h`） |
| `-p, --port <number>` | 自動 | 公開するサーバのポート |
| `--yes` | — | 公開 Tunnel（`cloudflare`）の明示承認（非対話環境では必須）。`tailscale` には不要 |
| `--json` | — | JSON 出力 |

終了コード: `0` 成功 / `1` DEPENDENCY_ERROR / `2` CONFIG_ERROR / `3` START_FAILED /
`4` STOP_FAILED / `99` UNEXPECTED_ERROR。
CLI としての詳細は [CLI 運用ガイド](./cli-operations-guide.md) を参照してください。

#### 知っておくとよいこと

- **`CM_BIND` は変わりません。** `remote` は `CM_BIND` を読みも書きもせず、サーバは
  `127.0.0.1` に bind したままです。外へ出す口を 1 つ増やすだけです。
- **Auto-Yes は既定で無効のまま**です。`remote` に Auto-Yes を有効化するフラグはありません。
- **平文の長期トークンはどこにも保存されません。** サーバに渡すのは
  `CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE` / `CM_REMOTE_PAIRING_FILE` の 3 つだけで、
  3 つ目は秘匿値ではなくファイルパスです。ペアリング用の受け渡しファイル
  `~/.commandmate/remote-pairing.json` は mode 0600 で、**ペアリング成功と同時に削除**されます。
- **Tunnel 経由でもログイン Cookie に `Secure` 属性は付きません。** これは正しい挙動です。
  `Secure` を立てると `http://127.0.0.1:3000` でのローカル利用時に Cookie が拒まれ、
  PC からの利用が壊れます。Tunnel の外側は HTTPS なので、通信経路上の盗聴リスクは
  すでに下がっています。詳しくは [セキュリティガイド](../security-guide.md) を参照してください。

#### OS 別の対応状況

2026-08-29 時点の実測結果です。**「実測済み」と「未検証」を必ず読み分けてください。**
実測の手順と生ログは `dev-reports/issue/1937/u8-os-matrix.md` に、実機受入テストの記録は
[`docs/qa/1937-remote-uat-record.md`](../qa/1937-remote-uat-record.md) にあります。

| OS | Provider 検出 | 承認フロー | 公開経路の疎通 | 備考 |
|----|--------------|-----------|--------------|------|
| **macOS** (Darwin arm64) | ✅ 実測済み<br>Provider のツール導入済みなら `ready` | ✅ 実測済み<br>非対話は exit 2 で停止（Cloudflare のみ） | ✅ 実測済み<br>**Tailscale Serve は全項目合格**。Cloudflare Quick Tunnel は当初 **D-1** で不合格で、[#2148](https://github.com/Kewton/CommandMate/pull/2148) の修正後は合格。[#2149](https://github.com/Kewton/CommandMate/pull/2149) が実物の `cloudflared` で再確認 | cloudflared 2025.4.0 / Tailscale 1.102.3 で確認 |
| **Linux** (Debian 12 / aarch64) | ✅ 実測済み<br>未導入時は `DEPENDENCY_ERROR` (exit 1)、導入後 `ready` | ✅ 実測済み<br>macOS と同一の挙動 | ⏭️ 未実施 | ⚠️ **docker コンテナでの実測であり、ベアメタル Linux とはネットワーク構成が異なりうる** |
| **WSL2** | ❌ **未検証** | ❌ **未検証** | ❌ **未検証** | **検証環境が用意できなかったため未実施。** WSL2 は `localhost` 転送の構成差が大きく、**Tunnel のアップストリーム `127.0.0.1` が WSL2 内部を指すか Windows 側を指すかが構成依存**です |

- ✅ **実測済み** ／ ⏭️ **未実施**（公開 Tunnel を新たに作らない方針のため意図的に見送り）
  ／ ❌ **未検証**（検証環境が無い）
- 「Provider 検出」「承認フロー」列の「実測済み」は、**公開 Tunnel を作らずに確かめられる範囲**
  （Provider 検出・承認ゲート・`status` / `stop`）です。
- **スマホ実機での通し（QR 読取 → ペアリング → PWA → Push）は、どの OS でもまだ未実施です。**
  実機受入テストが確認したのはサーバ側までで、スマホでの確認は
  [#2152](https://github.com/Kewton/CommandMate/issues/2152) で追跡しています。
- **`--provider tailscale` は実装済みで、macOS では実機受入テストの全項目に合格しています**
  （[`docs/qa/1937-remote-uat-record.md`](../qa/1937-remote-uat-record.md) §3.4）。
  Linux / WSL2 の行が「未実施 / 未検証」なのは **OS 対応の可否ではなく、その OS の検証環境を
  用意できなかったため**です。上の 3 区分は、この違いを読み分けるためにあります。

### 方法2: 同一 LAN 内から直接つなぐ（`cloudflared` を使わない場合）

`cloudflared` を入れたくない場合や、LAN の外に一切出したくない場合はこちらを使います。

> ⚠️ **この方法はサーバを認証なしで LAN に開きます。**
> `CM_BIND=0.0.0.0` は CommandMate を PC の全ネットワークインターフェースで待ち受けさせます。
> 同じ Wi-Fi にいる**誰でも**、ブラウザで `http://<PCのIPアドレス>:3000` を開けば
> **認証を求められることなく**リポジトリ・ターミナル・エージェントを操作できます。
> 共有 Wi-Fi（カフェ・コワーキング・社内ゲスト網）では使わないでください。
> 認証と暗号化が要るなら [方法1](#方法1推奨-commandmate-remote-で-qr-ペアリング) を使ってください。

1. PC とスマートフォンを同じ Wi-Fi に接続
2. `.env` ファイルを編集:
   ```
   CM_BIND=0.0.0.0
   ```
3. サーバーを再起動
4. スマートフォンのブラウザで `http://<PCのIPアドレス>:3000` にアクセス

終わったら `CM_BIND` を `127.0.0.1`（既定値）に戻し、サーバーを再起動してください。

#### PCのIPアドレスの確認方法

```bash
# macOS
ifconfig | grep "inet " | grep -v 127.0.0.1

# Linux
ip addr | grep "inet " | grep -v 127.0.0.1
```

#### 外部ネットワークへ公開する場合

`commandmate remote` を使わずに自分で公開する場合は、リバースプロキシでの認証を必ず併用して
ください。詳細は [セキュリティガイド](../security-guide.md) と
[デプロイガイド](../DEPLOYMENT.md) を参照してください。

### モバイルUI

モバイルでは画面下部にタブバーが表示されます:

| タブ | 内容 |
|------|------|
| **Terminal** | リアルタイム出力 + メッセージ入力 |
| **History** | チャット履歴 |
| **Files** | ファイルツリー表示 |
| **CMATE** | メモ + 実行ログ |
| **Info** | ワークツリー情報 |

![モバイル表示](../images/screenshot-mobile.png)
*モバイル: トップページ*

---

## スマホ通知（プッシュ通知）

エージェントが応答待ちになったとき、検証ゲートが不合格になったとき、セッションが起動に失敗した
ときに、**アプリを閉じていてもスマホに通知**を出せます（Web Push）。

**この節の手順を最後まで済ませるまで、通知は 1 通も出ません。**
既定では VAPID 鍵が無く、鍵が無い間は push 機能ごと無効です。

### 0. 前提（先に確認してください）

| 前提 | 理由 | 確認方法 |
|------|------|----------|
| **HTTPS でアクセスできること** | Service Worker / PushManager は secure context 必須。`127.0.0.1` は例外扱いですが、**スマホからのアクセスは該当しません**（別ホストなので）。同一LANの `http://<PCのIP>:3000` では購読ボタンが動きません | スマホのアドレスバーが `https://` になっているか |
| **iOS / iPadOS はホーム画面に追加すること** | Safari のタブでは Web Push が使えません。**ホーム画面に追加し、そこから起動した状態**でのみ購読できます | 購読ボタンが出ず「ホーム画面に追加してください」の案内が出たらこれ |
| **Android Chrome は通常のタブでよい** | ホーム画面への追加は不要です | — |

HTTPS を用意する方法は 3 つあります。

- **`commandmate remote`**（いちばん簡単。推奨）: Cloudflare Quick Tunnel の外側が HTTPS なので、
  そのまま secure context の要件を満たします。手順は
  [モバイルからのアクセス](#方法1推奨-commandmate-remote-で-qr-ペアリング) を参照
- **自分で用意するトンネル**（外出先からも使える）: Cloudflare Tunnel など。
  [デプロイガイド](../DEPLOYMENT.md) を参照
- **自己署名証明書**（同一LAN内のみ）:
  ```bash
  brew install mkcert && mkcert -install && mkcert <PCのIPアドレス>
  commandmate start --cert ./<証明書>.pem --key ./<秘密鍵>.pem
  ```

### 1. VAPID 鍵を作る

`commandmate init` が鍵ペアを生成し、`.env` に書き込みます。
**`node -e "require('web-push')..."` のような手打ちは不要です。**

```bash
commandmate init
```

すでに `.env` がある場合は `--force` で作り直せます。
**そのとき既存の鍵ペアはそのまま引き継がれます** —— 公開鍵は購読済み端末の
`PushSubscription` に焼き込まれているため、鍵を作り直すと**購読済みの端末が全部無言で切れる**
からです。

```bash
commandmate init --force
```

### 2. `.env` の 3 変数を確認する

`init` が書き込むのは次の 3 つです。

```bash
CM_VAPID_PUBLIC_KEY=<base64url, 65 バイト>
CM_VAPID_PRIVATE_KEY=<base64url, 32 バイト>
CM_VAPID_SUBJECT=https://github.com/Kewton/CommandMate
```

`CM_VAPID_SUBJECT` は VAPID の `sub` クレーム（このサーバーからの通知に関する連絡先）です。
RFC 8292 は `mailto:` と `https:` の両方を許容します。

> **重要（Apple のみ検証します）**: **APNs は `sub` の妥当性を検証します。**
> `localhost` / ドットを含まないホスト名 / `.local` のような予約 TLD を指定すると
> **403 で拒否され、iPhone・iPad にだけ通知が届きません。**
> Google（FCM）はここに寛容なので、**Android だけで確認すると気づけません。**
> 自分の連絡先にしたい場合は `mailto:you@your-domain.example.org` のように、
> **実在するドメイン**を指定してください。

**`CM_VAPID_PRIVATE_KEY` は秘密鍵です。** `.env` は
[`.gitignore`](../../.gitignore) で追跡外ですが、**コピーした先は追跡外ではありません。**
commit にもチャットにも貼らないでください。

### 3. サーバーを再起動する

```bash
commandmate stop && commandmate start
```

### 4. サーバー側の設定を確認する

```bash
curl -s http://127.0.0.1:3000/api/push/vapid
```

```json
{"configured":true,"publicKey":"BN..."}
```

`"configured": false` なら鍵が読めていません。起動ログか `commandmate status` に理由が 1 行出ます。

```bash
commandmate status
```

```
Push notifications are disabled: no VAPID keys are configured.
  Set CM_VAPID_PUBLIC_KEY and CM_VAPID_PRIVATE_KEY to enable them.
```

**設定が正しいときは、この行は出ません**（正常時は無言です）。
`CM_VAPID_SUBJECT` が APNs に拒否される値のときも、同じ場所に 1 行出ます。

### 5. 端末で購読する

1. スマホのブラウザで **HTTPS の URL** を開く
2. **iOS / iPadOS のみ**: 共有メニュー →「ホーム画面に追加」→ **ホーム画面のアイコンから起動**
3. **More 画面**（モバイルはタブバー、デスクトップはサイドバー）→ **通知**
4. **「通知を有効にする」を押す**
5. ブラウザの許可ダイアログで「許可」

> **押すまで OS の通知設定にサイトは現れません。**
> iOS の「設定 → 通知」や Android の「アプリと通知」を先に見に行っても、
> **購読前は一覧に存在しません。**「許可済みのはず」と誤解しやすい箇所です。

> **Android の注意**: 一度「ブロック」を選ぶと、許可ダイアログは二度と出ません。
> ブラウザのサイト設定から手動で許可し直してください。

購読後、More 画面の**通知**には次の 2 つのスイッチが出ます。

| スイッチ | 内容 | 既定 |
|---------|------|------|
| 対応が必要なとき | 応答待ち・検証ゲートの不合格・上流APIの障害・セッションの起動失敗 | オン |
| 完了も知らせる（任意） | 対応の要らない正常完了 | **オフ** |

### 6. 届かないとき

More 画面の**通知**に、**この端末に届いていない**ことを示すカードが出ます。

| カード | 意味 | 対処 |
|--------|------|------|
| **この端末には通知が届いていません** | プッシュサービスが送信を拒否している（HTTP 403 など）。**購読は削除していません** | 403 が出ているなら、まず `CM_VAPID_SUBJECT` を疑ってください（上記「重要」） |
| **この端末の購読はプッシュサービス側で失効しました** | 404 / 410。ブラウザ側の購読が失効したためサーバーが送信を停止した | 「通知を有効にする」を押し直すと再購読します |

サーバー側では次のログが出ます（`CM_LOG_LEVEL=info`）。

```
[WARN] [push/sender] push-send-failed {"statusCode":403,"consecutiveFailures":4}
[INFO] [push/sender] push-fanout-complete {"kind":"prompt","delivered":1,"failed":1}
```

`delivered` が 0 のまま増えないときは、購読が 0 台か、全端末で失敗しています。

---

## 関連ドキュメント

- [CLI セットアップガイド](./cli-setup-guide.md) - インストールと初期設定
- [UI/UXガイド](../UI_UX_GUIDE.md) - UI実装の技術詳細
- [ステータスインジケーター詳細](../features/sidebar-status-indicator.md) - ステータス検出の仕組み
- [デプロイガイド](../DEPLOYMENT.md) - 本番環境構築手順
- [コンセプト](../concept.md) - CommandMate のビジョン
