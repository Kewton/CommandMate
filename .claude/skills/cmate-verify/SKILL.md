---
name: cmate-verify
description: リポジトリの検証ゲート（lint / typecheck / test / build 等）を .commandmate/verify.yaml に宣言し、worktree の cwd で逐次実行して exit code で合否を判定する。verify.yaml が無いリポジトリでは CI 定義から起案する。作業完了を主張する前の検証や、並列ワーカーの完了判定に使う。
allowed-tools: Bash(.claude/skills/cmate-verify/scripts/*), Bash(.agents/skills/cmate-verify/scripts/*), Bash(git worktree list), Read, Write, Glob, Grep
---

# cmate-verify

「このリポジトリで何が通れば合格か」を `.commandmate/verify.yaml` に宣言し、
**実 exit code で** 判定するランナー。CommandMate の検証ゲート機能（Phase 1 以降）の
設定形式 v1 を、製品実装より先に実地検証するための先行 Skill である。

正準仕様は CommandMate リポジトリの [`docs/design/verification-config.md`](../../../docs/design/verification-config.md)。
Phase 1 の製品ローダは同じ仕様を一般的な YAML パーサで実装するので、この Skill で書いた
verify.yaml はそのまま引き継げる。

> **なぜ exit code か**: `cmd | grep ...` は `$?` を grep に渡して非ゼロ終了を隠す。vitest は
> 全テスト緑でも Unhandled Rejection で exit 1 を出しうるので、出力を grep した要約は
> それを PASS と報告してしまう。ゲートは必ず `sh -c "$cmd" > log 2>&1` で走らせ `$?` を直接読む。

## 構成

```
cmate-verify/
├── SKILL.md
└── scripts/
    ├── verify-run.sh        # ゲート実行ランナー（bash 3.2 互換）
    └── tests/
        ├── run-tests.sh     # fixture ベーステスト（bash + git だけで動く）
        └── fixtures/*.yaml
```

`scripts/tests/run-tests.sh` は vitest に依存しない。Node の無い導入先でも
`bash scripts/tests/run-tests.sh` だけで検証できる（CommandMate 本体では
`tests/unit/skills/cmate-verify/` の薄いラッパが `npm run test:unit` から同じ suite を回す）。

## 手順 1: init（`.commandmate/verify.yaml` が無い場合）

**コードを書かず、リポジトリをスキャンしてゲートを起案し、ユーザーの確認を得てから書き出す。**
検出優先順位は次のとおり。上位が見つかったら下位は補助として扱う。

1. **`.github/workflows/*.yml` の CI ジョブ** — そのリポジトリにおける「何が通れば合格か」の
   既存の定義。`run:` の各ステップが第一候補。
2. **`package.json` の `scripts`** — `lint` / `test` / `test:unit` / `typecheck` / `build` 系。
3. **`Makefile` のターゲット** — `make lint` / `make test` 等。
4. **言語マニフェスト** — `Cargo.toml`（`cargo clippy` / `cargo test`）、`pyproject.toml`
   （`ruff` / `pytest` / `mypy`）、`go.mod`（`go vet` / `go test ./...`）等。

起案時の注意:

- 実行時間の長いゲートには `timeoutSec` を明示する（既定は 600 秒）。
- ゲートの並び順がそのまま実行順になる。速いゲートを先に置くと失敗が早く読める
  （途中で失敗しても残りは実行されるので、順序は打ち切りではなく可読性のための選択）。
- **デプロイ・publish・リリース・外形変更を伴うコマンドはゲートにしない。** ゲートは
  何度でも安全に再実行できるものに限る。
- 起案結果は「どこから拾ったか」（CI ジョブ名 / npm script 名）とセットで提示し、
  **ユーザーの確認を得てから** `.commandmate/verify.yaml` を書き出す。

書き出したら、その場で 1 回実行して `RESULT passed` になることまで確認する。

## 手順 2: run（verify.yaml がある場合）

```bash
.claude/skills/cmate-verify/scripts/verify-run.sh --cwd <worktree-path>
```

主なオプション:

| オプション | 意味 |
|---|---|
| `--config <path>` | 既定は `<cwd>/.commandmate/verify.yaml` |
| `--cwd <path>` | ゲートを実行する worktree。既定はカレントディレクトリ |
| `--base-ref <ref>` | work-evidence の基準。`options.baseRef` より優先 |
| `--gates id1,id2` | 一部のゲートだけ実行する。存在しない id は設定エラー |
| `--skip-work-evidence` | 未着手ガードを飛ばす |

出力は stdout に 1 ゲート 1 行、最終行が判定:

```
GATE work-evidence PASS commits=3 uncommitted=2
GATE lint PASS exit=0 duration=12s
GATE unit FAIL exit=1 duration=45s
RESULT failed
```

失敗ゲートのログ末尾は **stderr** に出る（stdout をパース可能に保つため）。

| RESULT | exit code | 意味 |
|---|---|---|
| `passed` | 0 | 実行した全ゲートが PASS |
| — | 2 | 設定エラー（verify.yaml 不正 / ファイル無し / git でない cwd 等） |
| `failed` | 20 | 1 つ以上のゲートが FAIL または TIMEOUT |
| `not_started` | 21 | work-evidence が「作業の痕跡ゼロ」と判定（コマンド系ゲートは走らない） |
| `skipped` | 22 | 実行したコマンド系ゲートが 0 件（メイン checkout での skip） |

**`skipped` を `passed` と読まないこと。** 何も検証していない状態であり、緑ではない。

## verify.yaml の書き方

```yaml
# .commandmate/verify.yaml — v1
version: 1
gates:
  - id: lint
    command: "npm run lint"
    timeoutSec: 600
  - id: typecheck
    command: "npx tsc --noEmit"
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 1800
options:
  baseRef: origin/develop
  skipInPrimaryCheckout: true
  maxLogTailBytes: 8192
```

このランナーは awk / sed で読むため、**YAML のサブセットしか受け付けない**:

- インデントは 2 スペース固定（タブは不可）
- 値は 1 行スカラーのみ。アンカー / エイリアス（`&` `*`）・複数行文字列（`|` `>`）・
  フロースタイル（`[...]` `{...}`）は拒否する
- 行内コメントは無し。`#` で始まる行のみコメント
- `key:` の**最初のコロン**で分割するので、値の中のコロンはそのまま書ける

**制約に反する verify.yaml は「best-effort で解釈」せず exit 2 で拒否する。**
黙って一部を読み飛ばすと「設定したつもりのゲートが走っていないのに passed」になるため。
Phase 1 の製品ローダは一般的な YAML パーサを使うが、この形式で書いておけば両方で読める。

各フィールドの型・既定値・範囲は `docs/design/verification-config.md` の仕様表が正準。

## 組み込みゲート work-evidence

コマンド系ゲートより先に、**そもそも作業が行われたか**を判定する。

- PASS 条件: `merge-base(baseRef, HEAD)..HEAD` のコミット数 > 0 **または**
  `git status --porcelain` が非空
- 両方 0 なら `RESULT not_started` (exit 21)。コマンド系ゲートは 1 つも実行しない

未起動のセッションを「全ゲート PASS」と誤報告しないためのガードである
（変更ゼロのリポジトリでは lint も typecheck も当然通る）。

## メイン checkout での skip

`options.skipInPrimaryCheckout`（既定 `true`）が有効なとき、**プライマリ checkout では
コマンド系ゲートを実行しない**。プライマリ checkout は稼働中サーバの cwd になっている
ことがあり、その足元で build / test を回すと動いている画面を壊す。判定は
`git rev-parse --git-dir` と `--git-common-dir` が同じ実パスを指すかで行う。

検証は linked worktree で回すこと。

## テスト

```bash
bash .claude/skills/cmate-verify/scripts/tests/run-tests.sh
# ... ok - / not ok - の行が並び、最後に
# tests: 123 passed, 0 failed
```

fixture は `scripts/tests/fixtures/*.yaml`。カバーしているのは
全 PASS / 1 ゲート FAIL / timeout / work-evidence の not_started / 設定ファイル無し
の 5 ケースに加えて、対になる反証ケース（同じ設定が linked worktree では実行される、
`--skip-work-evidence` を付ければ同じ clean repo でも実行される）と、18 種の設定エラー、
アサーションヘルパ自身の自己検査。

判定が空振りしていないことは変異注入で確認してある（`set -m` の除去 → orphan 検出が赤 /
失敗時の打ち切り → 継続実行の assert が赤 / work-evidence の OR を AND に → 33 件赤 /
全 skip を passed と報告 → skip 判定が赤 / プライマリ判定の無効化 → 6 件赤）。
`MIN_ASSERTIONS` はケースが黙って落ちたときに 0 failed で緑にならないための下限である。
