# CHANGELOG Fragments (`changelog.d/`)

このディレクトリは、Issue ごとの CHANGELOG 断片ファイルを管理するディレクトリです。
複数の並列 PR が `CHANGELOG.md` を直接編集してコンフリクトを起こすのを防ぐため、各 PR はこのディレクトリに断片ファイルを追加します。
リリース時に `scripts/changelog-fragments.mjs apply` が断片ファイルをまとめて `CHANGELOG.md` に反映し、断片ファイルを削除します。

`CHANGELOG.md` の `## [Unreleased]` には直接書かないでください。空であることを `tests/unit/scripts/changelog-fragments.test.ts` のガードが確かめています（空でないと `apply` も失敗します）。節はリリース時に `apply` が書きます。

## 断片ファイルの形式

- **置き場所**: `changelog.d/<Issue番号>.md`（正規表現: `/^\d+\.md$/`、例: `1975.md`）
- 1 Issue につき 1 ファイル、1 エントリのみを記述します。
- Issue の無い変更の場合は、先に Issue を作成してください。
- `changelog.d/README.md` は断片として扱われません（検証・集約・削除の対象外）。

### ファイルの内容

```markdown
<!-- ### <節名> -->
- **<type>(<scope>): <要約>** (#<Issue番号>): <本文>
```

1. **1行目**: 節名を HTML コメントで記述します。
   - 正規表現: `/^<!-- ### (Added|Changed|Deprecated|Removed|Fixed|Security|Performance|Refactored|Documentation) -->$/`
   - 許される節名（9種類）:
     - `Added`
     - `Changed`
     - `Deprecated`
     - `Removed`
     - `Fixed`
     - `Security`
     - `Performance`
     - `Refactored`
     - `Documentation`
2. **2行目**: エントリ本体を 1 行（改行なし）で記述します。
   - 正規表現: `/^- \*\*(feat|fix|docs|style|refactor|test|chore|ci)(\([^)]+\))?: .+?\*\* \(#(\d+)\): .+$/`
   - `- **` で始めます。
   - `(#N)` の `N` はファイル名の Issue 番号と一致している必要があります。
   - `(#N)` は要約の外（`**` を閉じた後）に置きます。
3. **3行目以降**: 空行（空白のみの行を含む）のみ許されます（本文の複数行記述は不可）。

## 実例

例えば Issue #1975 の場合、ファイル名は `changelog.d/1975.md` とし、中身は以下のように記述します:

```markdown
<!-- ### Fixed -->
- **fix(cli): `send` 直後の `wait` が「まだ始まっていない」を完了と読む問題を修正** (#1975): `wait` が `sessionStatus==='ready'` を完了と判定する直前に、**「このインスタンスに最後に渡されたプロンプト」と「エージェント自身が最後に報告したターン終了（`lastStopEventAt`）」を突き合わせる**ゲートを追加。`send` 直後は最新の構造化イベントが直前ターンの `stop` のままなので #1839 の `adoptTurnStart()` が何も採用せず、`turnStartedAt === null` が「決着済み」と読まれてアイドル composer をそのまま完了にしていた（隔離サーバ実測 2026-08-22 / copilot 1.0.80: `send`→`wait` 5 回中 3 回が約 0.3 秒・`basis=scraper_ready`・成果物ゼロで exit 0）。ゲートは `GET /api/worktrees/:id/messages?limit=1&unit=pairs` を `--instance`（無指定ならサーバが解決した `cliToolId`）でスコープして読む。**hook を出さないツールは挙動不変** — `structuredEvents.source.capabilities.supportedEvents`（#1924 の宣言値）が `stop` とターン開始語の両方を宣言しているソースだけがこのゲートに入り、legacy-relay（`supportedEvents: []`）と #1924 以前のサーバは従来経路のまま台帳も引かない。保留は `PENDING_PROMPT_HOLD_MS`=60 秒で打ち切り（hooks は全経路 fail-open なので `Stop` の取りこぼしで `wait` が返らなくなってはいけない）、`--timeout` / `--stall-timeout` はそれより短ければ従来どおり優先される。完了行の `basis=` は、エージェントが最新プロンプトの終了を報告していれば `hook_stop` になる（`scraper_ready` は「画面しか言っていない」という文書どおりの意味に戻る）。
```

## 確認コマンド

断片ファイルの追加後は、以下のコマンドで検証およびプレビューができます:

- 断片ファイルの書式を検証する:
  ```bash
  node scripts/changelog-fragments.mjs check
  ```
- CHANGELOG 形式への集約結果をプレビューする:
  ```bash
  node scripts/changelog-fragments.mjs preview
  ```
