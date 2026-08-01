# Skill 同期対応表（CommandMate ↔ commandmate-skills）

CommandMate と [`Kewton/commandmate-skills`](https://github.com/Kewton/commandmate-skills) は
同じスクリプトの実体を 2 箇所に持っている。その対応関係は
[`.claude/skills/sync-map.json`](../.claude/skills/sync-map.json) に宣言され、
[`tests/unit/skills/sync-map.test.ts`](../tests/unit/skills/sync-map.test.ts) が
`npm run test:unit` で検知する（Issue #1612）。

---

## 1. なぜ要るか

片方だけ直して気づかない状態が**実際に 2 回起きている**。

| | 経緯 |
|---|---|
| cmate-verify | #1586 が byte-identical に移植 → #1607 が CommandMate 側だけ修正 → 4 日間ドリフト → #1611 で同期 |
| cmate-orchestrate-monitor | skills 側が #1602 で先行 → CommandMate 側が取り残される → #1613 で同期 |

どちらも「たまたま気づいた」のであって、仕組みが鳴ったわけではない。

CommandMate 内の `.claude/skills` ↔ `.agents/skills` は
`cmate-verify/dual-placement.test.ts` / `demo-video/mirror.test.ts` /
`video-to-gif/mirror.test.ts` が無差分を固定している。
**リポジトリを跨いだ側だけが素通しだった。**

---

## 2. 3 分類

Issue #1612 の本文は `identical` / `adapted`（= 検知対象から外す）の 2 分類を提案していたが、
**この 2 分類では #1613 と同じドリフトが再発する**。実測すると:

- `cmate-verify/scripts/**` は skills 側と**バイト一致**（`diff -r` 無差分）
- `orchestrate-monitor/scripts/**` は**バイト一致ではない**。コメント中の Issue 番号が
  リポジトリごとに違う（CommandMate #1581/#1601 ↔ skills #1589/#1602）。
  しかし**コメントを除いたコード差分は 8 ファイルすべて 0 行**で、
  機能変更は必ず両側へ移植しなければならない

つまり orchestrate-monitor は「バイト一致でない」が「検知対象から外してはいけない」。
`adapted` として除外すると、まさに #1613 で起きた無検知が再現する。
そこで `adapted` を 2 つに割り、**3 分類**にした。

| 分類 | 意味 | 編集したら | 検知 |
|------|------|-----------|------|
| `byte-identical` | counterpart とバイト一致が必須。移植は逐語コピー | 同じバイト列を counterpart へコピーし pin 更新 | sha256 pin |
| `port-required` | 挙動の移植は必須だが**バイト一致は要求しない**（Issue 番号・URL・文書構成が意図的に相違） | counterpart を「同じ挙動になるよう」書き直して pin 更新。逐語コピーは適応を壊すので不可 | sha256 pin |
| `local-only` | counterpart が存在しない CommandMate 専用 | 何もしなくてよい | 検知しない |

**バイト一致を要求しないことと、検知対象から外すことは別である。** これが 3 分類の要点。

### 現在の割り当て

| パス | 分類 | counterpart |
|------|------|-------------|
| `.claude/skills/cmate-verify/scripts/**`（28 ファイル） | `byte-identical` | `skills/cmate-verify/scripts/**` |
| `.claude/skills/cmate-verify/SKILL.md` | `port-required` | `skills/cmate-verify/SKILL.md` |
| `.claude/skills/orchestrate-monitor/**`（9 ファイル） | `port-required` | `skills/cmate-orchestrate-monitor/**` |
| `demo-video` / `video-to-gif` / `rebuild` / `release` / `release-post` | `local-only` | — |

`.md` のみのパッケージ（`cmate-orchestrate` など）を対応表に入れなかった根拠は
`sync-map.json` の `notMapped` に実測値つきで書いてある（要約: 同名の `.claude/commands/*.md`
とは共通する非空行が数百行中 1〜2 行しかなく、コピー関係にない。入れると鳴っても
誰も移植しないゲートになる）。

---

## 3. 使い方

### 赤くなったとき

テストは移植先の具体的なパスと、赤を消す 2 通りを出す。

```
.claude/skills/orchestrate-monitor/scripts/monitor.sh drifted from the last cross-repo sync.
  policy   : port-required
  port to  : Kewton/commandmate-skills :: skills/cmate-orchestrate-monitor/scripts/monitor.sh
  pinned   : ffce8e14...
  actual   : 96da1078...
Clear this deliberately, one of two ways:
  1) port it — ... then re-pin: node scripts/skills-sync-map.mjs update
  2) if the counterpart is gone, change this file's policy in .claude/skills/sync-map.json
     (or move the package to local-only) and write the reason there.
```

**pin を更新するだけで済ませない。** pin の更新は「移植した」または「分類を変えた」の
どちらかを済ませた後の記録である。

### コマンド

```bash
# pin と working tree の突き合わせ（テストと同じ比較を shell から）
node scripts/skills-sync-map.mjs check

# 移植後に pin を更新する
node scripts/skills-sync-map.mjs update

# counterpart の checkout があるとき、実 diff を取る（逆向きのドリフトはここでしか見えない）
node scripts/skills-sync-map.mjs check --counterpart ../commandmate-skills
```

`update` は対応表に無いファイルを見つけると `REVIEW:` note つきで追加する。
`REVIEW:` が残っている限りテストは赤のままなので、分類は必ず人が決めることになる。

---

## 4. 意図的な制約

- **ネットワーク・submodule・cross-repo トークンを一切使わない。**
  skills は個人リポジトリで、GitHub Actions を ruleset の bypass actor に指定できず、
  release の承認者は maintainer 本人である（[docs/user-guide/skills.md](./user-guide/skills.md) §3-9）。
  CI から書ける token を増やさないため、CI は counterpart を checkout しない。
- **検知できるのは CommandMate 側の編集だけ。**
  skills 側が先に進んだ場合（#1613 がまさにその向き）は pin が変わらないので鳴らない。
  逆向きは `--counterpart` を手元の checkout に向けて実行して見る。
  CI から見るには cross-repo token が要るため、Issue #1612 の受入条件と衝突する。
- **`.claude/skills` ↔ `.agents/skills` は見ない。**
  既存の dual-placement / mirror テストの担当で、役割を重複させない。
  代わりに「`.agents/skills` の各ディレクトリには `.claude/skills` の同名がある」だけを
  固定し、分類の網羅性が抜けないようにしている。

---

## 5. 対応表そのものが腐らないようにしてある

`sync-map.json` は次を満たさないとテストが赤くなる。

- `.claude/skills/` 直下の全ディレクトリが**ちょうど 1 回**分類されている（新規 skill を
  足したら分類を書くまで赤）
- 対応のあるパッケージは配下の**全ファイル**を列挙している（ファイルを足したら赤）
- 列挙したパスが実在する（実在しないパスを書いたら赤）
- `local-only` には理由が、対応のあるパッケージには根拠が書かれている
- `REVIEW:` note が残っていない

---

## 関連

- [`.claude/skills/sync-map.json`](../.claude/skills/sync-map.json) — 対応表本体
- [`tests/unit/skills/sync-map.test.ts`](../tests/unit/skills/sync-map.test.ts) — 検知ゲート
- [`scripts/skills-sync-map.mjs`](../scripts/skills-sync-map.mjs) — pin 更新 / 実 diff
- [docs/user-guide/skills.md](./user-guide/skills.md) — Skill 配布・install の仕様
