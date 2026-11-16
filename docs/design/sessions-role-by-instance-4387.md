# /sessions 用: instance ごとのロールをまとめて返す（Issue #4387）

## 目的

`/sessions` の絞り込み（#4386 / #4389）がロールで絞れるよう、サーバー上の全 worktree・全 instance のロールを 1 回の読み取りで返す。worktree ごとの `GET /api/worktrees/:id/instances/roles`（`buildInstanceRoleSettings`）は設定ファイルの読み込み（`loadComposition`）を含み、一覧から worktree の数だけ呼ぶと遅くなる。

## 値の形

worktree id → instance id → `InstanceRoleSummary`（`src/types/agent-roles.ts`）:

| 値 | 意味 |
|----|------|
| `{ kind: 'role', roleId, roleName, basis: 'launched' }` | 稼働中で、このサーバーが起動した世代（`currentGeneration`）の `launched` 記録がある。起動時のロール |
| `{ kind: 'role', roleId, roleName, basis: 'setting' }` | それ以外。次の起動時のロール（`effectiveNext` と同じ解決） |
| `{ kind: 'none' }` | ロールなし（明示の none、既定なし、対象外のツール、ロールなしで起動した稼働中の instance） |
| `{ kind: 'ambiguous' }` | 引き継ぎ元の root の設定が食い違う（`root-settings-differ` / `membership-undetermined`）。起動は拒否される。`none` と混ぜない |

Issue 本文の形 `{ roleId, roleName, basis } | { kind: 'none' } | { kind: 'ambiguous' }` に `kind: 'role'` を足した（1 つのフィールドで 3 つを見分けられるように。`roleId` の有無でも判別できるので本文の形の上位互換）。

「稼働中で起動時の記録がある」の判定は `buildInstanceRoleSettings` と同じ: 最新の `launched` 記録の `sessionGeneration` が、`getLaunchRoleEvidence` の返す今のプロセスの世代と一致するときだけ `launched`。設定を変えても稼働中の instance は起動時のロールのまま返る。

## 先に実測（目安と結果）

**目安（着手時に決定）**: `/api/worktrees` の `dbMs` の増分が **20ms を超える、または既存の `dbMs` の 2 割を超える**なら、`/api/worktrees` には載せず `/sessions` だけが読む別エンドポイントにする。`/api/worktrees` はサイドバーを含む全クライアントが数秒おきにポーリングしているため。

**計測方法**: test DB（`:memory:` + `runMigrations`）と `os.tmpdir()` の実 git リポジトリ。root 3 つ（本体 + 別リポジトリ 2）、本体の linked worktree を N 個（`git worktree add`）、各 worktree に instance 2 つ（claude / codex）。`GET /api/worktrees?includeStatus=0` の `list:timing` の `dbMs`（変更前のルートのまま）と、`buildRoleByInstance` の所要時間（＝ Phase 1 に入れた場合の `dbMs` の増分）を各 7 回の中央値で比べた。参考に、Issue が挙げる素朴な形（worktree ごとに `withSettledWorktreeMembership` + `resolveDefaultsForTool`）も測った。#2060 の計測（346ms → 39ms）は status を含む実機の値で、DB だけの比較には使えないため、ここで測り直した。

| N（worktree） | 既存 dbMs | 増分: まとめ読み（root 設定なし） | 増分: まとめ読み（root 設定あり） | 参考: worktree ごと（root 設定あり） |
|---|---|---|---|---|
| 30 | 0.5ms | 0.6ms | 53.8ms | 524ms |
| 100 | 1.2〜1.4ms | 1.4ms | 143.9ms | 1863ms |

root にロールの設定があると、どの root にどの worktree が属するかを git（`rev-parse --git-common-dir`）に聞く必要があり、パスごとに 1 回へまとめても N=100 で約 144ms。目安（20ms / 2 割）を大きく超えるため、**別エンドポイント `GET /api/sessions/roles` にした**。`/api/worktrees` は変えていない（変更前後の `dbMs` は同じ）。root 設定が無いときは git を呼ばないので増分は約 1ms だが、それでも既存の 2 割を超える。

## 作り

- `GET /api/sessions/roles` → `{ success: true, roleByWorktree: { [worktreeId]: { [instanceId]: InstanceRoleSummary } } }`（`SessionRolesResponse`）
- `buildRoleByInstance`（`src/lib/agent-roles/role-by-instance.ts`）:
  - root の設定が 1 つも無い（`hasAnyRepositoryRoleDefault` が false）なら git を呼ばない。所属がどうであれ答えが変わらないため
  - ある場合は `withSettledServerMemberships`（`resolve.ts`）で、各 root と各 worktree のパスを 1 回ずつ（同時 8 本まで）git に聞き、全 worktree と root がその間に動いていないことを同期区間で確かめてから組み立てる。1 worktree の `withSettledWorktreeMembership` と同じ所属の答えになる（単体テストで worktree ごとの読み取りと突き合わせ）
  - instance の設定は `getAllInstanceRoleStates`、最新の `launched` 記録は `getAllLatestLaunchedRoles`（ウィンドウ関数）でそれぞれ 1 文。roster は `resolveAgentInstances`
  - 解決は起動と同じ `resolveDefaultsForTool`。継承する instance は（ツール, 所属 root）ごとに 1 回だけ解決して使い回す
  - `loadComposition` は呼ばない（fingerprint は要らない）
- 読めなかったとき（DB の失敗、root が動き続けた `MembershipUnsettledError` など）: 200 で `roleByWorktree: {}` と `rolesUnavailable: true`、`logger.error('roles:read-failed')`。`lastActivityByWorktree` と同じく全体を失敗させない。`rolesUnavailable` は「worktree が無い」と「読めなかった」を読み手が区別して、絞り込みを外せるようにするため

## 並行作業との境界

画面（`src/app/sessions/page.tsx`）と `src/lib/sessions-filter.ts` には触らない（#4386・#4389）。読み手は #4389 で、このエンドポイントを `/sessions` を開いている間だけ読む。
