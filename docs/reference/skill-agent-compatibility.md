# Skill Agent 互換 matrix（実測 evidence）

CommandMate が Skill を install したあと、その Skill を **どの Agent が発見し、どう呼び出せるか** の実測記録。

manifest の `compatibility.agents` は **提供元の申告**であり、本ページの matrix は **CommandMate 側の実測**である。両者は別物として扱い、UI では併記する。実装は `src/lib/skills/compatibility-matrix.ts`（データ本体）と `src/lib/skills/compatibility.ts` の `reconcileAgentSupport()`（申告と実測の突き合わせ）。

---

## 1. install root 集合（前提）

`commandmate skill install` は #1460 以降、payload を **2 つの root へ byte-identical に配置**する（定数 `SKILL_INSTALL_ROOT_PREFIXES`）。

| root | 定数 | 位置づけ |
|------|------|---------|
| `.agents/skills/<id>/` | `SKILL_INSTALL_ROOT_PREFIX` | primary。atomic rename の commit point、receipt の `install_root` |
| `.claude/skills/<id>/` | `SKILL_CLAUDE_INSTALL_ROOT_PREFIX` | secondary。primary から前方収束させる |

receipt の `install_roots` に両方が記録される。`install_roots` を持たない旧 receipt は単一 root として読む後方互換がある（`src/lib/skills/installed-state.ts`）。

---

## 2. 実測 matrix

**発見（discovery）と呼出（slash command 露出）は別軸**として記録する。Codex CLI 0.145.0 は前者のみ成立するため、単一の native / unsupported 値では表現できない。

| Agent | 実測 version | 読み取る root | 発見 | 呼出（slash palette） | 証跡の性質 | 計測日 |
|-------|-------------|--------------|------|---------------------|-----------|-------|
| Claude Code | `2.1.220` | `.claude/skills` のみ | ✅ 確認済み | ✅ 確認済み | 機械的（palette 完全一致・`(project)` scope 表示） | 2026-07-26 |
| Codex CLI | `0.145.0` | `.agents/skills` | ✅ 確認済み | ❌ 露出しない | 発見は self-report / 呼出は機械的 | 2026-07-26 |
| Gemini | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |
| OpenCode | `1.18.22` | `.agents/skills` と `.claude/skills`（project / global の両方） | ✅ 確認済み | ✅ 確認済み（ただし opencode 自身の palette には出ない） | 機械的（`GET /skill` が絶対 path を返し、`/<name>` 送信で Skill 本文が読み込まれ probe token が返る） | 2026-08-25 |
| Vibe Local | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |
| Copilot | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |
| Antigravity | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |
| Command Code | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |

計測環境（Claude / Codex 行）: 専用 port・専用 DB・skills 未導入の新規 git repository / CommandMate 0.15.0 / macOS 26.5.2 / Node v24.1.0。
証跡: <https://github.com/Kewton/CommandMate/issues/1513#issuecomment-5083878264>

計測環境（OpenCode 行, Issue #2037）: 同じ形の隔離 — 専用 port（4903 / 4904）・skills 未導入の新規 git repository・**`HOME` ごと差し替えた scratchpad**。手順は `docs/design/opencode-server-live-verification.md` §4、生の測定結果は同 §12。model は config で固定し、TUI の model picker は一度も開いていない。

### 読み取り方

- **Claude Code は `.agents/skills` を読まない。** 公式 catalog の旧エントリは evidence として「Standard SKILL.md discovery from `.agents/skills`」を挙げて `claude: native` と宣言していたが、**結論は正しく根拠が誤り**である。実際には #1460 が `.claude/skills` にも配置することで成立している。
- **Codex が palette に出ないのは配置先の問題ではない。** 対照実験で `/mo` → `/model` はマッチし、`~/.codex/skills` の既存 skill もマッチしないことを確認済み。当該 CLI version の制約である。
- **Antigravity の「未計測」は CommandMate の palette 挙動と別物。** CommandMate の slash loader は `.agents/skills` のエントリを antigravity session にも供給する（#1504）が、これは CommandMate がコマンドを注入しているのであって Agent 自身が Skill を発見しているわけではない。native discovery の evidence にはならない。
- **OpenCode の行は「公式 docs にそう書いてあるから」ではない。** Issue #2037 は「実測すれば `native` になる可能性が高い」と書いていたが、根拠にしたのは実測だけである。候補 root ごとに 1 個ずつ、固有 token を返すよう指示した probe Skill を 6 個植え、`GET /skill` が 6 個すべてを**絶対 `SKILL.md` path つきで**返すことを確認した（project の `.opencode/skills` / `.claude/skills` / `.agents/skills`、global の `~/.config/opencode/skills` / `~/.claude/skills` / `~/.agents/skills`）。呼出軸は `/probe-agents-root` を送って Skill 本文が読み込まれ `PROBE_OK_probe-agents-root` が返ることで確認し、`.claude/skills` 側でも同じ結果を得た。
- **OpenCode は「呼べるが palette には出ない」。** `/probe-agents-root` を composer に打ち込むと補完は **`No matching items`** になる（陽性対照 `/status` は自分の行にマッチし、陰性対照 `/zzzznotacommand` は何にもマッチしない）。opencode 自身の slash palette は `source: "command"` の行だけを載せるためで、Skill への入口は `/skills` picker しかない。**CommandMate の palette が `.agents/skills` / `.claude/skills` のエントリを opencode session にも供給する理由がこれである**（#1504 と同型、Issue #2037）。
- **OpenCode に送る trigger は末尾の空白まで含めて 1 つ。** `POST /tui/append-prompt` に裸の `/name` を渡すと補完 dropdown が開き、開いている間は `POST /tui/submit-prompt` が `true` を返して**何も送信しない**。空白を 1 つ足すと dropdown が閉じて Skill が走る。`MessageInput` は元から `` `${trigger} ` `` を入れるため palette 経路は安全。
- **未計測は `unsupported` ではない。** 「動かないと確認した」ではなく「確認していない」であり、UI では `unknown` と skip 理由を表示する。

---

## 3. 申告と実測の突き合わせ

`reconcileAgentSupport()` は提供元の申告を実測で **下方向にのみ**制限する。

| 状況 | 表示される support | verification |
|------|------------------|-------------|
| 申告 = 実測 | 申告どおり | `CONFIRMED` |
| 実測 < 申告 | **実測の値**（申告は併記） | `RESTRICTED` |
| 実測 > 申告 | 申告どおり（実測を併記） | `STALE_DECLARATION` |
| 実測なし | 申告どおり | `UNVERIFIED` |

上方向に引き上げないのは、package が何を対応と主張するかを決めるのは提供元だからである。実測のほうが強い場合は「申告が追いついていない」と表示するにとどめる。

support 値の強さ順は `unsupported` < `unknown` < `commandmate_runtime` < `native`。`unknown` が `unsupported` より強いのは、「判定できなかった」が「動かないと確認した」より余地を残すため。

支援値そのものは discovery 軸だけで決まる。Codex のように呼出軸が `unsupported` でも support は `native` のまま、呼出の制約は **known limitation** として併記する。palette に出ないことは「動かない」ではないため。

---

## 4. evidence の陳腐化

実測には計測日を記録し、`SKILL_EVIDENCE_MAX_AGE_DAYS`（180 日）を超えたものは UI で経過日数つきに警告表示する。未計測の Agent は「陳腐化」ではなく `unknown` のままとする（失効する実測が存在しないため）。

---

## 5. reload 手順

| Agent | 手順 |
|-------|------|
| Claude Code | 当該 repository で新しいセッションを開始する。Skill はセッション開始時に走査される |
| Codex CLI | 新しいセッションを開始したうえで、Skill を**名前で指定**して呼び出す（slash command には出ない） |
| OpenCode | 新しいセッションを開始する。server は起動時に一度だけ command / Skill を走査して cache するため、install 直後の Skill は**再起動するまで出ない**（実測）。呼び出しは `/<name>`（CommandMate の palette、または opencode 自身の `/skills` picker から） |
| 未計測の Agent | 実測していない。セッション再起動が安全な前提 |

---

## 6. 再計測の運用

自動 sweep は `tests/integration/skills-agent-discovery-probe.test.ts` にある。既定では skip され、`CM_SKILL_DISCOVERY_PROBE=1` を付けたときのみ実行する。

```bash
CM_SKILL_DISCOVERY_PROBE=1 npx vitest run tests/integration/skills-agent-discovery-probe.test.ts
```

このプローブが行うのは **`<cli> --version` による version 差分の検出のみ**で、Agent の対話 TUI は操作しない。TUI へ入力する自動計測は、無関係な global 設定を書き換える事故を起こした実績があるためテスト経路では行わない。palette 露出の再計測は隔離環境での手動作業とし、結果は本ページと `compatibility-matrix.ts` を同時に更新する。

CLI が未導入の場合、プローブは失敗ではなく `unknown` と skip 理由を記録する。

---

## 7. 関連

- `docs/user-guide/skills.md` — 利用者向けの導入手順
- `docs/design/agent-skills-distribution.md` — 配布方式の ADR（D-8: Agent 互換性は 4 値 + 根拠）
- `tests/unit/lib/skills/compatibility-matrix.test.ts` — matrix の不変条件
- `tests/unit/lib/skills/agent-discovery-regression.test.ts` — matrix と CommandMate slash loader の整合
