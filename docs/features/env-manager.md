# Env Manager（環境変数マネージャ）

> Issue #1968。ワークツリー直下の `.env` 系ファイルを、マスキング付きの専用 UI で
> 表示・編集する機能。PC（Activity Bar）とスマートフォン（Tools タブ）の両方に対応する。

## 概要

`.env` は `EXCLUDED_PATTERNS`（`src/lib/file-tree.ts`）でファイルツリーから除外されており、
`EDITABLE_EXTENSIONS` にも入っていない。つまり **一般のファイル UI からは見えないし編集もできない**。
この仕様は Issue #1968 でも一切変更していない。

Env Manager はそれとは別の、狭くて明示的な入口である。

| | 一般ファイルツリー | Env Manager |
|---|---|---|
| `.env` の一覧表示 | されない（`EXCLUDED_PATTERNS`） | される |
| 対象パス | ワークツリー内の任意のパス | **ワークツリー直下のみ** |
| ファイル名 | クライアントが自由に指定 | **サーバ側 allowlist** |
| 値の表示 | 平文 | **既定でマスク**、1 行ずつ 👁️ で解除 |
| 保存前の検証 | 拡張子ごとの検証 | **dotenv 構文 + 制御文字 + サイズ** |

この 2 面が交わらないことは `tests/integration/api-env-manager.test.ts` の
「the Env Manager serves exactly what the tree hides」で固定している。

## 入口

- **PC**: ワークツリー詳細画面の Activity Bar 最下段の鍵アイコン（`env`）。
- **スマホ**: `Tools` タブ内の `環境変数` サブタブ。

どちらも同じ `EnvManagerPane`（`src/components/worktree/EnvManagerPane.tsx`）を描画する。

## 対象ファイル（サーバ側 allowlist）

`src/lib/env-manager/env-file-allowlist.ts` が唯一の権威。受け付ける形は次の 3 つだけ。

```
.env
.env.<segment>          .env.local / .env.production / .env.example / .env.sample …
.env.<segment>.local    .env.development.local …
```

`<segment>` は `[A-Za-z0-9_-]` の 1〜32 文字。この文字集合には `/` も `\` も `.` も NUL も
含まれないため、**通ったファイル名は必ず単一のパス要素**になる。`../.env` や `/etc/passwd` や
`sub/.env` は構造的に表現できない。

ディスク上に無くても `.env` と `.env.local` は常にピッカーに並ぶ（`exists: false`）。
そのまま保存すると新規作成される。

## セキュリティモデル

パス検証は 3 層あり、**それぞれ別の攻撃を塞ぐ**。1 層でも外すと対応するテストが赤になる。

1. `isAllowedEnvFileName()` — 名前の allowlist（上記）。
2. `isPathSafe()` — 字句的なワークツリー内包（`../` 対策、[SF-002]）。
3. `resolveAndValidateRealPath()` — シンボリックリンク解決後の内包（[SEC-394]）。
   `.env -> /etc/passwd` のように **名前もパスも合法だが実体が外にある**ケースはこれだけが見える。

そのほか:

- **値をログに出さない。** サービス層もルートも、失敗時に記録するのは
  「ファイル名」と「errno コード」だけ。`fs` のエラーメッセージは絶対パスを含むので記録しない。
- **値をエラー本文に出さない。** 検証エラーは `{ line, code, key? }` だけを返す。`key` は
  変数名であって値ではない。
- **レスポンスをキャッシュさせない。** GET は `Cache-Control: no-store, private`。
- **新規作成時のパーミッションは `0o600`。** 既存ファイルのモードは変更しない。
- **マスキングは表示の制御であって転送の制御ではない。** 編集するにはブラウザに値が要るので、
  API は平文を返す。守っているのは認証と allowlist であって難読化ではない。

### この機能が塞いでいない既知の経路（Issue #1968 の対象外・実測 2026-08-24）

`EXCLUDED_PATTERNS` は**ツリーの一覧に出さない**ための仕組みであって、パス直指定の読み取りは
塞いでいない。実測すると Issue #1968 以前から次が通る:

```
GET /api/worktrees/<id>/files/.env
→ 200 {"success":true,"path":".env","content":"SECRET=...","extension":"env",...}
```

`GET /api/worktrees/[id]/files/[...path]/route.ts` は `isPathSafe` /
`resolveAndValidateRealPath` は通すが `isExcludedPattern()` は見ないため、UI からは辿れなくても
URL を知っていれば読める。**Issue #1968 ではこの挙動を変更していない**（Issue の要求は
「既存の除外が効き続けること」であって、共有ルートの挙動変更ではないため）。
塞ぐなら別 Issue で、`files` ルートの GET / PUT に `isExcludedPattern()` ガードを足す必要がある。

## 表示と編集

### Key-Value ビュー

1 行 = 1 変数。値は既定で `••••••••`（**固定 8 文字**。長さを保存するマスクは秘密の長さを
漏らすため採用していない）で表示され、その入力欄は `readOnly` になる。👁️ を押すと
その行だけ実値になり、編集可能になる。

キーや値の編集は、**元の行の位置に書き戻す**（`applyEnvRows`）。行から丸ごと再生成すると
コメントと空行が消えるため。

### Raw ビュー

ファイル全文のテキスト編集。こちらも既定ではマスク表示（`maskEnvRawText`）で `readOnly`、
「値を表示」で編集可能なテキストエリアに切り替わる。マスクしてもキー・コメント・空行は残る。

ビューを切り替えると内容は引き継がれる（KV の編集 → Raw のテキスト、Raw の編集 → KV の行）。

### 補完サジェスト

`.env.example` / `.env.sample` が存在すると、そこに定義されていて編集中のファイルに無いキーが
Key-Value ビューの下にボタンとして並ぶ。押すと行が追加される。

### バリデーション

| コード | 重大度 | 条件 |
|---|---|---|
| `invalid-syntax` | error | `KEY=VALUE` の形でない行 |
| `invalid-key` | error | 変数名が `[A-Za-z_][A-Za-z0-9_]*` でない |
| `unterminated-quote` | error | 引用符が閉じていない |
| `control-character` | error | タブ / LF / CR 以外の C0 制御文字、DEL |
| `too-large` | error | 256KB 超 |
| `too-many-entries` | error | 変数 1000 個超 |
| `duplicate-key` | warning | 同じキーが複数回（保存はできる） |

error が 1 つでもあると保存ボタンは無効になる。同じ検証がサーバ側でも走る
（クライアント側は利便性、サーバ側が制御）。

## API

```
GET /api/worktrees/:id/env                 → { success, files }
GET /api/worktrees/:id/env?file=.env       → { success, files, selected }
PUT /api/worktrees/:id/env                 body: { file, content }
```

エラー本文は `{ success: false, error: { code, message, issues? } }`。
`route.ts` は `GET` / `PUT` しか export しない（`scripts/check-route-exports.mjs`）。
型と定数は `src/lib/env-manager/types.ts` 側にある。

---

## 実機確認手順（UI は自動テストだけでは「動く」を保証できない）

自動テストは jsdom 上のものなので、実際のレイアウト・テーマ・タッチ操作は実機で確認する。

### 準備

```bash
# 本番サーバ（ポート 3000）には触らない。別ポート + 使い捨て DB で起動する。
NODE_ENV=development CM_PORT=3011 CM_DB_PATH="$HOME/.commandmate-env-uat.sqlite" npx tsx server.ts
```

確認対象のワークツリー直下に、次のファイルを置いておく。

```bash
cat > .env <<'EOF'
# Database
DB_HOST=localhost
DB_PORT=5432

# Secrets
API_KEY=super-secret-value-that-should-be-masked
EOF

cat > .env.example <<'EOF'
DB_HOST=
DB_PORT=
API_KEY=
SENTRY_DSN=https://example.invalid/0
EOF
```

### A. PC（デスクトップ幅 1280px 以上）

| # | 手順 | 期待 |
|---|---|---|
| A1 | ワークツリー詳細を開き、Activity Bar 最下段の鍵アイコンをクリック | Env Manager ペインが開く。ツールチップに「Env / 環境変数」 |
| A2 | ファイルピッカーを見る | `.env` が選択済み。`.env.local` に「未作成」バッジ、`.env.example` に「テンプレート」バッジ |
| A3 | 値の列を見る | 全行が `••••••••`。実値はどこにも出ていない（DevTools の DOM 検索で `super-secret-value` が 0 件） |
| A4 | `API_KEY` 行の 👁️ をクリック | **その行だけ**実値になり、入力できるようになる。`DB_HOST` はマスクのまま |
| A5 | もう一度 👁️ | 再びマスクに戻る |
| A6 | ヘッダの「値を表示」 | 全行が実値に。もう一度押すと全行マスク |
| A7 | `SENTRY_DSN` サジェストをクリック | 行が追加され、キーが `SENTRY_DSN` で入る |
| A8 | 保存 → 再読み込み（↻） | 保存後は全行がマスクに戻る。`.env` を `cat` するとコメントが残っている |
| A9 | 「テキスト」タブ | 値だけが `••••••••`。コメント・空行・キーは残る。テキストエリアは読み取り専用 |
| A10 | 「値を表示」 → テキストを編集 | 編集できる。「キー / 値」に戻すと編集が行に反映される |

### B. スマートフォン（実機、または DevTools のデバイスエミュレーション 375×667）

| # | 手順 | 期待 |
|---|---|---|
| B1 | ワークツリー詳細 → `Tools` タブ | サブタブ行を横スクロールすると「環境変数」がある |
| B2 | 「環境変数」をタップ | Env Manager が開く。**横方向にページがはみ出さない** |
| B3 | 行を見る | キーと値が**縦に積まれる**（PC では横並び）。潰れていない |
| B4 | 👁️ と 🗑 をタップ | **ホバーなしで最初から見えている**（`[@media(hover:none)]:opacity-100`）。タップ領域が 44px 以上 |
| B5 | ファイルピッカーを横スクロール | `.env` / `.env.local` / `.env.example` を選べる |
| B6 | 値を編集 → 保存 | 保存できる。キーボードが出てもレイアウトが壊れない |

### C. テーマ（light / dark 両方で A3・A9・D1 を繰り返す）

| # | 手順 | 期待 |
|---|---|---|
| C1 | More → テーマを light | 文字・枠線・バッジ・エラー帯がすべて読める |
| C2 | テーマを dark | 同上。**どちらのテーマでも不可視な要素が無い** |
| C3 | OS のテーマ追従に戻す | 切り替えても崩れない |

### D. バリデーション

| # | 手順 | 期待 |
|---|---|---|
| D1 | 「テキスト」→「値を表示」→ `this is not an assignment` の行を足す | 赤い帯に「N 行目: KEY=VALUE の形式ではありません」。保存ボタンが無効 |
| D2 | キーを `9BAD` に変える | 「変数名が不正です」。保存ボタンが無効 |
| D3 | `A="unclosed` を足す | 「引用符が閉じられていません」 |
| D4 | 同じキーを 2 回書く | **黄色**の警告。保存ボタンは有効のまま |
| D5 | 制御文字を貼り付ける（`printf 'A=x\033[31m\n' \| pbcopy` してから貼り付け） | 「使用できない制御文字」。保存ボタンが無効 |
| D6 | エラーを直す | 帯が消え、保存ボタンが有効に戻る |

### E. セキュリティ（ブラウザの DevTools から）

| # | 手順 | 期待 |
|---|---|---|
| E1 | Network タブで `GET /api/worktrees/<id>/env?file=.env` | レスポンスヘッダに `Cache-Control: no-store, private` |
| E2 | `?file=../../etc/passwd` を直接叩く | 400、`INVALID_ENV_FILE`。本文に他ファイルの内容が無い |
| E3 | `ln -s /etc/passwd <worktree>/.env.local` してから `.env.local` を開く | 400、`INVALID_PATH` |
| E4 | 一般のファイルツリー（Files）を開く | `.env` 系が 1 つも出ていない |
| E5 | サーバのログを見る | 値が 1 つも出ていない（出るのはファイル名と errno だけ） |

### 後片付け

```bash
kill <起動した tsx server.ts の PID>      # 広域 pkill は使わない
rm -f "$HOME/.commandmate-env-uat.sqlite"
rm -f <worktree>/.env <worktree>/.env.example
```

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/lib/env-manager/env-file-allowlist.ts` | ファイル名 allowlist（セキュリティ層 1） |
| `src/lib/env-manager/env-parser.ts` | dotenv パーサ / シリアライザ / 行単位マージ |
| `src/lib/env-manager/env-validator.ts` | 構文・制御文字・サイズの検証 |
| `src/lib/env-manager/env-masking.ts` | 固定長マスク（値 / Raw テキスト） |
| `src/lib/env-manager/env-file-service.ts` | ファイル I/O（層 2・3 のパス検証込み。サーバ専用） |
| `src/lib/env-manager/env-api-client.ts` | ブラウザ側の fetch |
| `src/lib/env-manager/types.ts` | API の型（route.ts から export できないため） |
| `src/app/api/worktrees/[id]/env/route.ts` | GET / PUT |
| `src/hooks/useEnvManager.ts` | ドラフト状態（KV ⇄ Raw の受け渡し） |
| `src/components/worktree/EnvManagerPane.tsx` | UI（PC / スマホ共通） |
