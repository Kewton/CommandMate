# CHANGELOGエントリテンプレート

リリースで `CHANGELOG.md` に入るエントリの形式です。エントリは各 Issue の PR が **断片（`changelog.d/<N>.md`）** としてコミットし、リリース時に `node scripts/changelog-fragments.mjs apply` が 1 つのバージョンセクションにまとめます（Issue #2641）。

- `CHANGELOG.md` の `## [Unreleased]` には**直接書かない**（`tests/unit/scripts/changelog-fragments.test.ts` のガードで落ちる。空でないと `apply` も止まる）
- 断片の形式の正本は [`changelog.d/README.md`](../../../../changelog.d/README.md)。書式は `node scripts/changelog-fragments.mjs check` で検証する

## 断片の形式（`changelog.d/<N>.md`）

```markdown
<!-- ### Fixed -->
- **fix(scope): 要点** (#1234): 補足説明
```

- **1 行目**: 入る節の名前をコメントで書く（`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security` / `Performance` / `Refactored` / `Documentation`）
- **2 行目**: エントリを 1 行で書く（折らない）。`- **<type>(<scope>): <要点>** (#<N>): <補足説明>`
  - `<type>` は `feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore` / `ci` のいずれか（`(<scope>)` は省略可）
  - `<N>` はファイル名の番号と同じ。1 Issue につき 1 ファイル・1 エントリ
- **3 行目以降**: 空行だけ

## バージョンセクションの形式（`apply` の出力）

`apply --version <X.Y.Z> --date <YYYY-MM-DD>` が `## [Unreleased]` の直後に挿入します。**Highlight だけは `apply` の後に手で書き足します**。

```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

> **Highlight**: このリリースの中心を2〜4文で。何が問題で、何を変えたか。**実測値があれば必ず入れる**。

### Added

- **feat(scope): 要点** (#1236): 補足説明

### Changed

- **fix(docs): 要点** (#1235): 補足説明

### Fixed

- **fix(cli): 要点** (#1234): 補足説明

- **fix(ui): 要点** (#1230): 補足説明
```

- 日付は **JST 基準**（`--date "$(TZ=Asia/Tokyo date +%F)"`）
- 節の順は `Added` → `Changed` → `Deprecated` → `Removed` → `Fixed` → `Security` → `Performance` → `Refactored` → `Documentation`。断片の無い節は**出ない**
- 節の中は Issue 番号の**降順**。各カテゴリ見出しの後とエントリの間は**空行を1行**
- `node scripts/changelog-fragments.mjs preview` で、`apply` の前に同じ節（Highlight を除く）を確認できる

## セクション

| セクション | 内容 | 使用実績 |
|---|---|---|
| **Added** | 新機能 | 頻繁 |
| **Changed** | 既存機能の変更 | 頻繁 |
| **Fixed** | バグ修正 | 頻繁 |
| **Security** | セキュリティ関連の修正 | 6回 |
| **Removed** | 削除された機能 | 3回 |
| **Deprecated** | 将来削除予定の機能 | 1回 |

`Performance` / `Refactored` / `Documentation` も断片の節名として使えます（`changelog.d/README.md`）。

## 記載ルール

1. **conventional prefix を付ける**: `feat(scope):` / `fix(scope):` / `chore(scope):` / `docs:` / `refactor(scope):` 等。上の 8 語以外は `check` が不合格にする
2. **Issue 番号は `(#1234)` 形式で、要点の `**` を閉じた直後に置く**: `(Issue #1234)` は v0.9.1 以前の旧表記。**新規では使わない**。要点の `**` の中に入れると `check` が不合格にする
3. **要点を `**太字**` で**: `**<type>(<scope>): <要点>**` で結論を先に置き、詳細は `(#N): ` の後ろに続ける
4. **ユーザー視点＋根拠**: 「何が起きていたか」「何がどう変わるか」を書く。実測値・計測結果があれば入れる
5. **BREAKING CHANGE の明示**: 破壊的変更は補足説明の先頭に `**BREAKING**:` を付ける（2 行目の先頭は `- **<type>` でなければならないため）

## 比較リンクは追加しない

ファイル末尾の比較リンク（`[X.Y.Z]: https://github.com/.../compare/...`）は **`0.5.2` で止まっており、以降のリリースでは付けていません**。新規リリースでも**追加しないでください**（既存の古いリンクはそのまま残す）。`apply` も比較リンクは書きません。

## 例

### 良い例（実際の v0.33.1 より）

```markdown
<!-- ### Fixed -->
- **fix(ui): Enterで確定するテキスト入力7箇所でIME変換確定のEnterが未変換のまま確定してしまう問題を修正** (#2428): エージェント別名・新規ファイル名・リポジトリ表示名・ファイル/メモ/ログ検索の各入力で、`TodoPane` と同じ `!e.nativeEvent.isComposing` ガードを確定処理に追加し、変換候補を確定するEnterでは保存・ファイル作成・検索実行が走らないようにした（変換確定後のEnterは従来どおり確定する）。
```

要点が太字、prefix あり、`(#2428)` が要点の直後、**何が起きていてどう変わるか**が書いてある。ファイル名は `changelog.d/2428.md`。

### 悪い例

```markdown
<!-- ### Added -->
- release skill added                          <!-- prefix・太字・(#N) が無い。check が不合格にする -->

<!-- ### Fixed -->
- fix(cli): **バグを修正**。詳細 (#31)            <!-- 旧形式。2 行目が `- **` で始まらないので check が不合格にする -->
- **fix(cli): バグを修正 (Issue #31)**: 詳細      <!-- 旧 Issue 表記を要点の中に入れている。check が不合格にする -->
```

悪い例の 2 つ目・3 つ目は 1 ファイルに 2 エントリ書いている点でも不合格です（3 行目以降は空行だけ）。

## Highlight の書き方

リリース全体の要約です。GitHub Release ノートにもそのまま転記されるため、**そのリリースを一言で説明する文**にします。`apply` は Highlight を書かないので、生成された節の見出しの直後に手で書き足します。

実例（v0.10.1）:

> **Highlight**: **`npx` 導線の実効性を回復するパッチリリース**。v0.10.0 で新設したランディングページと README が案内していた `npx commandmate` は、**グローバル導入済みの環境では既存の binary を実行しレジストリを一切参照しない**ため、利用者が気づかないまま旧版を使い続けていた（実測: 最新 0.10.0 に対し 0.3.5 が実行された）。全案内を `npx commandmate@latest` に統一した。…

- 中心テーマを冒頭に置く
- **問題 → 変更**の順で書く
- DB マイグレーションがあれば必ず記載（`CURRENT_SCHEMA_VERSION` の遷移も）
