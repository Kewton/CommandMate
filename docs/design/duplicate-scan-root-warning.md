# 同一 git リポジトリを指す scan root の重複を可視化する — 設計判断

Issue: #1662
関連: #1659（この構成が引き起こした ID churn）/ #1660（churn 自体の修正）/ #1658, PR #1665（Scan トグル＝重複に気付いたあとの対処手段）/ #1517（validate-path の新設）/ #190（`enabled`）/ #690（`visible`）

---

## 1. 何が問題だったか

`CommandAgent` と `CommandAgent-develop` は同一 git リポジトリの 2 つの worktree で、両方が
`repositories` に scan root として登録されていた。`git worktree list` はどちらから叩いても同じ
パス集合を返すので、sync のたびに同じ worktree が 2 回 upsert され、`worktrees.repository_path`
が実行ごとに入れ替わる。これが #1659 の ID churn（sync ごとに worktree ID が 8 hex 伸び、
稼働中セッションが UI から消える）の前提条件だった。

#1660 で churn 自体は塞がれたが、**「なぜ 2 つ登録されているのか」に利用者が気付ける導線は
無いまま**だった。本 Issue はその導線を作る。

---

## 2. 判定方法: `git rev-parse --git-common-dir` の実パス比較

実装は `src/lib/git/git-common-dir.ts`。着手時に実測して確認した点:

| 確認したこと | 実測結果（git 2.49.0） |
|---|---|
| linked worktree からの出力 | 絶対パス（`/…/MyCodeBranchDesk/.git`） |
| main checkout からの出力 | **相対パス（`.git`）** |
| 非 git ディレクトリ | exit 128 `fatal: not a git repository` |
| 2 つの worktree の `git worktree list` | **byte 単位で一致**（29 worktree で実測） |

したがって正規化は 2 段階必要で、どちらも load-bearing:

1. `path.resolve(repoPath, <出力>)` — 相対/絶対の両方を吸収する。
2. `realpath()` — 比較する 2 つの root が別の symlink 経由で同じ実体に届きうる。macOS では
   `/tmp` → `/private/tmp` が実在し、#1659 の worktree 群はまさにその下にあった。字句比較では
   あの組を取り逃がす。

### Issue 本文の「要確認」への回答: 共通ディレクトリ比較で十分

Issue は「共通ディレクトリが同じでも `git worktree list` の結果が食い違うことは通常無いので、
共通ディレクトリ比較で十分と考えられる（要確認）」としていた。**十分である**、それも経験則
ではなく定義から:

`git worktree list` の結果は「main worktree ＋ `<common-dir>/worktrees/*`」であり、共通
ディレクトリから**導出される**。共通ディレクトリが同じなら列挙対象の集合も同じで、食い違う
余地が無い。上表のとおり 29 worktree のリポジトリで byte 一致することも実測した
（`tests/unit/lib/git/git-common-dir.test.ts` が実 git リポジトリを砂箱に作って固定している）。

---

## 3. 決めたこと

### 論点 1: ブロックするか警告か → **警告。ブロックしない**

Issue の推奨どおり警告に留めた。同一リポジトリの複数 worktree をそれぞれ独立した scan root
として管理したい正当なユースケースがありうるため。実装上も「ブロックできない」構造にしてある:

- `POST /api/repositories/validate-path` は `valid` を一切変えず、`duplicateScanRoots` を
  **追加フィールドとして返すだけ**。重複していても `valid: true` のまま。
- `POST /api/repositories/scan`（実際に登録するルート）は **1 行も変えていない**。
  確認ダイアログはクライアント側（`RepositoryManager`）にあり、サーバは登録を拒めない。
- 検出が失敗しても（git が無い/DB が読めない/パスが git リポジトリでない）空配列に縮退する。
  登録フローを阻害しない、という受入条件をコードの形で満たしている。

### 論点 2: 登録済みの可視化をどこに出すか → **行のバッジ。Scan トグルへ導線を張る**

`GET /api/repositories` の各行に `duplicateOf`（同じ git リポジトリである**他の** scan root の
パス）を足し、Repositories 画面の Name セルにバッジを出す。

バッジは静的な `<span>` ではなく **`<button>`** にした。押すとその行の **#1658 Scan トグルに
フォーカスが移る**。「2 つの root が同じリポジトリです」とだけ言われて対処手段を自分で探させる
警告は、ほとんどの人が無視する。#1658 が入った直後だからこそ、remedy が 1 タブ隣にある状態を
そのまま導線にできた。フォーカス移動なので、そこから Enter で確認ダイアログまで到達できる
（Playwright で実測。`tests/e2e/repository-duplicate-scan-root.spec.ts`）。

### 論点 3: 判定対象は `enabled` な行だけ → **そう。無効化済みの root は数えない**

重複が実害を持つのは「同じ worktree が**両方の scan から見える**」ときだけである。
`enabled = 0` の root は `registerAndFilterRepositories` が scan 集合から落とすので
（`POST /api/repositories/sync` と `server.ts` の両方がこれを通る）、二重走査は起きない。
無効化済みの root を数えると「誤検知しない」という受入条件を自分で破ることになる。

副次的だが重要な効果として、**remedy が効いたことが画面で分かる**: 片方を Scan トグルで
外すと、残った行のバッジが消える。これは integration テスト
（`excluding one of the pair clears the warning from the other`）で固定した。

### 論点 4: `is_env_managed` の scan root にも出すか → **出す。区別しない**

Issue が明示的に問うていた点。**同じ警告を出す**、理由は 3 つ:

1. #1659 で実害が出たのはまさに env 由来の側である。そこだけ黙るのは本末転倒。
2. 導線が実際に機能する。env 由来の root でも Scan トグルは効く:
   `getRepositoryPaths()`（`WORKTREE_REPOS`）→ `registerAndFilterRepositories` →
   `ensureEnvRepositoriesRegistered`（**既存行はスキップ**するので `enabled = 0` は保たれる）
   → `filterExcludedPaths`（`enabled = 0` を落とす）。コードで確認済み。
3. `isEnvManaged` は #1352 の時点で「実質 write-only、read path で分岐しているのは migration
   v43 のみ」と docstring に明記されている非推奨フラグである。ここで新たに依存を作らない。

結果として、判定は `repositories` テーブルの `enabled` だけを見る。`is_env_managed` は
本 Issue のコードに一度も登場しない。

### 論点 5: 登録時の検出をどのルートに載せるか → **validate-path（新設しない）**

`#1517` が入れた「入力中のパスを検査する」エンドポイントに相乗りした。専用エンドポイントを
足さなかった理由:

- 入力中に警告を出すには結局 while-typing の往復が要る。それは既に validate-path が
  やっている往復そのもので、2 本目を足せば同じ問いに 2 つの答えが存在することになる。
- validate-path は既に「`scan` が答える問いを先に答える」という役割を持っており、
  「これを登録すると何が起きるか」は同じ役割の範疇にある。

### 論点 6: 送信直前の再確認と、その締め切り

while-typing の検査は 400ms デバウンスされているので、パスを貼り付けて即座に "Scan & Add" を
押すと**警告が出る前に登録が終わってしまう**。これでは「登録しようとすると警告が出る」という
受入条件が、急いでいる人に対してだけ成立しない。そこで submit 時に「手元の検査結果が今の
入力のものか」を照合し、違えば再問い合わせする（`validatedPath` state）。

ただし再問い合わせには **400ms の締め切り**を付けた（`DUPLICATE_CHECK_DEADLINE_MS`）。
検出は助言であって前提条件ではないので、応答しないエンドポイントが "Scan & Add" を永久に
固まらせてよい理由が無い。締め切りを超えたら警告なしで登録し、重複していれば
**一覧のバッジ側が後から拾う**。対になる 2 経路があることが、片方に締め切りを付けられる理由に
なっている。

（この締め切りは机上の懸念ではない。既存の `RepositoryManager.test.tsx` が
`validatePath: () => new Promise(() => {})`＝永久に応答しないモックを使っており、締め切りを
入れる前は実際にそのテストが固まって落ちた。）

---

## 4. 実装（変更点）

| ファイル | 変更 |
|---|---|
| `src/lib/git/git-common-dir.ts` | **新規**。`resolveGitCommonDir` / `resolveGitCommonDirs` / `findDuplicateScanRoots` / `findScanRootsSharingGitRepository` |
| `src/app/api/repositories/route.ts` | GET の各行に `duplicateOf: string[]` を追加（enabled な行だけを比較） |
| `src/app/api/repositories/validate-path/route.ts` | レスポンスに `duplicateScanRoots: string[]` を追加。DB/git の失敗は空配列に縮退 |
| `src/lib/api-client.ts` | `RepositoryListItem.duplicateOf?` / `ValidatePathResponse.duplicateScanRoots?`（**optional**＝既存のリテラルを壊さない） |
| `src/components/repository/RepositoryManager.tsx` | 入力中の警告行＋submit 時の確認ダイアログ（締め切り付き再検査） |
| `src/components/repository/RepositoryList.tsx` | Name セルの重複バッジ（押すと Scan トグルへフォーカス）、無効化時に partner の警告も畳む |
| `locales/{en,ja}/common.json` | 警告文・確認ダイアログ・バッジのキー 6 個 |

`POST /api/repositories/scan`、`DELETE /api/repositories`、`PUT /api/repositories/[id]`、
`src/lib/db/**` は**一切変更していない**。

### 誤検知を避けるための 2 つの除外

1. **同じ root の再登録は重複ではない**。`findScanRootsSharingGitRepository` は候補パスと
   実パスが一致する既存 root を除外する。除外しないと、既に登録済みのパスを再 scan する
   たびに警告が出る。
2. **symlink 違いの綴りも同じ root と見なす**。実パスで比較しているので、`/tmp/x` と
   `/private/tmp/x` は「2 つ目の root」ではなく「同じ root」になる。

---

## 5. 検証

| 種別 | 結果 |
|---|---|
| `npm run lint` | exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run test:unit` | exit 0（764 files / 13953 tests） |
| `npm run test:integration` | exit 0（73 files / 1079 tests） |
| `npm run test:e2e` | exit 0（86 passed、うち本 Issue 分 8） |

`git-common-dir` の単体テストと API の結合テストは、**実 git リポジトリを砂箱に作って**
走らせている（`git init` ＋ `git worktree add`）。この機能の主張はすべて「git が実際に何を
出力するか」についての主張なので、`execFile` をモックしても自分で書いた文字列を自分で
パースできることしか確かめられない。砂箱を `os.tmpdir()` に置いているのも意図的で、macOS では
そこ自体が symlink 越し（`/var` → `/private/var`）なので realpath 正規化が全アサーションで
効く。

### 変異注入（テストが空振りでないことの確認）

修正後に緑であることは「ガードが効いている」とも「アサーションが何も見ていない」とも整合する
ので、12 個の変異を注入して**全て赤になること**を実測した:

| # | 変異 | 殺したテスト |
|---|---|---|
| M1 | 共通ディレクトリの realpath 正規化を外す | unit 7 |
| M2 | git 出力を `path.resolve` せず素で返す | unit + integ 16 |
| M3 | 「候補自身の既存 root」の除外を外す | unit + integ 1 |
| M4 | GET が常に `duplicateOf: []` を返す | integ 4 |
| M5 | GET が disabled 行も比較対象に含める | integ 1 |
| M6 | validate-path が常に空配列を返す | integ 1 |
| M7 | validate-path が `enabled` を無視する | integ 1 |
| M8 | submit が確認ダイアログを出さない | component 4 |
| M9 | submit が古い while-typing 結果を信じる | component 3 |
| M10 | バッジを常に描画しない | component 7 |
| M11 | バッジが Scan トグルにフォーカスを渡さない | component 1 |
| M12 | 無効化しても partner のバッジが残る | component 2 |

---

## 6. 残っている限界（意図的に手を付けていない）

- **検出は `GET /api/repositories` のたびに git を呼ぶ**（enabled な行の数だけ、並列、各 1s
  timeout）。この画面は利用者の遷移で読まれるだけでポーリングされないので、キャッシュは
  入れていない。scan root が数十を超える運用が現れたら見直す余地がある。
- **警告は scan root 同士の比較でしかない**。同じリポジトリの worktree が `worktrees` に
  二重登録されているかどうかは見ていない。それは #1660 が別途塞いだ層である。
- **`server.ts` の起動時 purge の危険（#1658 の設計書 §残課題）はそのまま**。本 Issue の
  scope 外で、#1666 が別途扱っている。
