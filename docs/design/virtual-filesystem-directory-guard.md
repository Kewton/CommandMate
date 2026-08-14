# 仮想ファイルシステム宛ディレクトリのガード（Issue #1774）

設定されたパスが `/proc` `/sys` `/dev` 配下を指したとき、CommandMate は**失敗するのではなく停止する**。
その入口を 1 か所に集約し、既定値へフォールバックさせる。

---

## 1. 機序

procfs は**存在し得ない子への `mkdir` に EPERM ではなく ENOENT** を返す。Node の recursive mkdir
実装は「ENOENT ＝ 親が無い」と解釈して親を作って再試行する。親（`/proc`）の作成は EEXIST で
成功扱いになるため、**1 階層でもループに入る**。

| 呼び出し | 実測（Docker / `node:*-bookworm`） |
|---|---|
| `fs.mkdirSync('/proc/x/y', {recursive:true})` | **25 秒経っても返らない。CPU 100.4%。メモリ 12.66MiB で平坦** |
| `fs.promises.mkdir('/proc/x/y', {recursive:true})` | **8 秒経っても promise が settle しない**（イベントループは生存） |
| 同じ呼び出し（macOS） | 即 throw（`/proc` が存在しない） |
| 参考: 親が通常ファイルのパス | `ENOTDIR` 0〜1ms（全 OS） |

被害の形が同期版と非同期版で違う。

- **同期版**: イベントループが完全に停止する。**`try/catch` は書いてあっても意味がない**
  （呼び出しが返らないので catch に到達しない）
- **非同期版**: promise が永久に settle せず、**libuv スレッドプールのスレッドを 1 本恒久占有**する。
  既定プールは 4 スレッドなので、4 回踏むとプール枯渇でプロセス全体の fs / dns / crypto が停止する

いずれも**エラーログも OOM も残らない**。PR #1773 の `Unit Tests` は、テスト fixture が
`CM_AGENT_HOOKS_DIR` に `/proc/…` を入れたことでこの状態に入り、**5 時間 31 分 57 秒、出力ゼロ**で
走り続けた（同期版なので vitest 自身の `testTimeout` も発火できない）。

**Linux / コンテナ環境でのみ発現する。** macOS では `/proc` が無いため即 throw して fail-open になり、
ローカルでは構造的に再現しない。

---

## 2. 設計

### 2.1 純関数 1 つ ＋ 述語 1 つ

```
src/config/system-directories.ts
  VIRTUAL_FILESYSTEM_ROOTS  = ['/proc', '/sys', '/dev']   // SYSTEM_DIRECTORIES の部分集合
  isVirtualFilesystemPath(p)                              // 既存の解決機構を共有

src/config/safe-directory.ts
  resolveSafeDirectory(candidate, fallback, source) -> string
```

`resolveSafeDirectory` は **fs を作らない**。symlink 解決のために `realpath` を読むだけで、
procfs 上の `realpath` は即 ENOENT を返すため、この関数自体は決してハングしない。
だからこそ**テストから `/proc` の文字列をそのまま渡せる**。

### 2.2 なぜ `isSystemDirectory` をそのまま使わないのか

`isSystemDirectory()` は `/etc /usr /bin /sbin /var /tmp /dev /sys /proc` を弾く。これは
「**DB をここに置いてよいか**」（SEC-001）という問いへの答えであって、「**ここに mkdir すると
ハングするか**」への答えではない。

実測（`node -e` で `isSystemDirectory` 相当を評価）:

| パス | `isSystemDirectory` | mkdir でハングするか |
|---|---|---|
| `/var/folders/…/T`（macOS の `os.tmpdir()`） | **true** | しない |
| `/tmp/…`（Linux の `os.tmpdir()`） | **true** | しない |
| `/var/log/commandmate` | **true** | しない |
| `/proc/x` `/sys/x` `/dev/x` | true | **する** |

`isSystemDirectory` をログ / hooks ディレクトリに適用すると:

- `tests/setup.ts:15` の `CODEX_HOME ??= join(tmpdir(), 'commandmate-test-codex-home')` が既定値に
  落ち、**テストがユーザーの実 `~/.codex/hooks.json` を書き換える**
- `tests/helpers/agent-hooks-dir.ts` の `useIsolatedAgentHooksDir()` も同様に無効化され、
  実 `~/.commandmate/hooks/` を汚す
- コンテナ運用の `CM_LOG_DIR=/var/log/commandmate` が黙って `<cwd>/data/logs` に化ける

**ハングを防げないうえに正常な構成を壊す。** よって部分集合を名前付きで切り出し、
`VIRTUAL_FILESYSTEM_ROOTS ⊂ SYSTEM_DIRECTORIES` を `tests/unit/config/system-directories.test.ts`
で固定して両者が離れないようにした。

> Issue 本文の「提案する対処 1.」は `isSystemDirectory(candidate)` を使うと書いているが、
> 上表のとおり実測が食い違うため**実測を正とした**。判定機構（`isPathWithin` ＋
> lexical / physical 両解決）は既存のものをそのまま共有しており、「新しいガードを発明しない」という
> 本 Issue の趣旨からは外れていない。

### 2.3 なぜ throw しないのか

ログディレクトリで throw するとロギング自体が死ぬ。hooks は既に fail-open が設計方針
（`hook-settings-generator.buildClaudeLaunchCommand`）。**既定値へフォールバックして `logger.warn`** が
正しい。警告は `(source, candidate)` ごとに 1 回だけ出す — `getLogDir()` は全ログ書き込みの
経路上にあるため、無条件に出すと 1 つの設定ミスがログ洪水になる。

唯一の例外が `writeJsonObjectFile()`（`~/.gemini` ツリー）で、これは env ではなく**引数**で
1 個のファイルを指定される。代わりの既定値が無いので**拒否（throw）**する。呼び出し元
（`writeGeminiHookSettings` / `writeAntigravityHooksConfig`）は既に throw を「hooks 無しで起動」
として扱うので、fail-open の形は変わらない。

---

## 3. 適用箇所

| 設定 | resolver | recursive mkdir | 種別 |
|---|---|---|---|
| `CM_AGENT_HOOKS_DIR` | `hooks/hook-settings-generator.ts` `getHookSettingsDirectory()` | 同ファイル `writeAgentHookSettings` | 同期 |
| `HookSettingsOptions.directory` | 同上 | 同上 | 同期 |
| `CM_LOG_DIR` | `config/log-config.ts` `getLogDir()` | `lib/log-manager.ts` `ensureLogDirectory` | **非同期** |
| `CODEX_HOME` | `hooks/sources/codex/hooks-config.ts` `getCodexHome()` | 同ファイル `writeCodexHookSettings` | 同期 |
| `CodexHookOptions.codexHome` | 同上 | 同上 | 同期 |
| `COPILOT_HOME` | `hooks/sources/copilot/hook-settings.ts` `getCopilotHomeDirectory()` | 同ファイル `writeCopilotHookSettings` | 同期 |
| `CM_OPENCODE_PORT_FILE` | `hooks/sources/opencode/ports.ts` `getOpencodePortFilePath()` | 同ファイル `writePersistedOpencodePorts` | 同期 |
| （引数） | `hooks/sources/gemini/shared-config-tree.ts` `writeJsonObjectFile()` | 同関数 | 同期・**拒否** |

`CM_OPENCODE_PORT_FILE` は**ファイル**パスだが、判定は前置一致なのでディレクトリと同じ扱いで
正しく弾ける（`/proc/ports.json` の親は `/proc` そのもの）。

---

## 4. `grep -rn "mkdirSync(\|mkdir(" src/ | grep recursive` 全 25 件の判定

Issue の「掃き出し対象」。**安全だったものも記載する**（次に読む人が再調査しなくて済むように）。

| # | 箇所 | env 由来のパスが届くか | 判定 |
|---|---|---|---|
| 1 | `lib/hooks/hook-settings-generator.ts:481` | `CM_AGENT_HOOKS_DIR` | **本 Issue で修正** |
| 2 | `lib/log-manager.ts:35` | `CM_LOG_DIR` | **本 Issue で修正**（非同期） |
| 3 | `lib/hooks/sources/codex/hooks-config.ts:458` | `CODEX_HOME` | **本 Issue で修正** |
| 4 | `lib/hooks/sources/copilot/hook-settings.ts:476` | `COPILOT_HOME` | **本 Issue で修正** |
| 5 | `lib/hooks/sources/opencode/ports.ts:140` | `CM_OPENCODE_PORT_FILE` | **本 Issue で修正** |
| 6 | `lib/hooks/sources/gemini/shared-config-tree.ts:83` | 引数（`homedir()` / worktree path 由来） | **本 Issue で拒否を追加**（`HOME` 差し替えが唯一の到達路） |
| 7 | `lib/db/db-instance.ts:43` | `CM_DB_PATH` | 安全。`getEnv()` → `validateDbPath()` が `isSystemDirectory` で弾く（`db-path-resolver.ts:95`） |
| 8 | `lib/db/db-migration-path.ts:161` | `CM_DB_PATH` | 安全。`resolveAndValidatePath()` が `isSystemDirectory` で弾く |
| 9 | `lib/verification/env-snapshot.ts:523` | `CM_DB_PATH` 派生 | 安全（**依存であって保証ではない**）。`resolveEnvSnapshotDir()` = `dirname(CM_DB_PATH)/…` で #7 の検証を継承。`dir` 引数を持つが、本番の呼び出し元は `api/worktrees/[id]/tasks/route.ts:59` の 1 か所のみで既定値を使う |
| 10 | `lib/skills/package-validator.ts:520` | skills state root | 安全。**同関数 517 行で `isSystemDirectory(root)` を明示チェック** |
| 11 | `lib/skills/snapshot-store.ts:132` | skills snapshot root | 安全。**同関数 126 行で `isSystemDirectory(rootDir)` を明示チェック** |
| 12 | `lib/skills/operation-store.ts:69` | `options.root ?? join(ensureConfigDir(), …)` | 安全。env 由来ではない（`homedir()/.commandmate` か `process.cwd()`）。`options.root` はサービス内部と #10/#11 の検証済み root からのみ渡る |
| 13 | `lib/skills/updater.ts:307` | 同上（backup dir） | 安全。#12 と同じ state root 配下 |
| 14 | `lib/skills/updater.ts:316` | 同上（backup payload の各ファイル親） | 安全。#13 の payload dir 配下 |
| 15 | `lib/skills/install-apply.ts:367` | staging target | 安全。#10 で検証済みの staging root 配下 |
| 16 | `lib/git/clone-manager.ts:575` | `dirname(targetPath)` | 安全。`targetPath` は `config.basePath`（DB に登録されたリポジトリルート）＋ repo 名、または検証済み解決パス。env から直接は来ない |
| 17 | `lib/tmux/read-mode.ts:229` | `dirname(getPagerScriptPath())` | 安全。`getPagerScriptPath()` は `join(homedir(), '.commandmate', 'bin', …)` の**定数**。`CM_READ_MODE` / `CM_READ_MODE_KEY` は挙動とキーバインドのみで、パスには効かない |
| 18 | `lib/file-operations.ts:549` | `join(worktreeRoot, relativePath)` | 安全。`checkPathSafety()`（`isPathSafe` ＋ `resolveAndValidateRealPath`）が worktree 外を弾く。`worktreeRoot` は API 経由で DB の `worktree.path` |
| 19 | `lib/file-operations.ts:554` | 同上（親ディレクトリ） | 安全。#18 と同じ検証済みパスの `dirname` |
| 20 | `lib/file-operations.ts:928` | 同上（バイナリ書き込みの親） | 安全。#18 と同じ |
| 21 | `app/api/worktrees/[id]/upload/[...path]/route.ts:129` | `resolve(worktree.path, '.commandmate/attachments')` | 安全。前置一致で `.commandmate/attachments` に限定済み |
| 22 | `cli/utils/env-setup.ts:98` | `join(homedir(), '.commandmate')` | 安全。定数（`homedir()` のみ） |
| 23 | `cli/utils/env-setup.ts:105` | `join(configDir, 'envs')` | 安全。#22 配下 |
| 24 | `cli/utils/env-setup.ts:166` | `getPidsDir()` → config dir 配下 | 安全。#22 配下 |
| 25 | `cli/utils/install-context.ts:122` | `homedir()/.commandmate` または `process.cwd()` | 安全。env 由来ではない |

**残存リスク（申し送り）**

- #6〜#25 の「安全」は**いずれも `HOME` が正気であることに依存**している。`HOME=/proc/x` で
  起動された場合は `homedir()` 由来の経路がすべて同じ穴になる。これは CommandMate 固有ではなく
  Node プロセス全般の前提なので本 Issue の範囲外とした（`writeJsonObjectFile` だけは
  `~/.gemini` を直接書く共通ヘルパなのでガードを入れてある）
- #9 は `CM_DB_PATH` の検証への**依存**であり、独立した保証ではない。`resolveEnvSnapshotDir()` の
  導出元が変わったら再評価が要る

---

## 5. テストの書き方（重要）

- **テストから `/proc` 配下のパスを実 fs 操作に渡さないこと。** 渡した瞬間に Linux CI が無限ループする
- **`process.env.X = '/proc/…'` / `vi.stubEnv` で書かないこと。**
  `tests/unit/guards/no-procfs-env-fixtures.test.ts` が機械的に赤にする（意図的な設計）
- **「書き込めないディレクトリ」の fixture は親が通常ファイルのパス**を使う（全 OS で即 `ENOTDIR`）

本 Issue のテストは 3 段に分けてこの制約を守っている。

| ファイル | 何を固定するか | `/proc` の扱い |
|---|---|---|
| `tests/unit/config/system-directories.test.ts` | 述語が 3 ルートを true、`/tmp` `/var` などを false | **素の文字列引数**。fs も env も触らない |
| `tests/unit/config/safe-directory.test.ts` | resolver の全分岐（拒否・素通し・未設定・warn の重複抑止） | **素の文字列引数** |
| `tests/unit/hooks/virtual-fs-resolver-guards-1774.test.ts` | 5 設定 ＋ 2 オプション引数がガードに繋がっていること | **使わない**。述語を mock して**無害な sentinel パス**で判定させる |
| `tests/unit/hooks/virtual-fs-refusal-1774.test.ts` | 引数を取る入口の実 `/proc` エンドツーエンド（fail-open まで） | **引数として渡す**（guard が許可する形。env には入れない） |

---

## 6. 空振り緑の反証（実測）

10 変異を 1 つずつ注入し、対象 4 ファイル（計 136 テスト）を実行した。**全変異が赤**、
すべて戻して緑に復帰。

| 変異 | 結果 | 赤になったテスト数 |
|---|---|---|
| 1a `CM_AGENT_HOOKS_DIR` のガード呼び出しを外す | RED | 2（resolver-guards） |
| 1b `HookSettingsOptions.directory` のガードを外す | RED | 3（refusal 2 / resolver-guards 1） |
| 1c `CM_LOG_DIR` のガードを外す | RED | 2（resolver-guards） |
| 1d `CODEX_HOME` のガードを外す | RED | 2（resolver-guards） |
| 1e `CodexHookOptions.codexHome` のガードを外す | RED | 3（refusal 2 / resolver-guards 1） |
| 1f `COPILOT_HOME` のガードを外す | RED | 2（resolver-guards） |
| 1g `CM_OPENCODE_PORT_FILE` のガードを外す | RED | 2（resolver-guards） |
| 1h `writeJsonObjectFile` の拒否を外す | RED | 3（refusal 2 / resolver-guards 1） |
| 2 `isVirtualFilesystemPath` を常に false | RED | 32（safe-directory 16 / system-directories 11 / refusal 5） |
| 3 フォールバックを候補値そのままに変える | RED | 23（safe-directory 13 / refusal 3 / resolver-guards 7） |

**経路ごとに個別に赤くなる**ことが要点で、1a〜1h はそれぞれ他の経路のテストを赤くしない。
6 個目のツールが同じ穴を開けたときも、その経路のテストだけが落ちる。
