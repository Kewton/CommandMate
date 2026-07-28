# Agent Skills MVP — 受入検証レポート（Issue #1242）

**対象**: Phase 1（#1228〜#1237）
**判定日**: 2026-07-20（第1回）／**2026-07-29（第2回・現行）**
**Go/No-Go**: **自動検証分は Go。残る保留は初見参加者 UX 調査（§3-1）のみ。**

本レポートは Issue #1242 の受入条件を「2a: 自動検証」と「2b: 人手検証」に分けて記録する。
第1回（2026-07-20）は 2a のみを実施し、2b は 3 件すべて未実施だった。第2回（2026-07-29）は、
その後にマージされた #1431 / #1440 / #1460 と 2026-07-26 の discovery 実測を踏まえ、
2b のうち 2 件を解消・降格した。**依然として、代理の自動テストで人手検証を合格扱いにはしていない。**

---

## 1. 結論

| 区分 | 状態 | 根拠 |
|---|---|---|
| 2a 自動検証 | **Go** | 第1回の 114 test に加え、実ブラウザ e2e 20 test を追加（§2）。既存回帰なし（§4） |
| 2b-1 初見参加者 UX 調査 | **保留（未実施）** | 被験者を要するため自動化不能。阻害要因だった UI 導線欠如は #1431 で解消済み → **実施可能になった** |
| 2b-2 実機ブラウザ UAT | **自動化により充足** | `tests/e2e/skills-*.spec.ts` が desktop / 390px mobile の両方で files・scripts・permissions・risk・target・diff の視認と承認ゲートを固定（§3-2） |
| 2b-3 実 Agent CLI discovery | **実測済み（2026-07-26）** | Claude Code 2.1.220 / Codex CLI 0.145.0 を実測。継続的な matrix 化は #1246（§3-3） |

**総合判定は「§3-1 を残して Go」である。** 自動検証が Go であることは「機械が確認できる範囲で
fail closed であり、承認 UI が意図どおり描画・ゲートされている」ことを意味し、
「初見の利用者が支援なしで導入できる」ことは意味しない。後者の判断材料は §3-1 でしか得られない。

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
| `tests/e2e/skills-catalog.spec.ts` + `skills-install.spec.ts`（第2回追加） | 20 pass | ✅ |
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

## 3. 人手検証（2b）の現況

第1回で 3 件すべて未実施だったもののうち、2 件は第2回で解消・降格した。
**残る 1 件についてエージェントによる代理実施は行っていない。**

### 3-1. 初見参加者による導入 UX 調査 — **未実施（実施可能になった）**

- **受入条件**: 初見参加者の 80% 以上が無支援かつ 10 分以内に公式 Skill 1 件を install でき、
  失敗理由が記録されること（UX-01）
- **状態**: **未実施**
- **実施者**: プロダクトオーナー／UX 担当（CommandMate 開発チーム外の被験者を 5 名以上募集）
- **実施方法**:
  1. 被験者に CommandMate 稼働環境と worktree を1つ用意する
  2. 「公式 Catalog から任意の Skill を1つ、この worktree に導入してください」とだけ伝える
  3. 無支援で観察し、所要時間・成功可否・誤操作・詰まった箇所・断念理由を記録する
  4. 成功率・中央値所要時間・失敗理由の分類を集計する
- **第1回の阻害要因（解消済み）**: 「UI に install 導線が無い」を理由に実施を保留していたが、
  **#1431 で導線が接続され、#1440 で worktree の導入済み一覧も加わった**。ブラウザだけで
  target 選択 → preview → 承認 → install → uninstall が完結するため、調査対象を CLI に
  限定する必要はなくなった。CLI 経路だけは依然 `--version` 必須（既知制約 3-6）なので、
  被験者には UI 経路を使わせること。

### 3-2. 実機ブラウザでの mobile / desktop UAT — **自動化により充足**

- **受入条件**: 利用者が対象・効果・risk・差分を理解して導入できること（UX-05 / UX-07 / UX-09）
- **状態**: **自動 e2e で充足**（第2回）
- **根拠**: `tests/e2e/skills-catalog.spec.ts` / `tests/e2e/skills-install.spec.ts` が実ブラウザ
  （Chromium、desktop と 390px mobile viewport）で以下を固定した。
  1. target（repository / branch）と **install root 両方**が承認前に提示される
  2. permissions・requirements・scripts・risk・per-file diff・stats が preview に出る
  3. high-risk は承諾チェックまで apply request が **ブラウザから出ない**（request log で negative 検証）
  4. blocker つき plan は「何も書かれていない＋何が阻んでいるか」として描画される
  5. Catalog 取得失敗が空 Catalog に退化しない／stale が stale として出る
  6. mobile 390px で承認ボタンが column 内に収まり click できる、横スクロールが発生しない
- **残る限界**: 実行 engine は Chromium のみ（Mobile Safari project は #1180 で削除済み）。
  **実 iOS Safari / Android Chrome での確認は行っていない**。engine 固有の描画差を疑う場合は
  実機確認が要る。ただし「情報が表示されるか・ゲートが効くか」は engine 非依存であり、
  第1回で未確認だった部分はここで埋まっている。

### 3-3. 実 Agent CLI での native discovery 実測 — **実測済み（2026-07-26）**

- **受入条件**: native discovery の実測と、他 Agent が unsupported / runtime として
  誤表示されないことの検証
- **状態**: **実測済み**。継続的な matrix 化と reload guidance の検証は #1246 の責務。
- **実測結果（2026-07-26、#1513 G4）**:

  | Agent | version | discovery root | slash command 露出 |
  |---|---|---|---|
  | Claude Code | 2.1.220 | `.claude/skills` から発見（`.agents/skills` は読まない） | ✅ palette に出る |
  | Codex CLI | 0.145.0 | `.agents/skills` から発見 | ❌ 露出しない（CLI 側の制約） |
  | Gemini / OpenCode / vibe-local | — | **未計測** | 未計測 |

- **誤表示しないことの担保**: 未計測 Agent は `unknown` のまま扱う。
  `tests/unit/lib/skills/compatibility.test.ts` が「manifest が言及しない Agent の view を
  生成しない」ことを、`tests/e2e/skills-catalog.spec.ts` が「gemini / opencode / vibe-local の
  badge が page 上に 1 つも無い」ことを固定している（変異注入で非空振りを確認済み）。
- **install 側の担保**: #1460 以降 install は両 root へ byte-identical に配置し、
  `skills-mvp-install-flow.test.ts` が `loadAgentsSkills()` と `loadSkills()` の双方から
  同じ Skill が見えることを検証している。実 Agent CLI が実際に提示・実行することまでは
  自動テストの担保外である（manifest の `native` は提供元の申告のまま）。

---

## 4. 品質ゲート

第2回（2026-07-29）の実測。いずれも終了コードを直接取得しており、pipe で隠していない。

| チェック | 第1回（2026-07-20） | 第2回（2026-07-29） |
|---|---|---|
| `npm run lint` | ✅ | ✅ exit 0 |
| `npx tsc --noEmit` | ✅ | ✅ exit 0 |
| `npm run test:unit` | ✅ 11023 pass | ✅ exit 0 / 11582 pass |
| `npm run test:integration` | ✅ 926 pass / 1 skip | ✅ exit 0 / 994 pass / 1 skip |
| `npm run build` | ✅ | ✅ exit 0 |
| `npx playwright test tests/e2e/skills-*.spec.ts` | — | ✅ exit 0 / 20 pass |

e2e は `playwright.config.ts` の隔離構成（port 3177・専用 DB・空の非 git scan root）で実行した。
本番サーバ（port 3000）と本番 DB には接触していない。

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

第2回（2026-07-29）に判明したもの。いずれも **docs 側が実装に追随していなかった**ケースで、
実装は正しく動いていた。

| # | 内容 | 対応 |
|---|---|---|
| 9 | `docs/user-guide/skills.md` が install 先を単一 root（`.agents/skills`）として記述したままだった。#1460 以降、install は `SKILL_INSTALL_ROOT_PREFIXES` の **両 root** へ byte-identical に配置する | support matrix・変更範囲・§4 rollback 手順をすべて両 root へ訂正 |
| 10 | 同 §4-2 の手動 rollback が `.agents/skills/<id>` しか消さない手順だった。**そのとおり実行すると `.claude/skills/<id>` が残り、Claude Code から Skill が見え続けたまま再 install が 409 で拒否される** | 両 root を消す手順へ訂正。`install_roots` で正確な一覧を確認する旨を追記 |
| 11 | support matrix が UI 導線を「未接続」、導入済み一覧を「未提供」としていたが、#1431 / #1440 で解消済みだった（§3-1 の記述と自己矛盾していた） | matrix と既知制約 3-1 / 3-2 を実態へ訂正 |

---

## 6. 参照

- 利用者向け support matrix・既知制約・rollback 手順: [docs/user-guide/skills.md](../user-guide/skills.md)
- 設計判断と脅威モデル: [docs/design/agent-skills-distribution.md](../design/agent-skills-distribution.md)
- module 責務: [docs/module-reference.md](../module-reference.md)
