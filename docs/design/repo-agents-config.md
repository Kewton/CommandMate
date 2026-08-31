# リポジトリ単位の既定エージェント（`.commandmate/agents.yaml`）

- **関連 Issue**: [#2066](https://github.com/Kewton/CommandMate/issues/2066)（本書）／[#2065](https://github.com/Kewton/CommandMate/issues/2065)（サーバ全体の既定）
- **実装**: `src/lib/repo-config/agents-config.ts`
- **解決関数**: `src/lib/selected-agents-validator.ts` の `resolveSelectedAgents()`
- **テスト**: `tests/unit/repo-config/agents-config-2066.test.ts` ／ `tests/unit/db/repo-agents-yaml-2066.test.ts` ／ `tests/unit/lib/worktrees-repo-agents-sync-2066.test.ts` ／ `tests/unit/app/api/worktrees-repo-agents-roster-2066.test.ts`（§2.1 を `GET /api/worktrees` の応答で固定）

---

## 1. 何を解決するか

#2065 が入れたのは **サーバ全体で 1 つの既定**（`app_settings.default_selected_agents`）である。
「このリポジトリは opencode 中心、あのリポジトリは claude 中心」という運用はこれでは表せない。
`repositories` テーブルにエージェント列は無く、リポジトリ管理 UI にも設定項目は無い。

そこで **リポジトリ配下の宣言ファイル**を 1 層足す。`.commandmate/verify.yaml`（#1540）と
`.commandmate/tasks/*.yaml`（#1545）に続く 3 つ目の宣言ファイルである。

---

## 2. 優先順位

`SELECTED_AGENTS_LAYERS`（`src/lib/selected-agents-validator.ts`）が**唯一の**順序の定義。

| 順位 | 層キー | 出所 | 入れた Issue |
|:---:|---|---|---|
| 1 | `worktree` | `worktrees.selected_agents` 列 | #368 |
| 2 | `repo` | **`<repo>/.commandmate/agents.yaml`** | **#2066** |
| 3 | `appSettings` | `app_settings.default_selected_agents` | #2065 |
| 4 | （最後） | `DEFAULT_SELECTED_AGENTS` 定数 | #1516 |

`repo` は #2065 の時点で配列に**宣言だけされていて値が来ていなかった**。#2066 がやったのは
**呼び出し側で値を渡すこと**だけで、`resolveSelectedAgents()` 本体も配列の順序も変えていない。

値を渡す場所は **2 つだけ**で、どちらも `src/lib/db/worktree-db.ts` にある:

| 呼び出し側 | 渡し方 |
|---|---|
| `getWorktrees()` | `repository_path` ごとに 1 回だけ解決（行ごとではない） |
| `getWorktreeById()` | 行の `repository_path` |

`resolveAgentInstances()` は**この層を持たない**。本番の呼び出し側 6 箇所は全て
`worktree.selectedAgents`（= 上の 2 関数が既にリポジトリ層まで解決した値）を渡すので、
そこに `repositoryPath` 引数を足しても**本番からは一度も渡されない引数**になる
（#2066 の統合レビュー M5。初版には在ったが削除した）。層の入口は 1 箇所である。

---

### 2.1 `agent_instances` を持つ worktree にはリポジトリ宣言を渡さない

**これは `selectedAgents` 側にも効かせる必要がある。**

`resolveAgentInstances()` の early return はロスター（`agentInstances`）を守るが、
`selectedAgents` は**同じクエリから出るもう 1 本の経路**で、その消費者はロスターを見ない:

```
src/app/sessions/page.tsx:341            wt.selectedAgents ?? getClientDefaultSelectedAgents()
src/components/review/ReviewTab.tsx:246  （同じ行）
```

`PATCH /api/worktrees/[id]` は `agentInstances`（route.ts:208）と `selectedAgents`
（route.ts:181）を**独立した分岐**で書くので、`AgentInstancesPane` でロスターを編集した
worktree は「`agent_instances` はある・`selected_agents` は NULL」になる。scan で作られた
worktree はそもそもこの状態で始まる。ここでリポジトリ層を通すと、**タブは変わらないのに
/sessions と Review のチップだけが宣言どおりに描き変わり、実際に動いているエージェントが
「稼働中エージェント」から消える**（#2066 の統合レビュー H1）。

したがって `getWorktrees()` / `getWorktreeById()` は、**`agent_instances` の行を持つ
worktree にはリポジトリ層を渡さない**。

- **供給側で止めた**（消費側 2 箇所を直すのではなく）。`selectedAgents` の消費者は今後も
  増えるので、増えるたびにこの規則を覚えていなければならない形にしない。
  `SkillTargetSelector` のように `agentInstances` を優先する作法は既に在るが、それは
  「正しく書けば正しい」であって不変条件ではない。
- **リポジトリ層だけを止めている。** `appSettings` 層にも同じ穴があるが（#2065）、
  そちらを変えるのは #2065 の挙動変更になる。#2066 が答えるべきなのは、この穴を
  **「サーバ設定を触れる管理者」から「リポジトリにコミットできる全員」に広げた**ことである。
- **コストは 0 か 1 クエリ。** ロスターの照会は「どこかのリポジトリが実際に宣言している」
  ときにしか走らず、走るときも `getWorktrees()` 1 回につき
  `SELECT DISTINCT worktree_id FROM agent_instances` **1 本**（行数に比例しない）。
  宣言が無いインストールでは #2066 以前とクエリが完全に同一になる。

結果として、**`agent_instances` の行が既にある worktree は `agentInstances` も
`selectedAgents` も一切変わらない。**

---

## 3. なぜ `CMATE.md` ではなく新しいファイルか

`CMATE.md` は既にスケジュール定義を持っているので候補ではあった。採らなかった理由は 3 つ。

| 論点 | `CMATE.md` | `.commandmate/agents.yaml` |
|---|---|---|
| **スコープ** | **worktree** のルートから読む（`cmate-parser.ts` は worktree ディレクトリ配下に解決を強制する） | **リポジトリ**のルート。worktree のロスターが存在する前に読める＝これが要件そのもの |
| **文法** | Markdown の**表**。順序つきリスト＋任意の primary をセル 1 個に押し込むことになる | YAML のリスト。`validateAgentsPair()` にそのまま渡せる |
| **巻き添え** | `parseCmateConfig()` はスケジュール実行経路。キーを足すとスケジュール読み取りのたびにエージェント ID を検証することになり、壊れた agents キーがスケジュールを乱す経路になる | 独立。壊れても次の層に落ちるだけ |

---

## 4. 書式（v1）

```yaml
version: 1        # 任意。書くなら 1
agents: [codex, claude]
primary: claude   # 任意。agents のいずれか。指定すると先頭に移動する
```

- トップレベルキーは `version` / `agents` / `primary` の**閉じた集合**（`verify.yaml` と同じ方針）。
- `agents` は `validateAgentsPair()` に通す = **2〜6 個・重複なし・`CLI_TOOL_IDS` のいずれか**。
  #2065 が `app_settings` に課しているのと同一の制約であり、検証関数を共有している。
- `primary` は `agents` の要素でなければならない。

---

## 5. fail-open

**例外を投げない。** 次のいずれでも `null` を返し、**警告ログを出して次の層に落ちる**。

| ログ action | 状況 |
|---|---|
| `repo-agents:yaml-parse-failed` | YAML として読めない |
| `repo-agents:not-a-mapping` | トップレベルがマッピングでない |
| `repo-agents:unknown-keys` | 未知のキー（`agent:` のような綴り間違いを捕まえる） |
| `repo-agents:unsupported-version` | `version` が 1 でない |
| `repo-agents:agents-not-a-list` | `agents` が無い／リストでない |
| `repo-agents:invalid-agents` | `validateAgentsPair()` 不合格 |
| `repo-agents:primary-not-in-agents` | `primary` が `agents` に無い |
| `repo-agents:read-failed` | 読めない（EISDIR など。ENOENT / ENOTDIR は無音） |
| `repo-agents:too-large` | 64KB 超 |

**空ファイル・コメントだけのファイルは警告しない。** 「宣言していない」はファイルが無いのと同義で、
間違いではないため。

ログに載せる値は制御文字を除去して切り詰める（R4-005）。宣言ファイルはリポジトリに push できる者が
書くもので、サーバログは端末で tail されるため、ANSI エスケープをそのまま通してはならない。

---

## 6. いつ読むか — #1913 のホットパス規則との関係

`getWorktrees()` はサイドバーのポーリングのたびに走る。#1913 が
「ホットパスでファイルシステムを叩かない」を規則にし、#2065 は
`src/config/installed-agents-cache.ts` で
「`getWorktrees()` にファイルシステムプローブを生やしてはならない」と明文化している。

この層は本質的にファイル読みなので、Issue の指定どおり **sync のときに読む**構造にした上で、
TTL を足して自己修復させている。

| 経路 | 読むタイミング |
|---|---|
| `scanWorktrees()` → `refreshRepoAgentsConfig()` | **同期のたび**（リポジトリごとに 1 回）。Issue が指定した読み取り |
| `getRepoDefaultSelectedAgents()` | メモリを見る。ディスクに行くのは **cold miss**（前回同期以降にサーバを再起動した。SQLite の行はプロセスより長生きするので「このプロセスで最低 1 回スキャン済み」は仮定できない）と **TTL 切れ**（`REPO_AGENTS_CACHE_TTL_MS` = 60 秒）だけ |

最悪でも **リポジトリ 1 個あたり毎分 1 回の小さな `readFileSync`**。worktree 数にも
ポーリング回数にも比例しない。`getWorktrees()` 内ではさらに `repository_path` ごとに
1 回へメモ化している（同一リポジトリの worktree が 10 個あっても問い合わせは 1 回）。

**否定的な答えもキャッシュする。** そうしないと壊れたファイルを持つリポジトリが
ポーリングのたびに警告を吐き、有用な警告がノイズになる。

---

## 7. 積み残し

- **`.gitignore` の除外解除**: CommandMate 自身のリポジトリの `.gitignore` は
  `/.commandmate/*` を許可リスト方式で除外しており（[commandmate-directory-tracking.md](./commandmate-directory-tracking.md)）、
  `agents.yaml` の負パターンはまだ無い。自リポジトリで dogfooding するときは
  `!/.commandmate/agents.yaml` を足し、同文書の表と
  `tests/unit/config/commandmate-tracking.test.ts` も併せて更新すること。
  #2066 の scope 外だったため本 PR では触っていない。
- **UI からの編集**: 現状は手でファイルを置く。リポジトリ管理 UI からの編集は未実装。
  `parseRepoAgentsConfig()` を export してあるのは、その画面がアップロード内容を
  同じ規則で検証できるようにするため。
