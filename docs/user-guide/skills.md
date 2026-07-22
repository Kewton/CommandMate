# Agent Skills 配布（Phase 1 / MVP）

CommandMate は公式 Catalog から Agent Skill を取得し、選んだ worktree の
`.agents/skills/<skill-id>/` へ導入・削除する。本ドキュメントは **Phase 1（MVP）時点**の
support matrix・既知制約・rollback 手順を扱う。

設計判断そのものは [docs/design/agent-skills-distribution.md](../design/agent-skills-distribution.md)、
module 単位の責務は [docs/module-reference.md](../module-reference.md) を参照。

---

## 1. 何が起きるのか

| 段階 | 実行主体 | 内容 |
|---|---|---|
| Catalog 取得 | server | 固定 endpoint の Catalog を検証して cache する |
| download | server | Catalog 宣言の SHA-256 / size と完全一致した artifact だけを受理する |
| 検査 | server | archive を展開せずに全 entry を解析し、manifest と双方向照合する |
| plan | server | live branch / HEAD と配置予定 file を固定した期限つき plan を発行する |
| install | server | staging へ書いてから atomic rename で `.agents/skills/<id>/` へ commit する |
| Agent 認識 | Agent CLI | 各 Agent が起動時に `.agents/skills/` を読む（**セッション再起動が必要**） |

**download / install / uninstall のいずれも、package 内の script や hook を実行しない。**
`declared_permissions` は提供元の *申告* であって CommandMate による enforcement ではない。

---

## 2. Support matrix（Phase 1 時点）

### 2-1. 操作経路

| 操作 | Web UI | CLI (`commandmate skill`) | 備考 |
|---|---|---|---|
| Catalog 一覧・検索 | ✅ `/skills` | ✅ `list` | |
| 詳細・risk・互換性表示 | ✅ `/skills/[id]` | ✅ `info` | |
| Install Plan の preview | ⚠️ 導線未接続（§3-1） | ✅ `plan` / `install --dry-run` | |
| install | ⚠️ 導線未接続（§3-1） | ✅ `install` | **CLI は `--version` 必須**（§3-6） |
| uninstall | ⚠️ 導線未接続（§3-1） | ✅ `uninstall` | |
| 導入済み一覧 | ❌ 未提供 | ❌ 未提供（`status` は単体照会） | #1248 待ち（§3-2） |
| update / rollback | ❌ 未提供 | ❌ 未提供 | Phase 2（#1243 / #1244） |

### 2-2. Agent 対応状況

| Agent | manifest の宣言 | CommandMate による実測検証 |
|---|---|---|
| claude | `native`（根拠は「`.agents/skills` からの標準 SKILL.md discovery」という一般論） | **未実施**（#1246） |
| codex | `native`（同上） | **未実施**（#1246） |
| 上記以外 | 宣言なし = `unknown` | — |

`native` は **提供元の申告**であり、CommandMate が version ごとに動作確認した結果ではない。
UI（`SkillDetailView`）は Agent 対応 badge の直下に「提供元による申告であり CommandMate は
検証していない」旨の注記と `evidence` 原文を常時表示しており、宣言を「検証済み」として
提示してはいない。実測は #1246 の責務。

自動テストが担保しているのは **`.agents/skills/<id>/SKILL.md` が discovery 経路
（`loadAgentsSkills()`）から見えること**までであり、実 Agent CLI が実際にその Skill を
提示・実行することは担保していない。

### 2-3. 変更範囲の保証

| 範囲 | 保証 |
|---|---|
| 対象 worktree 内 | `.agents/skills/<skill-id>/` 配下のみ。payload file と `.commandmate-receipt.json` 以外は作らない |
| 対象 worktree 内（tracked file） | 一切変更しない（`git diff HEAD` は空） |
| worktree 外 | service-owned state root のみ（`<config>/skills/{locks,journal,package-staging}`、`<config>/data/skill-snapshots`） |
| permission | state root と snapshot root は `0700`、snapshot file は `0400` |

---

## 3. MVP 既知制約

### 3-1.（解消済み #1431）install / uninstall の UI 導線

> **#1431 で解消**: `SkillTargetSelector` は `SkillDetailView` → `SkillInstallPanel` 経由で
> production にマウントされ、ブラウザから target 選択 → plan → preview → 確認 → install /
> uninstall ができる。high-risk Skill は確認チェックボックス未チェックの間 request を送出しない。

component test（fetch モック、実 route と同一の request/response 型）で happy path・blockers・
high-risk 確認・typed error 表示分岐を固定している。**実 Catalog fetch と実 download を伴う
ブラウザ実機 UAT は未実施**（サンドボックスで安定再現できないため。#1242 の人手検証 3-1 の対象）。

### 3-2. 導入済み Skill を一覧する読み取り API が無い

`listSkillInstallations()` は実装済みだが公開 route が無い。`commandmate skill status <id>` は
worktree 単位の一覧ではなく **単体照会** であり、内部的に uninstall plan を1件生成するため
**plan token を1つ消費する副作用**がある。一覧 API は #1248。

### 3-3. 再インストール・update の手段が無い

destination が既に存在する場合、apply は `SKILL_INSTALL_DESTINATION_EXISTS`（409）で拒否する。
**同一 version の入れ直しも、別 version への更新もできない。** 一度 uninstall してから
install し直す必要がある。update は Phase 2（#1243 / #1244）。

なお plan 段階では「managed かつ無変更」の tree は差分ゼロとして `installable: true` に見える。
拒否は commit 直前の destination 再確認で起きる。

### 3-4. plan token を利用者個人に紐付けられない

CommandMate の認証は共有 token 単一で per-user identity を持たない。plan token の binding は
**channel の区別（cookie=`user` / bearer=`cli`）と `id: null`** までであり、
「誰が preview したか」は記録できない。UI が発行した token を CLI が提示した場合は
`SKILL_PLAN_BINDING_MISMATCH`（409）で拒否される。

### 3-5. uninstall は空になった `.agents/skills/` を回収しない

uninstall は receipt が導出した directory だけを `rmdir(2)` で回収する。したがって
`.agents/skills/<id>/` は消えるが、**`.agents/skills/` と `.agents/` は空のまま残る**。
利用者や他ツールが作った directory を巻き込まないための意図的な挙動である。

### 3-6. CLI の `install` は `--version` が必須

`commandmate skill install <id> --worktree <id>` だけでは exit 2 で拒否され、
`--version <exact>` の明示が要る（API / UI は Catalog の推奨 version へ既定で解決する）。
導入する version を CLI 利用者に必ず意識させるための設計。

### 3-7.（解消済み #1429）検証済み snapshot の TTL 回収

> **#1429 で解消**: `plan-sweeper` が両 plan cache と snapshot store を 60 秒ごと（および
> plan token アクセス時）に sweep するようになった。放置された plan token が pin していた
> snapshot も、TTL 経過後は refcount 0 に戻り自動 evict される。

download した artifact の検証済み snapshot は、再試行で再 download しないよう
`<config>/data/skill-snapshots` に **TTL 30 分の cache** として残る（`0700` / `0400`）。
以前は「次の plan 作成時」しか回収経路が無く放置 token が snapshot をプロセス終了まで
pin していたが、現在は低頻度 timer（`unref()` 済み）で自動回収される。

### 3-8.（解消済み #1428）起動時 reconciliation

> **#1428 で解消**: `server.ts` が migration 完了後に `runSkillStartupReconciliation()` を
> 実行する。`committed_reconciling` で終わった操作は起動時に receipt から SUCCEEDED へ収束し、
> owner 確認済み orphan lock も解放される。手動確認（§4-3）は通常不要になった。

reconciliation は fail-open（起動を止めない）で、operation journal は retention（7日）で
自動的に刈られる。§4-3 の手動手順は、起動を跨がずに即時確認したい場合の参考として残す。

### 3-9. 公式 Skill repository の release 承認者は maintainer 本人

`Kewton/commandmate-skills` は個人リポジトリのため、GitHub Actions を ruleset の bypass actor に
指定できない。main branch の protection は force push / 削除の禁止までで、
release environment の承認者は maintainer 本人である。

---

## 4. Rollback 手順

### 4-1. 通常の取り消し（install が成功した場合）

```bash
commandmate skill uninstall <skill-id> --worktree <worktree-id> --yes
```

uninstall は receipt の全 file digest を照合し、**1件でも modified / unknown / missing /
unmanaged / irregular があれば何も削除せず停止する**（zero-delete fail closed）。
このため「手で編集した Skill が黙って消える」ことはない。

局所的に編集してしまった場合は、編集を戻してから uninstall するか、§4-2 の手動削除を行う。

### 4-2. 手動での取り消し

CommandMate を経由せずに戻す場合は、対象 worktree で以下を消す。
**worktree 外の CommandMate 内部 state は消さなくてよい**（journal は append-only の記録、
lock と snapshot は自然に回収される）。

```bash
rm -rf <worktree>/.agents/skills/<skill-id>
```

この場合 DB の `skill_installations` に行が残る。次に同じ Skill を install すると
destination が無いため成功し、行は upsert で更新される。

### 4-3. `committed_reconciling` で終わった場合

payload の rename は完了しているが index / audit の書き込みに失敗した状態。
**worktree の中身は正しく配置済み**である。

1. `.agents/skills/<skill-id>/.commandmate-receipt.json` が存在することを確認する。
2. 存在すれば install は物理的に完了している。`skill_installations` の行だけが欠けている。
3. 取り消したい場合は §4-2 の手動削除を行う。
4. 保持したい場合は現状のままで Agent からは利用できる（index の欠落は §3-2 の一覧機能にのみ影響）。

CommandMate は commit 後の失敗を rollback と偽らない。「変更なし」と報告されるのは
rename 前に失敗した場合だけである。

### 4-4. 残留物の掃除

正常系・異常系いずれでも以下は残らない。残っていた場合は異常であり、安全に削除してよい。

| path | 意味 |
|---|---|
| `<worktree>/.agents/skills/.commandmate-staging/` | install 途中の staging |
| `<config>/skills/locks/*.lock` | 操作中の排他 lock |
| `<config>/skills/package-staging/` | package 検査用 staging |

`<config>` は global install で `~/.commandmate`。

### 4-5. worktree を削除・再作成した後に導入済み Skill が見えない場合

**#1430 適用（migration v46）以降は自動的に発生しなくなった。** v46 で
`skill_installations` は `ON DELETE CASCADE` により worktree に追従するため、worktree を
削除するとその install 行も消え、同一 path への再作成後は「未導入」から正しく install できる。

v46 適用より前に発生した宙吊り（worktree 削除で新 UUID になり、disk に receipt が残るのに
DB 上は「未導入」で再 install も `SKILL_INSTALL_DESTINATION_EXISTS` で拒否される状態）は、
v46 の migration が既存の dangling 行を一掃するため起動時に自動解消される。なお手動で戻す
場合は対象 worktree の `.agents/skills/<skill-id>/` を削除してから再 install すればよい。

---

## 5. 自動検証の範囲

Phase 1 の MVP gate として、以下が CI で毎回実行される（すべて**ネットワーク非依存**）。

| suite | 内容 |
|---|---|
| `tests/integration/skills-mvp-install-flow.test.ts` | 3 Skill の Catalog→install→receipt→discovery→uninstall、変更範囲の allowlist、残留物 0、UI/CLI の同一 route 経由での一致 |
| `tests/integration/skills-mvp-security-regression.test.ts` | 悪性 archive corpus 59 件、unmanaged / local change / drift / plan expiry / 単回性 / 同時 install / high-risk 未承諾 |
| `tests/integration/skills-mvp-source-integrity.test.ts` | allowlist、redirect 毎再検証、content-type、size 上限、checksum、offline / stale Catalog |

実 Catalog・実 release を叩く検証は opt-in で、`CM_SKILLS_E2E_REAL_CATALOG=1` を設定した時だけ
実行される。未設定時は skip 理由つきで skip される。

人手でしか確認できない項目（初見利用者の UX 調査、実機ブラウザ UAT、実 Agent CLI での
discovery 実測）は自動化されていない。実施状況は
[docs/qa/skills-mvp-uat-report.md](../qa/skills-mvp-uat-report.md) を参照。
