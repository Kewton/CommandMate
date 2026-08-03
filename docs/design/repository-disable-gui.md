# リポジトリの「無効化」を GUI から行えるようにする（非破壊）— 設計判断

Issue: #1658
関連: #190（`enabled` 導入）/ #690（`visible` 導入）/ #1346, #1347（除外時のパス正規化）/ #1349（vanished repo の prune）/ #1659, #1660（同一 git repo が 2 scan root から見えると ID が伸びる）

---

## 1. 何が問題だったか（着手時の実測）

Issue 本文の表を着手時にコードで取り直した結果、記載はおおむね正しかった。差分は 1 点（§7）。

| 面 | 実測 |
|---|---|
| `RepositoryList.tsx` のトグル | `visible` のみ。`enabled` は読み取り専用の "Status" バッジ |
| `PUT /api/repositories/[id]` | `displayName` と `visible` のみ受理 |
| `GET /api/repositories/excluded` | 実装済み。`src/` 全体で呼び出し元 **0** |
| `PUT /api/repositories/restore` | 実装済み。`src/` 全体で呼び出し元 **0** |
| `api-client.ts` の `delete` / `restore` / `getExcluded` | 定義済み。`src/` からも `tests/` からも呼び出し元 **0** |

`enabled = 0` に到達する唯一の経路は `DELETE /api/repositories`（`disableRepository` →
`cleanupMultipleWorktrees` で配下 worktree の tmux セッションを kill → `cleanupRooms` →
`deleteRepositoryWorktrees` で worktree 行を削除）。つまり「走査対象から外したいだけ」の
利用者に用意されていた唯一の道が「履歴を捨てて稼働セッションを殺す」だった。

---

## 2. 決めたこと

### 論点 1: 既存 `DELETE` との関係 → **挙動は変えず、GUI からは露出しない**

`DELETE /api/repositories`（除外 + purge）の実装は 1 行も変えていない。理由:

- CLI・外部クライアントの契約であり、本 Issue は「非破壊の選択肢が無い」ことが問題であって
  「破壊的な選択肢がある」ことは問題ではない。両方あってよい。
- Repositories 画面には元々 delete ボタンが**無かった**。ここで足すのは Issue の依頼範囲外で、
  かつ「削除」と「無効化」が並ぶ画面を新規に作ることになり、取り違えのリスクだけが増える。

結果として画面上には非破壊の操作しか存在しないため、「削除と無効化の見分け」は
「削除が無い」ことで担保される。`RepositoryList.tsx` の冒頭に、`repositoryApi.delete()` を
ここに配線しない理由をコメントで残した。

### 論点 2: worktree 行の扱いと `visible` との組み合わせ → **行は残す。`visible` とは直交のまま**

- 無効化は `UPDATE repositories SET enabled = 0` の 1 文だけ。`worktrees` にも子テーブルにも触れない。
- `enabled`（走査対象）と `visible`（サイドバー表示）は**直交のまま**にした。
  無効化時に `visible` も自動で 0 にする案は採らない:
  - #690 が「概念を分離する」と明記して入れた不変条件（`disable/restore` は `visible` を触らない）を
    壊す。
  - 自動で落とすと、再有効化時に「元の `visible` は何だったか」を復元できず、
    利用者の選択を推測で上書きすることになる。
  - 「走査は止めたいが、既にある worktree のターミナルとチャット履歴には引き続き入りたい」は
    実際にあるユースケースで、自動非表示はそれを潰す。
- 代わりに、**無効化しても worktree がサイドバーに残ることを確認ダイアログ本文で明示**し、
  消したい場合は Visibility トグルを使うよう誘導する（`repositories.disableConfirmBody`）。

> サイドバーの絞り込みが `visible` のみを見ている（`src/lib/sidebar-utils.ts`）ことは実測済み。
> 「`visible && enabled` で絞る」案は本 Issue の scope 外ファイルに触れるため採っていない。
> 上記のとおり直交を選んだので、そもそも変更は不要。

### 論点 3: 稼働中セッション → **kill しない。ダイアログで明言する**

`PUT /api/repositories/[id] { enabled: false }` は `@/lib/session-cleanup` を import すらしない。
`tests/unit/api/repository-scan-toggle.test.ts` が `cleanupMultipleWorktrees` /
`killWorktreeSession` を mock して**一度も呼ばれないこと**を固定している。

「無効化したのにセッションが動き続ける」ことの見せ方は、確認ダイアログ本文で先に約束する形にした
（"any tmux session running under it keeps running"）。行の worktree 件数もそのまま残るので、
一覧上でも「何も消えていない」ことが読める。

### 論点 4: prune との干渉 → **誘発しない。テストで固定**

無効化されたリポジトリは走査されないので、そのリポジトリの worktree は scan 結果に現れない。
2 つの prune 経路それぞれについて、行が消えないことを確認した:

- `syncWorktreesToDB` の per-repo prune は**scan に現れた `repositoryPath` のグループだけ**を
  ループする。無効化されたリポジトリはグループを持たないので、そのループに入らない。
- `pruneStaleRepositoryWorktrees` は `repositoryExistsOnDisk()` が false のときだけ削除する。
  ディレクトリが存在する限り無効化は削除条件を満たさない（#1349 の保守的ガードがそのまま効く）。

#1659 の発端そのもの（同一 git repo を指す 2 つの scan root の片方を無効化する）も
テストで固定した: 生き残った scan root の `git worktree list` は無効化した側のディレクトリを
返し続けるので、その行は `repository_path` が付け替わるだけで ID も履歴も保たれる。

### 論点 5: `MAX_DISABLED_REPOSITORIES`（SEC-SF-004）→ **新経路にも適用。409 を返す**

`setRepositoryEnabled()` は無効化のときだけ上限を検査し、超過時に
`RepositoryDbError(code: 'LIMIT_EXCEEDED')` を投げる。ルートはこれを **409** に写像する。
既に無効なリポジトリの再無効化は行を増やさないので常に許可する（上限に達した状態でも
再有効化 → 再無効化ができることをテストで固定）。
`disableRepository()` に埋まっていた同じ COUNT クエリは `countDisabledRepositories()` に
括り出し、2 経路が同じ数え方をすることを保証した。

---

## 3. 実装（変更点）

| ファイル | 変更 |
|---|---|
| `src/lib/db/db-repository.ts` | `setRepositoryEnabled(db, id, enabled)` と `countDisabledRepositories(db)` を追加。`RepositoryDbError` に `LIMIT_EXCEEDED` を追加 |
| `src/app/api/repositories/[id]/route.ts` | `enabled`（boolean）を部分更新として受理。上限超過は 409。レスポンスに `enabled` を追加 |
| `src/lib/api-client.ts` | `repositoryApi.updateEnabled(id, enabled)` を追加 |
| `src/components/repository/RepositoryList.tsx` | "Status" 列を **Scan トグル**に変更。無効化は確認ダイアログ経由。再有効化は `restore`。`All / Disabled` フィルタを追加 |
| `locales/{en,ja}/common.json` | 確認ダイアログ・フィルタ・結果メッセージのキーを追加 |

### 無効化と再有効化で経路が違う理由

- **無効化**: `PUT /api/repositories/[id] { enabled: false }`。フラグを 1 つ書くだけ。
- **再有効化**: `PUT /api/repositories/restore { repositoryPath }`。フラグを戻したうえで
  **再 scan** するので、worktree がその場で一覧に戻る。`enabled: true` の PUT でも
  フラグは戻るが、次の Sync All まで worktree は戻ってこない。「復元」と言われて
  期待されるのは前者なので、GUI は `restore` を使う。
  これで Issue が指摘していた「呼び出し元ゼロの `restore`」も配線された。

### `GET /api/repositories/excluded` を配線しなかった理由

無効化中の一覧は、画面が既に読み込んでいる `GET /api/repositories`（enabled/disabled の
**両方**を返す）のクライアント側フィルタで出している。`excluded` はその厳密な部分集合を
返すだけなので、配線すると同じ行に対して 2 つの真実の源と余分な往復が生まれる。
呼び出し元ゼロのままである点は変わらないが、それは本 Issue の症状であって要件ではない。

### 楽観的更新にしなかった理由

Visibility トグル（#690）は楽観的更新 + 失敗時ロールバック。Scan トグルの無効化は
**確認ダイアログを挟んだ直後**なので、先に反映して失敗で戻すと「ダイアログが嘘をついた」
ように見える。サーバが受理してから行を動かす。

---

## 4. 残っていた危険 — `server.ts` の起動時 purge（**#1666 で解消済み**）

> **状態: 解決済み（Issue #1666）。** 以下は #1658 時点の記録で、指摘そのものは実測で正しかった。
> 実際に当てた差分と、当時の記述と食い違った点は [§6](#6-1666-での対応記録) に残す。

**本 Issue の scope.allow に `server.ts` が含まれていないため、ここだけ手を付けていない。**

`server.ts` の `initializeWorktrees()`（起動時に無条件で走る）は、
`registerAndFilterRepositories()` が返す `excludedPaths` に対して次を行う:

```js
for (const excludedPath of excludedPaths) {
  const worktreeIds = getWorktreeIdsByRepository(db, resolveRepositoryPath(excludedPath));
  if (worktreeIds.length > 0) {
    await cleanupMultipleWorktrees(worktreeIds, killWorktreeSession);  // セッションを kill
    deleteWorktreesByIds(db, worktreeIds);                             // 行と子データを削除
  }
}
```

`excludedPaths` は `allPaths`（= `WORKTREE_REPOS` の env パス ∪ DB 登録済みで `enabled` なパス）
から絞り込みで落ちたものなので、

- **DB 登録のみのリポジトリ**を無効化した場合: `dbEnabledPaths` から外れるので `allPaths` に
  そもそも入らない → `excludedPaths` に入らない → **purge されない**（安全）。
- **`WORKTREE_REPOS` に列挙されているリポジトリ**を無効化した場合: env 由来なので `allPaths` に
  残り、絞り込みで落ちて `excludedPaths` に入る → **次のサーバ再起動で worktree 行が削除され、
  稼働中の tmux セッションが kill される**。

本 Issue の発端（`CommandAgent` と `CommandAgent-develop` を両方 scan root に登録）は
まさに後者の形なので、この経路は机上の話ではない。

この purge は #202 の「除外したリポジトリの worktree をサイドバーから消す」という要件の実装で、
当時は `enabled = 0` に至る唯一の経路が purge 済みの `DELETE` だったため実質 no-op だった。
非破壊の無効化が入ると destructive になる。

**必要な修正（1 箇所、`server.ts` のみ）**: 監査ログは残し、purge ループを落とす。

```diff
       if (excludedCount > 0) {
         console.log(`Excluded repositories: ${excludedCount}, Active repositories: ${filteredPaths.length}`);
         // SF-SEC-003: Log excluded repository paths for audit/troubleshooting
         excludedPaths.forEach(p => {
           console.log(`  [excluded] ${p}`);
         });
-
-        // Issue #202/#526: Remove worktrees of excluded repositories from DB
-        // SF-002: cleanup -> delete order for excluded repositories
-        // Sessions must be stopped before DB records are removed
-        for (const excludedPath of excludedPaths) {
-          const resolvedPath = resolveRepositoryPath(excludedPath);
-          const worktreeIds = getWorktreeIdsByRepository(db, resolvedPath);
-          if (worktreeIds.length > 0) {
-            // Issue #526: Clean up tmux sessions before deleting from DB
-            await cleanupMultipleWorktrees(worktreeIds, killWorktreeSession);
-            const result = deleteWorktreesByIds(db, worktreeIds);
-            console.log(`  Removed ${result.deletedCount} worktree(s) from excluded repository: ${resolvedPath}`);
-          }
-        }
       }
```

`resolveRepositoryPath` / `getWorktreeIdsByRepository` / `deleteWorktreesByIds` /
`cleanupMultipleWorktrees` / `killWorktreeSession` の import が他で使われていなければ
併せて削除する（`cleanupMultipleWorktrees` は他でも使われている）。

削除しても #202 が壊れないことの根拠: 除外されたリポジトリは scan されないので
`syncWorktreesToDB` はその worktree を upsert し直さない。行はそのまま残るが、それが
本 Issue の**目的**である。サイドバーから消したい利用者には `visible` トグルがある。

---

## 5. テスト

| ファイル | 固定していること |
|---|---|
| `tests/unit/lib/repository-disable-nondestructive.test.ts` | `setRepositoryEnabled` の意味論 / `visible` 非干渉 / SEC-SF-004 上限 / **worktree 行・chat history・tasks・verification_runs が 1 行も消えない** / 無効化パスが scan 対象から外れる / 2 つの prune 経路が行に届かない / #1659 の 2 scan root ケース / 消えたリポジトリの prune は従来どおり効く |
| `tests/unit/api/repository-scan-toggle.test.ts` | PUT の検証と永続化 / `visible` 非干渉 / 409 / **worktree 行が消えない** / **`cleanupMultipleWorktrees` と `killWorktreeSession` が呼ばれない** / DB 登録経路と **`WORKTREE_REPOS` 経路の両方**で sync が無効化パスを走査しない / 無効化が sync をまたいで維持される |
| `tests/unit/components/repository/RepositoryList-scan-toggle.test.tsx` | Scan トグルが Visibility トグルと別の操作であること / 無効化は確認必須 / 確認本文が実辞書で 3 つの約束を述べていること / cancel で何も起きない / 再有効化が `restore` を通ること / Disabled フィルタ |
| `tests/e2e/repository-scan-toggle.spec.ts` | 上記を**実ブラウザ**で。portal + focus trap + 退出アニメーション付きの実 `Modal`、実 `next-intl` 辞書、実 fetch を通した往復（PUT の body と `restore` の宛先を記録して検証）。jsdom で緑でも動かなかった前科（CommandPalette）があるため、UI を触る変更はここまで見る |

### 変異注入（テストが空振りでないことの確認）

| 変異 | 結果 |
|---|---|
| M1: `setRepositoryEnabled` が `visible` も落とす | RED |
| M2: SEC-SF-004 の上限判定を無効化 | RED |
| M3: sync が `filteredPaths` ではなく `allPaths` を走査 | **初回 GREEN（空振り）** → テストを補強して RED |
| M4: PUT が `cleanupMultipleWorktrees` を呼ぶ | RED |
| M5: Scan トグルが確認を挟まず即 PUT | RED |
| M6: `pruneStaleRepositoryWorktrees` の on-disk ガードを外す | RED |
| M7: 確認本文から「何も消えない」の一文を落とす | RED |
| M5'（e2e）: Scan トグルが確認を挟まず即 PUT | RED（5 件中 2 件が落ちる） |

M3 が最初 GREEN だったのは、当初のテストが **DB 登録経路**しか通していなかったため。
DB 登録経路では `getAllRepositories(db).filter(r => r.enabled)` が先に効くので、
`registerAndFilterRepositories` の除外を壊しても結果が変わらない。
`WORKTREE_REPOS` 経路（= §4 の危険な経路であり、Issue の発端の形）を足して初めて赤になった。

---

## 6. #1666 での対応記録

Issue: #1666 / 本ドキュメント [§4](#4-残っていた危険--serverts-の起動時-purge1666-で解消済み) のフォロー。

### 6.1 §4 の指摘は実測どおりだった

`server.ts` の `initializeWorktrees()` を実際に走らせて確認した（後述の
`tests/unit/lib/startup-excluded-repository-purge.test.ts` は modification 前に RED になる）。
`WORKTREE_REPOS` に列挙されたリポジトリを #1658 の Scan トグルで無効化して再起動すると、
worktree 行・`chat_messages`・`tasks`・`verification_runs` がすべて 0 行になり、
`cleanupMultipleWorktrees(['wt-…'], killWorktreeSession)` が呼ばれた。
DB 登録のみのリポジトリが安全であることも同じハーネスで確認した。

### 6.2 §4 の記述と食い違った点（実測を正とする）

| §4 / Issue #1666 本文の記述 | 実測 |
|---|---|
| 「`cleanupMultipleWorktrees` は他でも使われている」 | **リポジトリ全体では真だが `server.ts` 内では偽**。`server.ts` での唯一の呼び出し元が purge ループだったので、この import も削除が必要だった。残す読み方をすると未使用 import が残る |
| 「lint が未使用 import を弾く」（Issue 本文） | **偽**。`npm run lint` は `eslint src --ext …` で `server.ts` を対象にしない。`tsconfig.json` に `noUnusedLocals` も無い。実際に未使用 import を足して `npm run lint` / `npx tsc --noEmit` を回し、**両方 exit 0** であることを確認した。5 つの import は目視で落とした |

削除した import: `resolveRepositoryPath` / `getWorktreeIdsByRepository` /
`deleteWorktreesByIds` / `cleanupMultipleWorktrees` / `killWorktreeSession`。
`./src/lib/db` からの import 行は空になったので行ごと削除した。
`syncWorktreesAndCleanup` は sync 側で使うため残る。

### 6.3 対になる経路の点検

「除外を検出する側」は `registerAndFilterRepositories()` の 1 箇所、
「除外されたものをどう扱う側」はその呼び出し元 2 箇所しかない。

| 呼び出し元 | `excludedPaths` の扱い |
|---|---|
| `server.ts` `initializeWorktrees()` | **purge していた** → ログのみに変更 |
| `POST /api/repositories/sync` | `filteredPaths` しか分解代入しておらず、元から破壊しない |

起動時に走るもう 1 つの削除経路（`syncWorktreesToDB` の per-repo prune）は、
scan に現れた `repositoryPath` のグループだけをループする。無効化されたリポジトリは
グループを持たないので届かない（#1658 §2 論点 4 の再確認）。
`pruneStaleRepositoryWorktrees` は sync ルート専用で起動時には走らない。
`DELETE /api/repositories`（除外 + purge）は #1658 同様、1 行も変えていない。

### 6.4 #202 の要件をどう担保するか → **要件を「表示」と「削除」に分けて読み直した**

#202 は「除外したリポジトリの worktree がサイドバーに残る」ことへの対処で、
当時の実装手段が行削除だった。それが妥当だったのは、#202 の時点で `enabled = 0` に
到達する唯一の経路が `DELETE /api/repositories`（既に purge 済み）だったからで、
起動時 purge は実質 no-op のガードにすぎなかった。

- **見せない**のは `visible` の役割（#690 が「概念を分離する」と明記して導入した）。
  サイドバーの絞り込みは `src/lib/sidebar-utils.ts` で `visible` のみを見る。
- **走査対象から外す**のが `enabled` の役割。除外されたリポジトリは scan されないので、
  `syncWorktreesToDB` が行を作り直すこともない。

行削除は「表示フィルタを履歴の破棄で実装する」ことになり、しかも再有効化で取り消せない。
`enabled` と `visible` が分離された後は、#202 の目的（見えなくする）は `visible` で満たせる。
よって **#202 の要件は維持し、実装手段だけを行削除から `visible` に移した**。
#1658 が確認ダイアログ本文（`repositories.disableConfirmBody`）で
「無効化しても worktree はサイドバーに残る／消したいなら Visibility トグル」と
先に約束しているので、利用者向けの導線も既にある。

### 6.5 テスト

| ファイル | 固定していること |
|---|---|
| `tests/unit/lib/startup-excluded-repository-purge.test.ts` | **`server.ts` の実 `initializeWorktrees()` を走らせる**。`WORKTREE_REPOS` 由来の無効化リポジトリについて、再起動 1 回でも 3 回でも worktree 行・`chat_messages`・`tasks`・`verification_runs` が 1 行も減らないこと / `cleanupMultipleWorktrees`・`killWorktreeSession`・tmux の `killSession` に届かないこと / `[excluded] <path>` の監査ログが出続けること / 無効化パスが scan に渡らないこと / 起動が `enabled` を戻さないこと / DB 登録のみの経路も無傷なこと / **実際に消えた worktree の prune は従来どおり効くこと** |

既存の `tests/unit/lib/server-startup-exclusion-filter.test.ts` は同じ primitives を
テスト側で手組みしており、**purge ループがそのすぐ下にあっても緑のままだった**。
新テストが `server.ts` を import して実 `initializeWorktrees()` を叩くのはこのためで、
stub しているのはプロセス境界（Next / HTTP サーバ / tmux トランスポート /
`await import()` される 4 つの fail-open reconciler）だけである。

### 6.6 変異注入（テストが空振りでないことの確認）

| 変異 | 結果 |
|---|---|
| M1: `server.ts` を `git show HEAD:server.ts` で丸ごと戻す（purge ループ + import を忠実に復元） | **RED**（8 件中 3 件） |
| M2: `[excluded]` の監査ログを落とす | **RED**（1 件） |
| M3: `scanMultipleRepositories(filteredPaths)` を `allPaths` に戻す | **RED**（1 件） |
| M4: `syncWorktreesToDB` の per-repo prune を無効化 | **RED**（1 件） |

M1 は import ごと復元しないと `ReferenceError` が `initializeWorktrees()` の
try/catch に飲まれて行が残り、**偽の GREEN** になる。忠実な revert で当てること。

### 6.7 ゲート実測

`npm run lint` / `npx tsc --noEmit` / `npm run test:unit`（762 files, 13921 tests）/
`npm run test:integration`（72 files, 1067 tests）すべて exit 0。
