# Agent Skills MVP — 受入検証レポート（Issue #1242）

**対象**: Phase 1（#1228〜#1237）／**判定日**: 2026-07-20
**Go/No-Go**: **自動検証分は Go。人手検証分は保留（未実施）。**

本レポートは Issue #1242 の受入条件を「2a: 自動検証」と「2b: 人手検証」に分け、
**2a のみ**を実施した結果である。**2b は本レポート作成時点で未実施であり、
代理の自動テストで合格扱いにしていない。**

---

## 1. 結論

| 区分 | 状態 | 根拠 |
|---|---|---|
| 2a 自動検証 | **Go** | 新規 114 test すべて green（§2）。既存回帰なし（§4） |
| 2b 人手検証 | **保留（未実施）** | 実施者・実施方法は §3 に明記。実施までは MVP 出荷可否を判定しない |

**総合判定は「保留」である。** §3 の 3 項目が完了するまで MVP の出荷可否は確定しない。
自動検証が Go であることは「機械が確認できる範囲で fail closed である」ことを意味し、
「利用者が導入できる」ことを意味しない。特に §3-1 は UI 導線が未接続（既知制約 3-1）である
現状では、CLI 経路でしか実施できない点に注意すること。

---

## 2. 実施済み（2a: 自動検証）

すべてネットワーク非依存。本番 DB（`cm.db`）・稼働サーバ（port 3000）・既存 worktree には
一切接触していない。DB は in-memory、worktree は `$HOME/.commandmate-test-skills-mvp/` 配下の
使い捨て git リポジトリ、CommandMate config root も同配下の一時 directory に差し替えている。

### 2-1. 実行結果

| suite | 件数 | 結果 |
|---|---|---|
| `skills-mvp-install-flow.test.ts` | 18 pass / 1 skip（opt-in） | ✅ |
| `skills-mvp-security-regression.test.ts` | 74 pass | ✅ |
| `skills-mvp-source-integrity.test.ts` | 20 pass | ✅ |
| `npm run test:integration`（全体） | 926 pass / 1 skip | ✅ |
| `npm run test:unit`（全体） | 11023 pass | ✅ |

### 2-2. 受入条件との対応

| Issue の受入条件（自動検証） | 結果 | 検証箇所 |
|---|---|---|
| Catalog→install→receipt→uninstall の E2E が 3 Skill で pass | ✅ | install-flow: 「installs all three MVP Skills」「removes every installed byte on uninstall」 |
| 悪性 artifact を fail closed | ✅ | security: 悪性 corpus 59 件すべてが期待 error code で 422、かつ worktree 無変更 |
| stale plan を fail closed | ✅ | security: HEAD drift / branch drift → `SKILL_PLAN_STALE`、期限切れ → `SKILL_PLAN_EXPIRED`、再利用 → `SKILL_PLAN_CONSUMED` |
| unmanaged / local change を fail closed | ✅ | security: unmanaged root、local modification、symlink root |
| 同時操作を fail closed | ✅ | security: 並行 install は 1 件だけ commit、他は 409 |
| 既存 slash command / Skill discovery の regression | ✅ | install-flow: `loadAgentsSkills()` が導入 Skill を検出／`test:unit` 全体 green |
| worktree 内外の変更が allowlist に完全一致 | ✅ | install-flow: 「changes nothing outside .agents/skills/\<id\>」「changes only the enumerated service-owned state root」「git diff HEAD が空」 |
| temporary residue が 0 件 | ✅ | install-flow / security: lock・package staging・worktree staging が全経路で 0。snapshot は TTL cache のため「参照 0（evict 可能）」を検証（既知制約 3-7） |
| production API から Catalog endpoint を任意指定できない | ✅ | install-flow: 完全一致 allowlist、env 再読込でも不変。source-integrity: 非 allowlist host / look-alike host / 別 repository path / http / userinfo をすべて拒否し **connection を開かない** |
| 変更範囲の targeted test が合格 | ✅ | §2-1 |
| `npm run lint` / `npx tsc --noEmit` | ✅ | §4 |
| `npm run test:unit` / 関連 integration test | ✅ | §2-1 |
| `npm run build` | ✅ | §4 |

### 2-3. Catalog fixture が test 専用であることの担保

fixture Catalog は **`vi.mock` による test 内 dependency injection のみ**で注入している。
production 側には endpoint を差し替える経路が無いことを次の 2 点で固定した。

- `src/config/skill-catalog-config.ts` の URL は `as const` の hardcode で、allowlist は
  前方一致ではなく**完全一致**。`SKILL_CATALOG_URL` / `CM_SKILL_CATALOG_URL` /
  `CM_SKILLS_CATALOG` を設定して module を再読込しても値が変わらないことを test で固定。
- API route が受け取る request field（`?prerelease`、path の `id`）は URL 構築に一切使われない。
  plan route は path / URL / checksum / file list を含む request を `SKILL_PLAN_INPUT_REJECTED`
  （400）で明示的に拒否する。

### 2-4. 実 Catalog・実 release に対する検証

`CM_SKILLS_E2E_REAL_CATALOG=1` を設定した時だけ実行される opt-in test として実装した。
**CI 既定では skip される**（skip 理由は describe 名に明記）。

加えて、公開 release の実 redirect chain
（`github.com` → `release-assets.githubusercontent.com`、`application/octet-stream`）を
**fixture として再現した case** を既定 CI に含めている。policy を将来締めすぎて実 release が
落ちるようになれば、ネットワーク無しでこの case が失敗する。

---

## 3. 未実施（2b: 人手検証）— **保留中**

以下は本 Issue の自動化スコープ外である。**エージェントによる代理実施は行っていない。**

### 3-1. 初見参加者による導入 UX 調査

- **受入条件**: 初見参加者の 80% 以上が無支援かつ 10 分以内に公式 Skill 1 件を install でき、
  失敗理由が記録されること（UX-01）
- **状態**: **未実施**
- **実施者**: プロダクトオーナー／UX 担当（CommandMate 開発チーム外の被験者を 5 名以上募集）
- **実施方法**:
  1. 被験者に CommandMate 稼働環境と worktree を1つ用意する
  2. 「公式 Catalog から任意の Skill を1つ、この worktree に導入してください」とだけ伝える
  3. 無支援で観察し、所要時間・成功可否・誤操作・詰まった箇所・断念理由を記録する
  4. 成功率・中央値所要時間・失敗理由の分類を集計する
- **既知の阻害要因**: **UI に install 導線が無い**（既知制約 3-1）。現状 CLI でしか導入できず、
  CLI は `--version` 必須（既知制約 3-6）。この状態で UX 調査を行うと「UI 導線の欠如」が
  支配的な失敗理由になる見込みであり、**#1248 等で UI 導線が接続されてから実施することを推奨する**。

### 3-2. 実機ブラウザでの mobile / desktop UAT

- **受入条件**: 利用者が対象・効果・risk・差分を理解して導入できること（UX-05 / UX-07 / UX-09）
- **状態**: **未実施**
- **実施者**: QA 担当
- **実施方法**:
  1. desktop（Chrome / Safari）と mobile（iOS Safari / Android Chrome）実機で `/skills` と
     `/skills/[id]` を開く
  2. files / scripts / permissions / risk / target / diff の各項目が視認でき、
     high-risk が色以外（label・icon）でも識別できることを確認する
  3. Catalog stale / offline 時の警告表示と理由コードを確認する
  4. 画面ごとにスクリーンショットを証跡として残す
- **備考**: Playwright の既定 project は chromium のみで、Mobile Safari project は
  Issue #1180 で削除済み。mobile は実機確認が必要。

### 3-3. 実 Agent CLI での native discovery 実測

- **受入条件**: Codex native discovery と、他 Agent が unsupported / runtime として
  誤表示されないことの検証
- **状態**: **未実施**（本 Issue のスコープ外。#1246 の責務）
- **実施者**: 開発担当（#1246）
- **実施方法**:
  1. Skill を install した worktree で claude CLI / codex CLI を起動する
  2. 各 CLI の version を記録する（`claude --version` / `codex --version`）
  3. 導入した Skill が候補として提示されるか、実行できるかを version ごとに記録する
  4. 結果を manifest の `compatibility.agents[].evidence` へ反映する
- **現状の担保範囲**: 自動テストは `.agents/skills/<id>/SKILL.md` が CommandMate 内部の
  discovery loader（`loadAgentsSkills()`）から見えることまでしか検証していない。
  manifest の `native` 宣言は**提供元の申告のまま**であり、実測に基づかない（既知制約 §2-2）。

---

## 4. 品質ゲート

| チェック | 結果 |
|---|---|
| `npm run lint` | ✅ |
| `npx tsc --noEmit` | ✅ |
| `npm run test:unit` | ✅ 11023 pass |
| `npm run test:integration` | ✅ 926 pass / 1 skip |
| `npm run build` | ✅ |

---

## 5. 本 Issue で判明した設計文書・前提の誤り

実装を正とし、文書側を修正した。実装を文書に合わせて狭める変更は行っていない。

| # | 内容 | 対応 |
|---|---|---|
| 1 | 設計文書 D-5 が archive root を「`<skill-id>/` の1ディレクトリのみ」と規定していたが、`package-reader` の `resolveRootName()` は **root 省略 / `<skill-id>/` / `<skill-id>-<version>/` の3形**を受理する（既存 unit test でも 2 形が固定済み） | D-5 と脅威モデル T-1 を実装に合わせて修正 |
| 2 | D-5 の Content-Type が `application/gzip` のみと読めたが、download 層は実 release の配信に合わせ `application/octet-stream` も受理する | D-5 に併記 |
| 3 | Issue の前提「UI が `native` 宣言を検証済みとして表示していないか確認」→ **表示していない**。`SkillDetailView` は Agent badge 直下に「提供元の申告であり CommandMate は検証していない」注記と `evidence` 原文を常時表示する | 問題なし。support matrix に明記 |
| 4 | Issue の前提「destination 既存は 409 で拒否」は **plan ではなく apply の挙動**。managed かつ無変更な tree は plan では差分ゼロで `installable: true` に見え、commit 直前の destination 再確認で 409 になる | 既知制約 3-3 に明記し、test も apply 層で固定 |
| 5 | Issue の受入条件「終了時に package snapshot が 0 件」は実装と不整合。検証済み snapshot は **TTL 30 分の cache** として意図的に残る（#1229）。0 件になるのは lock・package staging・worktree staging | 既知制約 3-7 に明記。test は「参照が残らない（refcount 0 で evict 可能）」を検証 |
| 6 | uninstall 後も `.agents/skills/` と `.agents/` は空 directory として残る（receipt が導出した directory しか `rmdir` しないため） | 既知制約 3-5 に明記 |
| 7 | CLI の `install` は `--version` が必須で、省略すると exit 2。API / UI は推奨 version へ既定解決するため **UI と CLI で既定挙動が非対称** | 既知制約 3-6 と support matrix に明記 |
| 8 | `reconcileSkillOperations()` / `releaseOrphanSkillLocks()` は実装済みだが production の起動経路から呼ばれていない | 既知制約 3-8 に明記。rollback 手順 §4-3 で人手 reconcile を案内 |

---

## 6. 参照

- 利用者向け support matrix・既知制約・rollback 手順: [docs/user-guide/skills.md](../user-guide/skills.md)
- 設計判断と脅威モデル: [docs/design/agent-skills-distribution.md](../design/agent-skills-distribution.md)
- module 責務: [docs/module-reference.md](../module-reference.md)
