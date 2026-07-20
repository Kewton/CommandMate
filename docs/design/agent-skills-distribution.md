# ADR: Agent Skills 配布契約と脅威モデル

- **Issue**: [#1228](https://github.com/Kewton/CommandMate/issues/1228)（親Epic [#1227](https://github.com/Kewton/CommandMate/issues/1227) / Phase 1 Wave 1）
- **ステータス**: Accepted
- **対象 schema_version**: 1
- **実装**: `src/types/skills.ts` / `src/lib/skills/*` / `tests/fixtures/skills/contract/`

本ADRは Skill の manifest・Catalog・artifact・installed receipt・脅威モデルの契約を確定する。
後続 Issue（#1229 Catalog取得 / #1231 install / #1232 UI / #1234 audit）は、本ADRと
`@/lib/skills` の公開APIだけを前提に実装する。**本Issueの範囲は契約・Schema・fixture・ADRであり、
取得・download・install・UI・Runtime は実装しない。**

---

## 1. 前提の検証結果（着手時の実コード調査）

Issue 記載の前提を実コードで確認した結果は以下のとおり。

| Issue の記載 | 実コード | 判定 |
|---|---|---|
| `src/lib/slash-commands.ts` は `.agents/skills` を検出し、取得情報は主に name / description / cliTools | `AGENTS_SKILLS_SUBDIR = .agents/skills`（同ファイル）。`parseSkillFile()` が name / description / model / cliTools を取得 | 正しい |
| 公式Skill供給リポジトリと配布artifactの規約は存在しない | 該当コードなし | 正しい |
| `Kewton/commandmate-skills` は未作成 | — | 正しい。**本Issueでは実在を前提とした検証・network accessを一切実装しない**（fixture 内のURLはすべて例示） |
| 互換性判定に SemVer 2.0 を用いる | `src/lib/version-checker.ts` の `isNewerVersion()` は `major.minor.patch` のみを数値比較し、`v` prefix を許容し、prerelease を無視する | **要訂正**。CommandMate自身のrelease tag比較としては正しいが SemVer 2.0 ではない。Skill契約は prerelease precedence を必要とするため `src/lib/skills/semver.ts` に厳格実装を分離し、`version-checker.ts` は変更しない |
| path検証は `src/lib/security/path-validator.ts` を利用しうる | `isPathSafe()` / `validateWorktreePath()` は実在。ただし `WORKTREE_ID_PATTERN` は大文字を許容し、Skill ID の lowercase slug 規約とは別物 | 併存。**filesystem を伴う実path検証は #1231 が `path-validator.ts` を使う。本Issueは文字列レベルのpayload path検証のみを提供する** |
| Schema検証ライブラリの利用 | `zod` / `ajv` / `js-yaml` / `semver` はいずれも直接依存に存在しない（`js-yaml` は `gray-matter` の推移依存） | **新規runtime依存を追加せず**、手書きの total な validator で実装する |

---

## 2. 責務境界

| 層 | 責務 | 非責務 |
|---|---|---|
| Skill package | 標準手順（SKILL.md）と宣言metadata（commandmate.skill.yaml）を持つ | CommandMate内部moduleへの直接依存 |
| CommandMate本体 | source検証、worktree解決、互換性判定、transaction、receipt/audit、Runtime監督 | — |
| CLI | 公開APIの薄いclient。UIと同じ plan/apply・validation・audit 経路を使う | 独自の検証経路 |
| UI | 能力・効果・risk・差分の説明と、選択・確認の受付 | filesystem path や security 判定の信頼 |

`SKILL.md` は Agent Skills 標準の authoring artifact、`commandmate.skill.yaml` は CommandMate の
配布・Runtime 宣言である。両者は同じ Skill root に置き、責務を分離する。

---

## 3. 決定表

### D-1: manifest は SKILL.md と分離した別ファイルにする

`SKILL.md` frontmatter を拡張せず、同一 Skill root の `commandmate.skill.yaml` に配布metadataを置く。
標準側の互換性を壊さず、標準Agentは追加fieldを無視できる。

### D-2: schema_version は fail closed

`schema_version` は `1` 固定。欠落・型不一致・`2` 以上のいずれも
`SKILL_SCHEMA_VERSION_UNSUPPORTED` で拒否し、best-effort parse は行わない。
未知fieldも `SKILL_UNKNOWN_FIELD` で拒否する（schema_version 1 は閉じた集合）。

### D-3: Skill ID は lowercase ASCII slug

- 文法: `^[a-z0-9]+(?:-[a-z0-9]+)*$`、最大64文字。
- 予約: `commandmate`, `system`, Windows device 名（`con`, `prn`, `aux`, `nul`, `com1..9`, `lpt1..9`）。
- dot始まり・大文字・`_`・連続ハイフン・非ASCIIは文法段階で排除されるため、homoglyph 混入は成立しない。
- case/Unicode衝突は `foldSkillIdForCollision()`（NFKC + toLowerCase）で検出する。
  大文字小文字を区別しないfilesystemや正規化するfilesystem上での上書きを防ぐ。
- ディレクトリ名 / `SKILL.md` の `name` / manifest の `id`・`name` の一致を
  `validateSkillIdentityConsistency()` で必須化する。利用者がレビューしていない名前での
  install を成立させないための条件である。

### D-4: version と range

- version は厳格 SemVer 2.0（`v` prefix 不可、leading zero 不可、build metadata は precedence 無視）。
- range 文法は空白区切りの **AND のみ**。`=`, `>`, `>=`, `<`, `<=`, `^`, `~` を受理し、
  `||`・`*`・x-range・hyphen range は拒否する。rangeの解釈を一意にするための制限である。
- prerelease は、同一 `major.minor.patch` かつ prerelease を持つ comparator が存在する場合のみ満たす。
  この規則がないと `>=1.0.0` が `2.0.0-alpha.1` を暗黙に受理する。

### D-5: artifact 形式

| 項目 | 値 |
|---|---|
| 形式 | `tar.gz`（PAX拡張不使用） |
| asset名 | `<skill-id>-<version>.tar.gz` |
| Content-Type | `application/gzip`（download時は `application/octet-stream` も受理。GitHub release asset の実配信がこれを返すため） |
| archive root | 次の3形のみ受理: **root省略**（entry が archive 直下）/ `<skill-id>/` / `<skill-id>-<version>/` |
| 必須entry | root除去後の相対pathで `SKILL.md`, `commandmate.skill.yaml` |
| 最大サイズ | 16 MiB（単一payload fileは 4 MiB、file数は最大500） |

archive root は「1ディレクトリ必須」ではない。`resolveRootName()`（`package-reader.ts`）は
top-level segment が1つに定まりかつ入れ子を持つ場合にのみ root prefix とみなし、その名前が
`<skill-id>` / `<skill-id>-<version>` のいずれでもなければ `SKILL_PACKAGE_LAYOUT_INVALID` で拒否する。
top-level segment が複数ある archive は root 省略形として prefix を剥がさずに受理する。
これにより「Catalog が名指ししていない名前で install される」ことは防ぎつつ、
tar の作り方の差異（`tar -czf x.tar.gz -C dir .` と `tar -czf x.tar.gz dir`）を許容する。

### D-6: digest の対象と正本

- **artifact全体の SHA-256 は Catalog が持つ**。manifest 自身を含む byte 列を対象にするため、
  manifest 内に自己digestを置くと自己参照になる。したがって manifest は自己digestを持たない。
- **manifest.files は個別payload fileのdigest**を持つ。照合集合は
  「archive内のregular payload file」から `commandmate.skill.yaml` 自身と directory entry を除いた集合。
  この規則は `validateManifestFileSet()` が実装し、宣言漏れ・未宣言fileの混入をどちらも拒否する。
- digest はすべて lowercase hex SHA-256（`^[0-9a-f]{64}$`）。大文字は拒否し、byte比較を一意にする。
- canonicalization: digest対象は「解凍後のfile byte列そのもの」であり、改行変換・正規化・
  trailing whitespace 除去などの前処理は一切行わない。

### D-7: source の正本は resolved commit SHA

`source.ref`（tag / branch）は人向けの表示にすぎず、後から移動しうる。
Catalog と receipt は 40桁の resolved commit SHA を必須とし、短縮SHAは拒否する。

### D-8: Agent互換性は4値 + 根拠

`native` / `commandmate_runtime` / `unsupported` / `unknown` と `evidence` を必須にする。
`unknown` を「対応」と表示してはならない。UI/CLI は `AGENT_SUPPORT_LABEL_KEYS` の
同一語彙を使う（UX-05）。

### D-9: 権限宣言は enforcement ではない

field名は `declared_permissions`、risk は `declared_risk`。`declared` を落とした命名を禁じる。
UI は `PERMISSION_DECLARATION_NOTICE_KEY` の注記を必ず併記し、
「宣言であって隔離・認可ではない」ことを明示する。sandbox enforcement は本Epicの範囲外。

### D-10: risk は宣言と算出を分離し、実効riskは高い方

- `declared_risk`: publisher の申告。
- `computed_risk`: CommandMate が検査結果から `computeSkillRisk()` で決定論的に算出。
  - `high`: executable file を含む、または `credential_access` を宣言。
  - `moderate`: script file を含む、network host を持つ、`process_execution` または
    `filesystem_write` を宣言。
  - `low`: 上記以外。
- `effective_risk = max(declared, computed)`。低く申告して緩和することはできない。

### D-11: receipt は決定的

machine absolute path・actor・timestamp を含めない。同じ version を同じ commit から入れれば
byte 一致する（`canonicalizeSkillReceipt()` はキーsort・空白なしのJSON、`files` は path 昇順）。
時刻と actor は #1234 の operation audit に保存する。
receipt の `artifact` は **`url` を持たない**。download URL は signed URL でありうるため secret として扱う。
`install_root` は常に repository相対の `.agents/skills/<skill-id>`。

### D-12: 配備先と data root

- Skill payload の配備先は、server登録済み worktree ID から解決した
  `.agents/skills/<validated-skill-id>/` に限定する。client提供の絶対pathは使用しない。
- 検査staging・lock・journal・cache・verified backup は service-owned data/config root に置き、
  Skill payload や Agent discovery の対象にしない。
- 例外は atomic rename 用の install commit staging のみで、
  `.agents/skills/.commandmate-staging/<opaque-operation-id>/` に置く。
  同一filesystemを保証して rename を atomic にするためであり、
  先頭 dot により Skill ID 文法から外れるため discovery 対象にならない。

### D-13: safe YAML parse profile

manifest の YAML parser は `SKILL_YAML_SAFE_PROFILE` を満たすこと（実装は #1229/#1231 が選定）。

- alias / anchor / merge key / custom tag / duplicate key を拒否。
- `__proto__` / `constructor` / `prototype` を key として拒否。
- 上限: 64 KiB、document depth 16、node 数 5000、scalar 8192 文字。

`src/lib/skills/schema.ts` は parse 済みの `unknown` を受け取る純関数であり、
YAML parser には依存しない。parse と検証の責務を分けることで、parser 差し替えが契約に波及しない。

### D-14: file mode 規約

- 許可するのは regular file と directory のみ。symlink・hardlink・device・FIFO・socket は拒否。
- 実行bitは manifest で `executable: true` を宣言した file のみ許可する。
- uid / gid / xattr / setuid / setgid / sticky は継承しない。

### D-15: 表示項目の正本（#1232）

| 表示項目 | 正本 |
|---|---|
| 能力（何ができるようになるか） | manifest `capabilities` |
| 期待効果 | manifest `expected_outcomes` |
| provider / license | manifest `provider` / `license` |
| version / changelog | Catalog `versions[].version` / `changelog` |
| resolved SHA / artifact情報 | Catalog `versions[].source.commit` / `artifact` |
| scripts / executable / computed risk | 検査結果（`SkillPackageInspection` → `computeSkillRisk()`） |
| 実際に入ったfile | receipt `files` |

`capabilities` と `expected_outcomes` は空配列を許可しない。install 前に
「何ができるようになるか」を説明できない Skill を成立させないためである（UX-01 / UX-09）。

### D-16: 完全一致条件（Catalog → artifact → manifest → inventory → receipt）

1. Catalog `artifact.sha256` = download した artifact の SHA-256。
2. Catalog `artifact.asset_name` = `<skill-id>-<version>.tar.gz`、`content_type` = `application/gzip`。
3. archive root directory を持つ場合、その名前は `<skill-id>` または `<skill-id>-<version>`。
   Catalog `id` = manifest `id` = install 先ディレクトリ名（root 省略形では archive 直下が Skill root）。
4. manifest `version` = Catalog `versions[].version`。
5. manifest `files` = archive の payload file 集合（`commandmate.skill.yaml` と directory を除く）。
6. receipt `files` = 実際に配置した file の path/digest/size/executable、path 昇順。
7. receipt `source.commit` = Catalog `versions[].source.commit`。

いずれか1つでも不一致なら install を中止する（fail closed）。

---

## 4. 脅威モデル

| # | 脅威 | 契約上の対策 |
|---|---|---|
| T-1 | malicious archive（zip-slip、巨大展開、大量entry） | payload path検証（D-6, 3節）、size/file数上限（D-5）、root 名は `<skill-id>` / `<skill-id>-<version>` に限定（D-5） |
| T-2 | path / symlink escape | `..`・絶対path・NUL・制御文字・backslash・drive path・trailing slash・非NFC・深さ超過を拒否。symlink は file mode 規約で拒否（D-14）。realpath検証は #1231 |
| T-3 | case / Unicode collision による既存Skill上書き | `foldSkillIdForCollision()` による衝突検出（D-3） |
| T-4 | supply-chain改ざん（tag付け替え、artifact差し替え） | resolved commit SHA 必須（D-7）、artifact SHA-256 必須（D-6）、完全一致条件（D-16） |
| T-5 | prompt injection（SKILL.md本文による指示の乗っ取り） | 契約上は risk / permissions / scripts を install 前に提示し、download/install/update 単体では script も hook も自動実行しないことを規定する。本文自体の無害化は範囲外であり Runtime 側（#1250）の課題とする |
| T-6 | secret exfiltration | `credential_access` 宣言は `computed_risk = high`。receipt/log に token・signed URL・secret・machine absolute path を含めない（D-11） |
| T-7 | TOCTOU（検査後の差し替え） | 検査は service-owned staging 上で行い、commit は同一filesystem内 atomic rename（D-12）。plan と apply の間で plan drift を再検証する |
| T-8 | 同時操作の競合 | 同一 target への操作は排他する（#1231 が lock を data root に置く） |
| T-9 | prototype pollution（`__proto__` を含む manifest） | YAML safe profile で key を拒否（D-13）、validator も unknown field として拒否し、返す値は検証済みfieldから再構築する |
| T-10 | 既存fileや local change の暗黙上書き | download/install/update は既存fileを暗黙に上書きしない。差分を提示して確認を得る |
| T-11 | 権限宣言の誤認 | 命名と注記で宣言と enforcement を区別する（D-9） |

---

## 5. 公開API

後続Issueは `@/lib/skills` からのみ import する。

```ts
import {
  // 定数・規約
  SKILL_SCHEMA_VERSION, SKILL_ID_PATTERN, SKILL_INSTALL_ROOT_PREFIX,
  SKILL_MANIFEST_FILENAME, SKILL_MD_FILENAME, SKILL_STAGING_DIRNAME,
  SKILL_ARTIFACT_FORMAT, SKILL_ARTIFACT_CONTENT_TYPE, SKILL_YAML_SAFE_PROFILE,
  REQUIRED_PACKAGE_ENTRIES, buildSkillAssetName,
  PERMISSION_DECLARATION_NOTICE_KEY, AGENT_SUPPORT_LABEL_KEYS,

  // エラー
  SkillContractErrorCode, type SkillContractError, type SkillValidationResult,

  // SemVer
  isValidSemVer, compareSemVer, satisfiesSkillVersionRange,

  // 検証
  validateSkillManifest, validateSkillCatalog, validateSkillInstallReceipt,
  validateSkillId, validateSkillIdentityConsistency, validateSkillPayloadPath,
  validateManifestFileSet, detectSkillIdCollision,
  computeSkillRisk, resolveEffectiveSkillRisk, canonicalizeSkillReceipt,

  // 公開 JSON Schema
  SKILL_MANIFEST_JSON_SCHEMA, SKILL_CATALOG_JSON_SCHEMA, SKILL_RECEIPT_JSON_SCHEMA,
} from '@/lib/skills';
```

検証関数は例外を投げず `SkillValidationResult<T>` を返す。成功時の `value` は
検証済みfieldから再構築した新しいobjectであり、入力の未検証propertyは残らない。

---

## 6. manifest 例

```yaml
schema_version: 1
id: release-notes
name: release-notes
version: 1.2.0
summary: Draft release notes from merged pull requests.
description: >-
  Collects merged pull requests since the previous tag, groups them by change
  type and drafts a Keep a Changelog entry for review.
capabilities:
  - Group merged pull requests by conventional commit type
  - Draft a Keep a Changelog entry for the next release
expected_outcomes:
  - Release note drafting drops from ~30 minutes to a single review pass
  - Changelog entries stay consistent across releases
provider:
  name: CommandMate
  url: https://github.com/Kewton/CommandMate
license: MIT
compatibility:
  commandmate: '>=0.11.0 <1.0.0'
  agents:
    - agent: claude
      support: native
      evidence: SKILL.md discovery verified on claude CLI 2.x
    - agent: gemini
      support: unknown
      evidence: Not verified for this release
requirements:
  commands:
    - name: git
      version_range: '>=2.30.0'
  network_hosts: []
declared_permissions:
  - filesystem_read
declared_risk: low
risk_rationale: Reads repository history only and writes no files.
files:
  - path: SKILL.md
    sha256: <64 hex>
    size: 2048
    kind: skill_md
    executable: false
    script: false
```

---

## 7. fixture

`tests/fixtures/skills/contract/{manifest,catalog,receipt}/{valid,invalid}/`。
invalid fixture は自己記述的な envelope である。

```json
{
  "case": "A future schema_version is rejected instead of best-effort parsed",
  "expectedErrorCode": "SKILL_SCHEMA_VERSION_UNSUPPORTED",
  "expectedPath": "/schema_version",
  "document": { "...": "..." }
}
```

`tests/unit/lib/skills/schema.test.ts` が全fixtureを走査し、拒否理由のcodeと位置の
両方を検証する。fixture を追加すればテストは自動的に増える。

---

## 8. 将来拡張

`schema_version: 2` で signature block・publisher identity・外部Registryを追加しうる。
その際も D-2 の fail closed は維持し、旧版CommandMateが新版manifestを
誤って部分解釈しないようにする。追加時は本ADRに後方互換方針を追記する。
