# 設計方針: `commandmate remote` — QR ペアリングによるスマホ接続（Issue #1937）

- **Issue**: [#1937](https://github.com/Kewton/CommandMate/issues/1937)
- **ステータス**: Accepted（設計フェーズのみ。実装は本書の §12 で分割した子 Issue が担う）
- **基準日**: 2026-08-25（本書の「実測」は全てこの日に `feature/1937-remote-design-policy` の作業ツリーで確認した。**行番号は腐るため識別子で参照する**。行番号を書いた箇所は「その時点の実測値」であることを明記する）
- **本書の範囲**: Phase 1（MVP）の設計方針の確定のみ。実装・PR は含まない。将来構想（Managed Relay / アカウント / 課金 / Relay の E2E 暗号化）は **Issue が MVP 対象外と明記しているため本書では設計しない**（§10）

---

## 0. 結論（先に書く）

Issue が「先に決めること」と明示した 2 点を、コードの実測に基づいて次のとおり決定する。

### 決定 A — 既存 QR ログイン（#383 / `QrCodeGenerator.tsx`）は **deprecate して撤去する**（実質「置換」）

「並存」は採らない。ただし**撤去の単位を 2 つに割る**のが本決定の実質である。

| 資産 | 役割 | 決定 |
|---|---|---|
| `src/components/auth/QrCodeGenerator.tsx` | **QR を発行する側**（長期トークンを URL fragment に埋める） | **Phase 1 で削除**。これが Issue のセキュリティ要件が禁じている当のもの |
| `src/hooks/useFragmentLogin.ts` | **QR を受け取る側**（`#token=` を読んで `/api/auth/login` へ POST） | **残す。かつ `#code=` を扱えるよう拡張して新方式の受け口に転用する**。`#token=` の受理は 1 マイナーリリースだけ残し、Phase 2 で撤去 |

根拠は §2。要点だけ先に書くと、**この UI は「守るべき利用者」を実測上ほぼ持たない**:

1. 到達経路は `/login` の 1 箇所のみで、しかも `hidden md:block` の中にある（`src/app/login/page.tsx` の `{/* QR Code Generator - PC only (768px+), hidden on mobile */}` 直下）。**スマホからは到達できない** PC 専用 UI である
2. `/login` 自体、`CM_AUTH_TOKEN_HASH` が無い＝認証が無効なら `/` へリダイレクトされる。認証は `start --auth` の opt-in なので、**既定構成では画面ごと存在しない**
3. **利用者向けドキュメントでの言及が 0 件**。`grep -rniE "qr[- ]?code|QRコード" docs/ README.md` の実測ヒットは `docs/module-reference.md`（開発者向けリファレンス）1 行のみ。`docs/security-guide.md` / `docs/user-guide/webapp-guide.md` / `docs/TRUST_AND_SAFETY.md` / `README.md` のいずれにも無い
4. README が案内しているスマホ接続手順は **QR ではなく `CM_BIND=0.0.0.0` ＋ LAN IP**（README の FAQ「Run `commandmate init` and enable external access — this sets `CM_BIND=0.0.0.0`」）。つまり**公式に案内されている経路は別物**である
5. 現行 UX は利用者が URL とトークンを**手入力**する。つまりこの UI を使えている人は**既にトークンを手元に持っている**ので、撤去しても「スマホで手入力する」という従来手段を失わない

### 決定 B — 端末別認証（`remote devices` / `remote revoke <device-id>`）は **Phase 1 に入れない**

Phase 1 の失効単位は **「`remote stop` / 期限切れによる一括失効」** とする。

理由は「重いから」ではなく、**現在の認証アーキテクチャでは端末別クレデンシャルを Edge Middleware が検証できない**という構造的制約が実測で確認されたためである（§3.1）。要点:

- HTTP 側の認証を実際に強制しているのは `src/middleware.ts` であり、これは **Edge Runtime** で動く。`crypto.timingSafeEqual` も `better-sqlite3` も `fs` も使えないため、**端末テーブルを引けない**
- さらに Next.js の Edge サンドボックスは `process.env` を**スナップショットのコピー**として渡す（`node_modules/next/dist/server/web/sandbox/context.js` の `buildEnvironmentVariablesFrom()` が `Object.fromEntries(Object.keys(process.env).map(...))` を作る）。そのコンテキストは `moduleContexts` Map にキャッシュされ再利用される。したがって **サーバ起動後に Node 側で `process.env` を書き換えても middleware には届かない**
- 結果として「実行時に発行した端末クレデンシャル」を middleware に認識させる方法は、(a) サーバ再起動、(b) 起動時 env の鍵で検証できるステートレス署名（＝失効リストが持てない）、(c) 検証を middleware から追い出す（＝全 API ルートの認証を作り直す）のいずれかしかない。**どれも「端末テーブルを足す」で済む話ではない**

コストと失うものは §3.2 / §3.4 に明記した。

### Phase 1 の姿

```
$ commandmate remote

CommandMate Remote

✓ CommandMate started on 127.0.0.1:3000 (token auth enabled)
✓ Secure remote connection established
✓ One-time pairing code generated

  <QR>

Pairing link expires in 10 minutes.
Remote access expires in 8 hours.

Provider: Tailscale Serve
URL: https://my-mac.example-tailnet.ts.net
```

**QR に載るのは 1 度限りのペアリングコードだけ**で、長期トークンは載らない。スマホがコードを 1 度使うと、
サーバが `HttpOnly` cookie を張って以後は既存の認証経路（middleware / ws-server）にそのまま乗る。

---

## 1. 現状の実測 — Issue 本文「【起票前の実測】既存資産との関係」の裏取り

Issue 本文の記述は起票時点のものである。全行をコードに当たり直した。**食い違いは実測を正とする。**

### 1.1 一致した行

| Issue の主張 | 実測 | 判定 |
|---|---|---|
| QR ログイン UI が `src/components/auth/QrCodeGenerator.tsx` にある（#383） | 存在する。129 行。`/login` から `next/dynamic`（`ssr: false`）で読み込まれる | ✅ |
| `QrCodeGenerator.tsx:47` が `#token=` にトークンを埋める | `return \`${parsedUrl.toString()}#token=${encodeURIComponent(trimmedToken)}\`;` — **行番号も一致** | ✅ |
| IP 制限 `src/lib/security/ip-restriction.ts` が実装済み | 286 行。`middleware.ts` が `getAllowedRanges` / `isIpAllowed` / `getClientIp` / `normalizeIp` を使う | ✅ |
| Rate Limit `src/lib/security/request-rate-limiter.ts` が実装済み | 72 行。`createRequestRateLimiter({limit, windowMs})` の固定ウィンドウ実装 | ✅ |
| WebSocket 認証が `src/lib/ws-server.ts` にある（#331） | `upgrade` ハンドラで `isAuthEnabled()` → `parseCookies()` → `verifyToken()`。失敗時 `401` を生ソケットに書いて destroy | ✅ |
| PWA / Push が実装済み | `AUTH_EXCLUDED_PATHS` に `/manifest.webmanifest` `/sw.js` `/offline`（#1124）。`src/app/api/push/{escalation,subscriptions,vapid}` | ✅ |
| `CM_BIND` の既定が `127.0.0.1` | `server.ts` の `const hostname = getEnvByKey('CM_BIND') || '127.0.0.1';`（実測 58 行目。Issue の記述と一致） | ✅ |
| `src/cli/commands/` に `remote.ts` は無い | 実測のファイル一覧は Issue の列挙と**完全一致**（`auto-yes / capture / docs / init / instances / issue / ls / quickstart / report / respond / send / skill-format / skill-guards / skill / start / status / stop / sync / task / update / verify / wait` の 22 本。Issue の `skill*` は 3 本の意） | ✅ |
| tailscale / cloudflared への言及は `security-messages.ts` の箇条書き 2 行のみ | `REVERSE_PROXY_WARNING` 定数の中の `  - Cloudflare Access` / `  - Tailscale`（実測 31 / 32 行目）。検出・起動・停止のコードは repo 全体に無い | ✅ |

### 1.2 食い違った行（実測を正とする）

| Issue の主張 | 実測 | 差分の意味 |
|---|---|---|
| `0.0.0.0` 警告は `src/cli/commands/start.ts:339` | 実測は **340 行目**（`console.log(REVERSE_PROXY_WARNING)`）。条件は `bindAddress === '0.0.0.0' && !options.auth && !options.allowedIps` | 1 行のズレ。**`--auth` が付いていれば警告が出ない**点が重要 — `remote` は `--auth` 相当で起動するので、この警告経路には入らない |
| `auth.ts` の関数群 = `generateToken` / `hashToken` / `verifyToken` / `getTokenMaxAge` / `buildAuthCookieOptions` | 上記に加えて **`parseCookies`（WS 用）/ `isAuthEnabled` / `isHttpsEnabled` / `createRateLimiter`（ログイン失敗のロックアウト）** と定数群（`RATE_LIMIT_CONFIG` / `DEFAULT_COOKIE_MAX_AGE_SECONDS`）、および `auth-config.ts` からの再エクスポート（`AUTH_COOKIE_NAME` / `AUTH_EXCLUDED_PATHS` / `parseDuration` / `computeExpireAt` / `DEFAULT_EXPIRE_DURATION_MS` / `isValidTokenHash`） | Issue の列挙は部分集合。**再利用できる部品が Issue の想定より多い**（§7.5） |
| 「`src/lib/security/auth.ts` は単一の共有トークンモデル」 | 正しい。ただし Issue が書いていない**より強い制約が 3 つある**（下記 A/B/C） | §3.1 で詳述。**決定 B の根拠はここ** |

#### A. `auth.ts` のトークン状態は **import 時に env から固定される**

```ts
const storedTokenHash: string | undefined = (() => { ... process.env.CM_AUTH_TOKEN_HASH ... })();
const expireAt: number | null = computeExpireAt();
```

モジュールトップレベルの IIFE である。つまり**実行時に「トークンを足す」API は存在せず、足せる構造にもなっていない**。

#### B. HTTP の認証を強制しているのは `auth.ts` ではなく **Edge Runtime の `middleware.ts`**

`middleware.ts` は `auth.ts` を import していない。冒頭コメントが理由を明記している:

> `C001 (middleware variant): No Node.js-specific modules imported here. auth.ts uses Node.js crypto, so constants/logic are duplicated inline for Edge Runtime.`

検証は `crypto.subtle.digest('SHA-256', ...)` ＋ XOR 定数時間比較で**独立に実装されている**。共有しているのは Edge 互換の `src/config/auth-config.ts` だけ。

#### C. 認証 cookie の値は **平文トークンそのもの**

`src/app/api/auth/login/route.ts`:

```ts
response.cookies.set(AUTH_COOKIE_NAME, token, buildAuthCookieOptions(effectiveMaxAge));
```

middleware も ws-server も「cookie 値を SHA-256 して `CM_AUTH_TOKEN_HASH` と比較する」だけである。
**この事実が Phase 1 の設計を決める**: ペアリング成功時にサーバが cookie へ入れるべき値は「平文の長期トークン」であり、サーバはそれを知っていなければならない（§7.2）。

### 1.3 Issue が触れていない実測（設計に効くもの）

| 実測 | 設計への影響 |
|---|---|
| Next.js の Edge サンドボックスは `process.env` を**コピー**で渡し（`buildEnvironmentVariablesFrom()`）、コンテキストを `moduleContexts` Map にキャッシュする | 起動後の env 変更は middleware に届かない。**決定 B の直接の根拠** |
| Auto-Yes の状態は **in-memory のみ**（`src/lib/auto-yes-state.ts` の `globalThis.__autoYesStates` Map）。DB に持たない | 「Remote 利用時の Auto Yes は既定で無効」は、`remote` がサーバを起動する以上**構造的に自動で満たされる**。必要なのは「`remote` が Auto-Yes を有効化しないこと」を固定するテストだけ（§5.5） |
| ターミナルに QR を出す依存が **無い**。`react-qr-code` は React コンポーネント（SVG）で CLI からは使えない。ただしその推移依存に純 JS エンコーダ `qr.js@0.0.0` が入っている | **新規依存が 1 つ要る**。§11 の未解決論点 U-1 |
| `cloudflared` 2025.4.0 がこの開発機に存在（`/opt/homebrew/bin/cloudflared`）。`tailscale` は**無い** | Tailscale 側は実装時に実機実測が要る（§11 U-2） |
| `cloudflared tunnel` は `--url` / `--metrics <addr>` / `--pidfile <path>` / `--no-autoupdate` を持つ。バイナリの文字列表に `/quicktunnel`・`/ready`・`/healthcheck`・`Requesting new quick Tunnel on trycloudflare.com...`・`Your quick Tunnel has been created! Visit it at` が存在する | **URL 取得を stderr のバナー scraping に頼らず、`--metrics` のローカル HTTP から取れる可能性が高い**（§6.4・§11 U-3） |
| CLI → サーバの API 呼び出しは `ApiClient` が `Authorization: Bearer <token>` を付ける。トークンは `--token` か `CM_AUTH_TOKEN` からのみ解決され、**永続化されない** | `remote` は**自分でトークンを生成してサーバを起こす**ので平文を保持している。API を叩くならそれを使う（§5.3） |
| **tmux の pane はサーバの環境変数をそのまま継承する。** `sanitizeEnvForChildProcess()` の実際の呼び出し元は `src/lib/slash-command-catalog.ts` と `src/lib/assistant/non-interactive-runner.ts` の 2 箇所だけで、`src/lib/tmux/**` は `env:` を一切指定しない。`env-sanitizer.ts` の docblock 自身が「The **agent's** pane is unaffected — tmux inherits the server's environment directly and never goes through this function」と書いている | **サーバの env に平文の長期トークンを置くと、Claude / Codex 等のエージェントがそれを読める。** 本書の §7.2 の設計を env 方式から**一度限りのファイル方式**に変えた直接の理由 |
| `SENSITIVE_ENV_KEYS`（`src/lib/security/env-sanitizer.ts`）は `CM_AUTH_TOKEN` / `CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE` / `CM_HTTPS_*` / `CM_ALLOWED_IPS` / `CM_TRUST_PROXY` / `CM_DB_PATH` / `CLAUDECODE` / `GH_DEBUG` の 10 件。`CM_AUTH_TOKEN`（平文）は #1996 で**後から追加された**（実子プロセスで読み出せることが実測されたため） | 新しい秘匿 env を足すなら**同じ轍を踏まない**。ただし §7.2 の結論はそもそも「秘匿 env を足さない」 |
| `PidManager` の状態ファイルは「1 行目に素の PID、2 行目に JSON」のハイブリッド形式（#1632）。`DaemonState` に `port` / `bind` / `protocol` / `auth` / `startedAt` / `startTime` を持つ | `remote status` / `remote stop` の状態ファイルはこの形式に倣える（§6.3） |
| `AUTH_EXCLUDED_PATHS` は `as const` ＋ `Array.includes()` の**完全一致**（S002。`startsWith` バイパス防止） | 新しい未認証エンドポイントを足すのは 1 行だが、**足した分だけトンネル越しの未認証面が増える**。Phase 1 で増やすのは 1 本だけにする（§7.3） |
| IP 制限チェックは `AUTH_EXCLUDED_PATHS` の評価**より前**に走る（`[S4-003]`） | ペアリングエンドポイントも IP 制限の内側にある。`--allowed-ips` との併用が効く |

---

## 2. 決定 1 の詳細 — 既存 QR ログイン（#383）の扱い

### 2.1 「利用者がいるか」の実測

| 観点 | 実測 |
|---|---|
| どの画面から到達するか | `/login` のみ。`src/app/login/page.tsx` が `<div className="hidden md:block">` で包んでいる（コメント: `QR Code Generator - PC only (768px+), hidden on mobile`）。**スマホの画面幅では DOM に出ても表示されない** |
| その画面はいつ出るか | `useAuthEnabled()` が false なら `window.location.href = '/'`。つまり `CM_AUTH_TOKEN_HASH` 未設定＝既定構成では **`/login` に留まれない** |
| docs で案内されているか | **0 件**。`docs/**` と `README.md` を `grep -rniE "qr[- ]?code|QRコード"` した結果、ヒットは `docs/module-reference.md` の 1 行（開発者向けリファレンス）と `CLAUDE.md` のディレクトリツリー 1 行のみ。`docs/security-guide.md` は QR に一切触れず、Tailscale / Cloudflare Access / Nginx+BasicAuth を案内している |
| 公式のスマホ手順は何か | README FAQ が `commandmate init` → external access → `CM_BIND=0.0.0.0` → `http://<PC-IP>:3000`。**QR ではない** |
| i18n キー | `locales/{en,ja}/auth.json` の `login.qr.*` が 13 キー。うち **10 キーが `QrCodeGenerator` 専用**（`sectionTitle` `urlLabel` `urlPlaceholder` `tokenLabel` `tokenPlaceholder` `securityNotice` `showQrButton` `hideQrButton` `qrSecurityWarning` `httpsWarning`）、**3 キーは `login/page.tsx` が `useFragmentLogin` のエラー表示に使う**（`autoLoginError` `tokenExpiredOrInvalid` `rateLimited`） |
| テストが何を固定しているか | `tests/unit/components/QrCodeGenerator.test.tsx` の **15 ケース**。固定しているのは「既定で非表示（S001）」「入力変更で再度隠す（S001 バイパス防止）」「http で警告」「trailing slash 除去」「`/login` の二重付与回避」「**`#token=` にトークンを URL エンコードして埋めること**」。つまり**テストは撤去対象の仕様そのものを固定している**ので、コンポーネント削除と同時にファイルごと削除する |
| 直近の変更 | 2026-07-14 の `refactor(ui): 生chromatic色をtintトークンへ全面移行`（#1140）。機能面は `fix: harden qr login flow` 以降**触られていない** |

**評価**: 「利用者ゼロ」は証明できない（テレメトリが無い）。しかし到達には *(1) `--auth` を明示的に有効化し、(2) 幅 768px 以上の画面で `/login` を開き、(3) URL とトークンを手で貼る* の 3 条件が要り、そのどれも docs に書かれていない。**発見可能性が実質ゼロの機能**であり、かつ利用者は定義上トークンを手元に持っている。並存させる価値より、Issue が禁じた「長期トークンを QR に埋める経路」が残り続けるコストの方が大きい。

### 2.2 決定と移行経路

| 段階 | 内容 |
|---|---|
| **Phase 1（本 Issue）** | `QrCodeGenerator.tsx` と `QrCodeGenerator.test.tsx` を削除。`login/page.tsx` の `dynamic()` import と `hidden md:block` ブロックを削除。`locales/{en,ja}/auth.json` から**上記 10 キーだけ**を削除（3 キーは残す）。`docs/module-reference.md` の当該行を更新 |
| **Phase 1（互換）** | `useFragmentLogin` の **`#token=` 受理は残す**。既に手元の QR を持っている人が 1 リリースだけ困らないため。CHANGELOG に deprecation を明記し、`#token=` 経路にログを 1 行足す（トークン本体は出さない） |
| **Phase 2** | `#token=` の受理を撤去し、`useFragmentLogin` を `#code=` 専用にする |

**「置換」と呼ばずに「deprecate → 撤去」と書く理由**: 発行側は Phase 1 で即座に消えるが、受理側は 1 リリース残るため、**同一リリース内での 1:1 置換ではない**。受入条件「QR／ペアリング URL に長期認証トークンが含まれない」は *CommandMate が発行する URL* についての条件であり、Phase 1 の削除で満たされる。

### 2.3 残す `useFragmentLogin` を転用する形

既存の受理側は、本 Issue が欲しいものをほぼ持っている:

- `history.replaceState` で**アドレスバーと履歴から即座に落とす**（S002）
- React Strict Mode の二重実行を `processedRef` で防ぐ
- `decodeURIComponent` の try/catch、長さ上限 256

`#token=` を `#code=` に一般化し、`code` なら `POST /api/remote/pair` へ、`token` なら従来どおり `/api/auth/login` へ振り分ける。**ペアリング画面を新規ルートとして作らない**ので、`AUTH_EXCLUDED_PATHS` に足すのは API 1 本だけで済む（§7.3）。

---

## 3. 決定 2 の詳細 — 端末別認証を Phase 1 に入れるか

### 3.1 制約の実測（なぜ「DB に端末テーブルを足す」で終わらないか）

HTTP リクエストが認証される経路を実際に辿ると、こうなっている。

```
リクエスト
  └─ src/middleware.ts             ← Edge Runtime。ここが唯一の強制点
       ├─ IP 制限                   （AUTH_EXCLUDED_PATHS より前）
       ├─ AUTH_EXCLUDED_PATHS 完全一致 → 素通し
       ├─ Cookie: cm_auth_token → crypto.subtle.digest('SHA-256') → XOR 比較 vs process.env.CM_AUTH_TOKEN_HASH
       └─ Authorization: Bearer   → 同上（CLI 用フォールバック、#518）
```

端末別クレデンシャルを入れるなら、この比較を「N 個の候補との照合」に変えねばならない。ところが:

| 障壁 | 実測 |
|---|---|
| **DB が引けない** | middleware は Edge Runtime。`better-sqlite3` はネイティブ addon で読み込めない。`fs` も無い |
| **env で渡しても動的に増やせない** | Edge サンドボックスは `buildEnvironmentVariablesFrom()` が `process.env` の**コピー**を作り、`moduleContexts` Map にキャッシュする。サーバ起動後に Node 側で `process.env` を書き換えても middleware は古いスナップショットを見続ける |
| **Node ランタイムへ逃がせない** | `experimental.nodeMiddleware` は `next.config.js` に設定が無く、現行 Next 15.5.20 でも experimental。認証の強制点を experimental フラグに載せ替えるのは Phase 1 の変更としては過大 |
| **`auth.ts` を直せば済む話ではない** | HTTP 経路は `auth.ts` を通らない。`verifyToken` を多クレデンシャル化しても、影響するのは `/api/auth/login` と `ws-server.ts` だけで、**middleware は素通しのまま**（＝実効的な認証は変わらない） |

したがって端末別認証の実装は、**最低でも次のどれかを選ぶ設計判断**を伴う:

| 選択肢 | 内容 | 失効の可否 |
|---|---|---|
| S1 | 端末クレデンシャルを **HMAC 署名付きステートレストークン**にし、鍵を起動時 env で渡して Edge の `crypto.subtle` で検証 | **個別失効できない**（失効リストを middleware が読めない）。短 TTL ＋ 再発行で近似するしかない |
| S2 | 端末ハッシュの集合を起動時 env に載せる（`CM_REMOTE_DEVICE_HASHES`） | 端末の**追加も失効もサーバ再起動が要る**。`remote` の UX（実行中に端末を足す）と噛み合わない |
| S3 | middleware から認証の強制を降ろし、全 API ルート／ページで Node 側検証に作り替える | 個別失効できる。ただし **`AUTH_EXCLUDED_PATHS` を軸にした現行の防御モデルを全面改装**することになる |
| S4 | `experimental.nodeMiddleware` に載せ替える | 個別失効できる。experimental 依存 |

**この選択自体が独立した設計 Issue に値する。** Issue #1937 の Phase 1（＝「1 コマンド＋QR で繋がる」）にこれを同梱すると、Phase 1 が「認証アーキテクチャの作り替え」に化ける。

### 3.2 入れる場合のコスト（見積り）

| 項目 | 内容 | 規模 |
|---|---|---|
| 設計判断 | S1〜S4 の選択、失効セマンティクスの確定、脅威モデルの再評価 | 設計 Issue 1 本 |
| DB | 新規 migration `v57`（現行の最新は `v56-gate-result-source.ts`）＋ `src/lib/db/remote-devices-db.ts` | 中 |
| 認証中核 | `auth.ts` の多クレデンシャル化（module-level IIFE の解体を含む）＋ `middleware.ts` の検証経路の作り替え（S3 なら全ルート） | **大** |
| WS | `ws-server.ts` の upgrade 検証を端末解決に対応 | 小〜中 |
| API | `/api/remote/devices`（GET）/ `/api/remote/devices/:id`（DELETE） | 小 |
| CLI | `remote devices` / `remote revoke <id>` | 小 |
| テスト | 認証の回帰は**壊すと直ちに脆弱性**。middleware・ws・login・IP 制限の既存スイートを含め広範囲 | 大 |

Phase 1 の総量が体感で 2 倍以上になり、かつ**最も壊してはいけない層**（認証）に触る。

### 3.3 決定

**Phase 1 に入れない。** Phase 1 の失効モデルは次の 3 つだけとする。

1. `commandmate remote stop` — サーバを止める。トークンは env にしか無いのでプロセス終了で消える
2. **期限切れ** — `CM_AUTH_EXPIRE` を remote セッション TTL（既定 8h）に設定して起動する。`computeExpireAt()` が起動時に固定するので、期限後は middleware も `verifyToken` も一律に false を返す
3. **ペアリングコードの失効** — 一度使用 or TTL（既定 10 分）超過（§7.4）

`remote devices` / `remote revoke` は Phase 1 の CLI に**存在させない**（`--help` にも出さない）。中途半端な `devices`（＝「1 台としか言えない」出力）を出す方が、後で本物を出すときに互換の足枷になる。

### 3.4 失うもの（明示）

| 失うもの | 影響 | Phase 1 での緩和 |
|---|---|---|
| 端末を 1 台だけ失効させられない | 1 台のスマホを紛失したら、`remote stop` で**全端末が同時に落ちる**（PC のブラウザセッションを含む） | `remote stop` は 1 コマンドで、再ペアリングも 1 コマンド。TTL 既定 8h で被害窓を縛る |
| どの端末が繋がっているか一覧できない | 「知らない端末が繋がっていないか」を CommandMate 側で確認できない | Provider 側で見える（Tailscale のデバイス一覧）。`remote status` は**接続端末数ではなく Provider・URL・期限・ペアリング残数**を表示する（§5.1） |
| ペアリング済み端末の識別子が無い | 監査ログに「どの端末が」を書けない | ペアリング成功／失敗のイベントは `logSecurityEvent()` に記録する。**コードやトークンは記録しない** |
| 「PC 側で承認」ステップ（Issue の想定 UX 3 番）が成立しない | 端末 ID が無いので、承認しても「何を」承認したのか特定できない | **Phase 1 では承認ステップを設けない**。ペアリングコードが PC の画面にしか出ない事実が物理的近接の担保になる。承認 UI は Phase 2 で端末 ID とセットで入れる |

### 3.5 Phase 2 のために Phase 1 で作っておく足場

Phase 1 で以下を満たしておけば、Phase 2 は「credentials の中身の差し替え」で済む。

- ペアリングのエンドポイントを **`POST /api/remote/pair` として先に切る**（Phase 2 で応答が端末クレデンシャルに変わっても URL は変わらない）
- ペアリング結果は**必ず cookie で渡し、レスポンスボディにクレデンシャルを載せない**（Phase 2 で cookie の中身が変わっても、クライアント側は無改修）
- `remote` の状態ファイルに **`schemaVersion` を持たせる**（Phase 2 で端末リストを足す余地）
- CLI のサブコマンドは `remote <verb>` の形にしておく（`devices` / `revoke` を後から足せる）

---

## 4. Phase 1 スコープの確定

Issue の MVP リストに対する採否。

| # | MVP 項目 | 採否 | 補足 |
|---|---|---|---|
| 1 | `commandmate remote` コマンド | **入れる** | §5 |
| 2 | CommandMate サーバーの起動確認 | **入れる** | 既存 `DaemonManager.isRunning()` / `waitForServer()` を再利用 |
| 3 | Tailscale / cloudflared の検出 | **入れる** | `PreflightChecker` と同じ `spawnSync(cmd, [versionArg])` 方式（§6.2） |
| 4 | Tailscale Serve の設定 | **入れる** | §6.4 |
| 5 | Cloudflare Quick Tunnel の明示承認付き起動 | **入れる** | 非対話環境では `--provider cloudflare --yes` が無い限り**拒否**（exit 2） |
| 6 | HTTPS URL の取得 | **入れる** | §6.4 |
| 7 | 一時ペアリングコードの生成 | **入れる** | §7 |
| 8 | ターミナルへの URL・QR 表示 | **入れる** | 依存の選定は U-1 |
| 9 | スマホからの認証済み接続 / WS 疎通 | **入れる** | cookie は既存経路にそのまま乗る（§8） |
| 10 | 有効期限による自動停止 | **入れる** | ただし**「サーバを落とす」ではなく「Provider を閉じる」**（§5.3）。トークン自体は `CM_AUTH_EXPIRE` で独立に失効する |
| 11 | `remote status` / `remote stop` | **入れる** | §5.1 |
| 12 | 作成した Tunnel・Serve 設定の安全なクリーンアップ | **入れる** | §6.3。**本 Issue で最も壊すと痛い部分** |
| 13 | PWA 追加・Push 通知設定への案内 | **入れる（案内テキストのみ）** | ペアリング成功画面に既存の通知設定への導線を出すだけ。Push の実装には触らない |
| — | `remote devices` / `remote revoke` | **落とす** | 決定 B（§3） |
| — | PC 側での承認ステップ | **落とす** | §3.4 |
| — | `--auto-yes` / `--auto-yes-expires` | **落とす** | Auto-Yes は in-memory で起動時 OFF。`remote` から有効化する手段を作らない方が Issue のセキュリティ要件に沿う（§5.5） |
| — | Provider の追加（ngrok 等） | **落とす** | Issue が MVP 対象外と明記 |

---

## 5. `commandmate remote` の CLI 設計

### 5.1 サブコマンド構成

```
commandmate remote                     # 既定動作 = up（起動 + ペアリング）
commandmate remote status              # Provider / URL / 期限 / ペアリング状態
commandmate remote stop                # Provider を閉じ、CommandMate が作った設定だけを片付ける

# オプション（remote 直下）
  --provider <tailscale|cloudflare>    # 自動選択を上書き
  --expires <duration>                 # remote セッション TTL（既定 8h。parseDuration の 1h〜30d 制約に従う）
  --pairing-expires <duration>         # ペアリングコード TTL（既定 10m）
  -p, --port <number>                  # start へ委譲
  --yes                                # Quick Tunnel の明示承認をコマンドラインで与える（非対話環境で必須）
  --json                               # 機械可読出力（status / up 共通）
```

`instances` が `commandmate instances <id> [add|remove|alias|kill]` の形で「既定はリスト、動詞は任意引数」を採っているのと同じ構造にする。`remote` は既定が `up` である点だけが違う。

**`--token` は持たせない。** `remote` は自分でトークンを生成する側であり、外から与えられたトークンで動く必要がない（§5.3）。

### 5.2 どのコマンドの形に倣うか

| 側面 | 倣う先 | 理由 |
|---|---|---|
| commander への登録 | `createSyncCommand()` / `createInstancesCommand()` の **factory + `addCommand()`** パターン（`[DR1-08]`） | `program.ts` の既存の登録と一貫。`startCommand` 系の直接 `.command()` 形式は init/start/stop/status の 4 本の旧式 |
| 副作用の分離 | `start.ts` の **`runStart()`（exit しない）＋ `startCommand()`（exit する）** の 2 段構え（#1195） | `remote` は内部で start を呼ぶので、**exit しない核**が必須 |
| 長時間処理の逐次表示 | `quickstart.ts`（`ensureConfiguration` → `ensureServerRunning` → `waitUntilReady` → ブラウザ起動） | Issue の想定 UX の `✓` 行がそのままこの形 |
| 依存検出 | `PreflightChecker.checkDependency()`（`spawnSync(cmd, [versionArg], {timeout: 5000})`、`MF-SEC-1` で shell を使わない） | Provider 検出をこれに揃える |
| 状態の永続化 | `PidManager` / `DaemonState`（1 行目 素の PID ＋ 2 行目 JSON、#1632） | `remote` の状態ファイルも同形式にし、旧 CLI が読んでも壊れないようにする |
| exit code | `src/cli/types` の `ExitCode` | 既存値のみ使う（下記） |
| エラー処理 | `handleCommandError()`（`ApiError` を exit code に写像） | 既存と同じ |
| 監査ログ | `logSecurityEvent({timestamp, command, action, details})` | `command: 'remote'` で記録。**コード・トークンは details に入れない** |

**exit code の割り当て**（新規は足さない）:

| 状況 | code |
|---|---|
| 成功 | `SUCCESS` (0) |
| Provider が 1 つも見つからない | `DEPENDENCY_ERROR` (1) |
| 非対話環境で Quick Tunnel の承認が無い / `--expires` が不正 | `CONFIG_ERROR` (2) |
| サーバ起動失敗 | `START_FAILED` (3) |
| `remote stop` の片付け失敗 | `STOP_FAILED` (4) |
| 想定外 | `UNEXPECTED_ERROR` (99) |

### 5.3 `start` との関係

**`remote` は `start` を「呼ぶ」。別プロセスの並走にはしない。**

```
commandmate remote
  1. 依存検出（tailscale / cloudflared）
  2. 既存サーバの確認: DaemonManager.isRunning()
       running かつ auth 無効 → 停止して張り直すか尋ねる（非対話なら CONFIG_ERROR）
       running かつ auth 有効 → 平文トークンを持たないので再利用できない旨を告げて中断（U-4）
       stopped → 次へ
  3. token = generateToken();  hash = hashToken(token)
  4. pairingCode = 生成;  pairingHash = hashToken(pairingCode)
  5. runStart({ daemon: true, port, ... }) を、次の env を追加して呼ぶ
       CM_AUTH_TOKEN_HASH      = hash        （既存。start --auth と同じ）
       CM_AUTH_EXPIRE          = --expires   （既存）
       CM_REMOTE_PAIRING_FILE  = <path>      （新規。**秘匿値ではなくパス**）
     併せて <path> に mode 0600 で次を書く（§7.2）:
       { schemaVersion, pairingHash, expiresAt, sessionToken }
  6. waitForServer()
  7. Provider.start({ port })  → URL
  8. 状態ファイル書き出し
  9. QR 表示（URL + '/login#code=' + pairingCode）
```

理由:

- **`start` を再実装しない**。`runStart()` は既に「exit せず `StartResult` を返す」ため（#1195 で quickstart のために切り出し済み）、そのまま合成できる
- **`--daemon` で起こす**。`remote` 自身は Provider の子プロセス（cloudflared）を見張る必要があるので、Next サーバを前面に置くと両方を 1 プロセスで面倒見ることになる
- **サーバ側に平文トークンを渡す必要がある**（§1.2 C の帰結）。これは `runStart` を呼ぶ側でしかできない。既存サーバへ後付けできないのが「running かつ auth 有効なら中断」の理由。ただし**渡し方は env ではなく 0600 のファイル**にする（§7.2）

**「有効期限による自動停止」の意味**: `--expires` は 2 つの別々のものを同時に決める。

| 対象 | 仕組み | 誰が止めるか |
|---|---|---|
| **認証トークン** | `CM_AUTH_EXPIRE` → `computeExpireAt()` が起動時に固定 | サーバ自身。プロセスが生きていても期限後は全て 401 |
| **Provider（外部への口）** | `remote` が持つタイマー、または `remote status` 実行時の期限判定 | `remote` プロセス。期限で Provider を閉じる |

**サーバ自体は落とさない。** `remote` の期限切れで `commandmate stop` 相当が走ると、PC のローカル利用まで巻き添えで死ぬ。外部への口だけを閉じる。

### 5.4 `remote status` の出力

```
Provider:        tailscale-serve
URL:             https://my-mac.example-tailnet.ts.net
Remote expires:  2026-08-25T21:14:00Z (in 6h 12m)
Pairing:         consumed        # unused | consumed | expired
Server:          running (pid 84890, 127.0.0.1:3000, auth: on)
```

`--json` は同じ内容をそのまま返す。**URL は出すが、ペアリングコードもトークンも出さない**（コードは `up` の 1 回だけ端末に表示される）。

### 5.5 Auto-Yes

Auto-Yes の状態は `globalThis.__autoYesStates` の in-memory Map であり、**サーバ起動時は必ず空**である。
`remote` はサーバを起こすので、Issue の受入条件「Remote 利用時の Auto Yes は既定で無効になる」は構造的に満たされる。

設計上やることは 2 つだけ:

1. `remote` に `--auto-yes` 系のフラグを**作らない**
2. 「`remote` が起動時に渡す env に Auto-Yes を有効化するキーが含まれない」ことをテストで固定する（§9.2）

---

## 6. Provider 抽象

### 6.1 interface

```ts
/** 1 回の remote セッションで CommandMate が Provider に作らせたものの手形 */
export interface RemoteHandle {
  provider: RemoteProviderId;          // 'tailscale-serve' | 'cloudflare-quick'
  url: string;                          // https://...
  /** CommandMate が作ったものだけを識別する情報。stop はこれ以外に触らない */
  owned: {
    /** 自分が起動した子プロセス。無ければ null（Tailscale Serve は常駐 daemon 側に載る） */
    pid: number | null;
    /** Provider 固有の「戻し方」。Tailscale なら off にすべき対象、Cloudflare なら無し */
    revert: Record<string, string> | null;
  };
  /** 起動直前に採った Provider 側の状態。stop の際、ここに在ったものは触らない */
  preexisting: unknown;
}

export interface RemoteProvider {
  readonly id: RemoteProviderId;
  /** 実行ファイルの有無と「使える状態か」を判定。副作用を持たない */
  detect(): Promise<ProviderDetection>;   // { available, version?, ready, reason? }
  /** 127.0.0.1:port を外へ出す。必ず RemoteHandle を返す */
  start(opts: { port: number; signal: AbortSignal }): Promise<RemoteHandle>;
  /** handle.owned だけを片付ける。preexisting に在ったものには触らない */
  stop(handle: RemoteHandle): Promise<StopOutcome>;  // { reverted, skipped[], warnings[] }
}
```

`detect()` が `available`（実行ファイルがある）と `ready`（使える状態にある）を分けるのが要点。
Tailscale はインストール済みでもログインしていなければ Serve は張れない。この 2 値があると、
Issue の Provider 選択ルール（Tailscale → cloudflared → 案内）がそのまま `ready` の判定で書ける。

### 6.2 責務境界

| 責務 | 置き場所 | 理由 |
|---|---|---|
| 実行ファイルの存在判定 | Provider の `detect()`。実装は `PreflightChecker.checkDependency()` と同じ `spawnSync(cmd, [versionArg], {timeout: 5000})` | shell を挟まない（`MF-SEC-1`） |
| 「使える状態か」の判定 | Provider の `detect()` | Provider 固有。Tailscale は `tailscale status`、Cloudflare は常に ready |
| **Provider の選択** | Provider の**外**（`src/cli/commands/remote.ts` のオーケストレータ） | 「Tailscale が駄目でも自動で公開 Tunnel へ切り替えない」という Issue の要件は**選択の規則**であって Provider の性質ではない。承認プロンプトを Provider の中に置くと、非対話判定が Provider ごとに散る |
| URL の取得 | Provider の `start()` の内側 | 取得手段が Provider ごとに全く違う（§6.4） |
| **起動前スナップショット** | Provider の `start()` の内側（`RemoteHandle.preexisting` に載せて返す） | 撮り方が Provider 固有。ただし**返す義務は interface が課す** |
| 状態の永続化 | オーケストレータ | Provider は状態ファイルの場所を知らない |
| 期限監視・停止の駆動 | オーケストレータ | Provider は「止めろと言われたら止める」だけ |
| 片付け | Provider の `stop()` | ただし**入力は必ず `RemoteHandle`**（§6.3） |

### 6.3 「CommandMate が作成していない設定を消さない」の機械的保証

方針を 4 つの**構造上の制約**に落とす。文書上の注意書きにはしない。

1. **`stop()` の入力は `RemoteHandle` のみ**。「現在の Provider の設定を全部読んで消す」という書き方が型で不可能になる。`RemoteProvider` に `reset()` / `cleanupAll()` の類のメソッドを**置かない**
2. **起動前スナップショットを必須にする**。`start()` は `preexisting` を埋めて返さねばならない。`stop()` は `owned` に在り、かつ `preexisting` に無いものだけを戻す。両方に在るなら **skip して `StopOutcome.skipped` に積む**（＝人間に見えるようにする）
3. **全消しコマンドを lint で禁止する**。`tailscale serve reset` / `cloudflared tunnel cleanup` に相当する文字列を `src/lib/remote/**` で禁止する ESLint ルール（もしくはガードテスト）を置く。**陽性対照**（禁止語を 1 箇所に入れると赤くなること）を同じテストで確認する — メモリにある「grep の 0 件は存在しないことの証明にならない」の轍を踏まないため
4. **状態ファイルが無ければ何もしない**。`remote stop` は状態ファイルが読めないとき、Provider を推測して片付けにいかない。「片付けるものが分からない」と言って `SUCCESS` で終わる（`stop.ts` が stale PID file を `SUCCESS` で返すのと同じ姿勢）

状態ファイル: `~/.commandmate/remote.json`（`getEnvPath()` と同じ `~/.commandmate` 配下）。
`PidManager` と同じハイブリッド形式にはせず（PID を主体としないため）、素の JSON に `schemaVersion` を持たせる。

### 6.4 各 Provider の実測メモ

#### Tailscale Serve

この開発機に `tailscale` は**無い**（`which tailscale` が空）。以下は設計上の想定であり、**実装時に実機で確定する**（U-2）。

| 局面 | 想定 |
|---|---|
| detect（available） | `tailscale version` |
| detect（ready） | `tailscale status --json` でログイン状態と MagicDNS 名を取る |
| snapshot | `tailscale serve status --json`（**既存の serve 設定をそのまま保存**） |
| start | `tailscale serve --bg <port>` 相当 |
| URL | `tailscale status --json` の DNSName、または `tailscale serve status --json` の応答 |
| stop | **CommandMate が張ったハンドラのみを off にする**。`tailscale serve reset` は使わない（禁止語） |

**最大のリスクは stop**。Tailscale Serve の設定は tailscaled が持つ**永続設定**であり、利用者が既に別サービスを Serve していることがあり得る。`preexisting` に在った設定を 1 つでも消したら回復手段が無い。

#### Cloudflare Quick Tunnel

この開発機に `cloudflared 2025.4.0` が存在。バイナリの文字列表から確認できたこと:

- `--url` / `--metrics <addr>` / `--pidfile <path>` / `--no-autoupdate` を持つ
- `/quicktunnel`・`/ready`・`/healthcheck` のパス文字列と `https://api.trycloudflare.com` を含む
- `Requesting new quick Tunnel on trycloudflare.com...` と `Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):` を含む

| 局面 | 設計 |
|---|---|
| detect | `cloudflared --version` |
| snapshot | **不要**（Quick Tunnel は永続設定を作らない。`preexisting: null`） |
| start | `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate --metrics 127.0.0.1:<自前で選んだ空きポート> --pidfile <state dir>/cloudflared.pid` |
| URL | **`--metrics` のローカル HTTP（`/quicktunnel`）から取るのを第 1 候補**、stderr バナーの scraping を第 2 候補（U-3）。バナー scraping は文言変更で腐るため主経路にしない |
| stop | 自分が起動した子プロセスに SIGTERM（`owned.pid`）。プロセスが死ねば URL は失効する |
| 承認 | **起動前に必ず明示承認**。非対話なら `--yes` が無い限り `CONFIG_ERROR`。承認文言は `security-messages.ts` に定数として置く（`REVERSE_PROXY_WARNING` と同じ場所・同じ形） |

`--metrics` に **`127.0.0.1:` を明示する**のが重要。help の記述によれば、metrics のアドレスは仮想環境下で全インタフェースに bind することがあり得る。CommandMate 本体の `CM_BIND` を守っているのに Provider の metrics で穴を開けては本末転倒である。

---

## 7. ペアリングコードのライフサイクル

### 7.1 生成とエントロピー

- 生成は **`generateToken()` を再利用**（`crypto.randomBytes(32)` の hex 64 文字）。ただしそのままでは QR が無駄に大きく、URL も長い
- **表示に使うのは先頭 128 bit を Crockford Base32 で 26 文字にしたもの**とする。128 bit は 10 分の TTL・1 度限り・レート制限つきの用途に対して十分に過大である
- **上限も決める**: 生成に失敗する条件は無いが、`/api/remote/pair` 側の入力長上限は `/api/auth/login` の 256 文字上限に倣う

### 7.2 保存先

**まず「env に置かない」を決める。** §1.2 C により、cookie に入れるべき平文トークンをサーバが知っている必要がある。
素直な実装は `CM_REMOTE_SESSION_TOKEN` を起動 env に載せることだが、**それは採らない**。理由は §1.3 の実測:

> `src/lib/tmux/**` は子プロセスに `env:` を渡さない。tmux の pane は**サーバの環境変数をそのまま継承する**。
> `sanitizeEnvForChildProcess()` は `slash-command-catalog.ts` と `assistant/non-interactive-runner.ts` の
> 2 箇所でしか呼ばれておらず、エージェントの pane はそこを通らない。

つまり env に置いた瞬間、**CommandMate が動かしている Claude / Codex / OpenCode 自身がその値を読める**。
`CM_AUTH_TOKEN` が #1996 で `SENSITIVE_ENV_KEYS` に後から足されたのは、まさにこれが実子プロセスで実測されたためである。
Remote は「外から届く経路」を新設する機能なので、その資格情報をエージェントの実行環境に置くのは筋が悪い。

代わりに **1 度限りのハンドオフファイル**を使う。

| 何を | どこに | 理由 |
|---|---|---|
| ペアリングコードの**平文** | **どこにも保存しない**。`remote` プロセスのメモリ上にだけ存在し、QR にして端末へ出したら捨てる | 保存すれば漏洩面が増える。再表示は「もう一度 `remote` を実行する」で足りる |
| ペアリングコードの**ハッシュ**、有効期限、**長期トークンの平文** | **1 つのハンドオフファイル**（`~/.commandmate/remote-pairing.json`、mode **0600**）。パスだけを env `CM_REMOTE_PAIRING_FILE` で渡す | サーバは起動時にしか値を受け取れず、かつ env には置きたくない。パスは秘匿値ではないので pane に継承されても害は無い |
| **消費済みフラグ** | **ファイルの不在そのもの**。ペアリング成功と同時に `unlinkSync` する | モジュールレベル変数を使わない理由が 2 つある。(1) `server.ts` の module registry と Next の route handler の bundle は**別インスタンス**なので、`server.ts` 側で読んで変数に持っても route からは見えない。(2) ファイル削除なら**消費と同時に平文が消える**ので、露出時間が「remote 起動〜初回ペアリング」に縮む |

**ファイルは route handler が読む。** `POST /api/remote/pair` が毎リクエストで `CM_REMOTE_PAIRING_FILE` を読み、
検証に成功したら **cookie を作る前に unlink する**。読めなければ（＝存在しない）そのまま 404 / 410 になる。

この形の効果:

- サーバの env に増える秘匿値は **0 件**。`SENSITIVE_ENV_KEYS` を触る必要が無い（U-5 は「触らなくてよいことの確認」に縮む）
- 平文トークンがディスクに存在する時間は **remote 起動から初回ペアリングまで**（既定でも最大 10 分＝ペアリング TTL。TTL 切れ時と `remote stop` でも削除する）
- 同一 UID のエージェントは原理的にこのファイルを読めるが、**露出窓がサーバの生存期間全体（remote セッションの 8 時間を超えうる）から数分に縮む**うえ、`env` ダンプ・ログエクスポート・プロセス一覧のいずれにも現れない

### 7.3 一度限りの消費

新設するエンドポイントは **1 本だけ**: `POST /api/remote/pair`（`AUTH_EXCLUDED_PATHS` に追加）。
ペアリング**画面**は新設せず、既存の `/login`（既に excluded）を `#code=` で流用する（§2.3）。

```
POST /api/remote/pair   { code: string }

  0. env CM_REMOTE_PAIRING_FILE が無ければ 404     ← remote が動いていないときは存在しないのと同じ
  1. createRequestRateLimiter() で固定キーのレート制限   ← /api/auth/login の RATE_LIMIT_KEY = 'global' と同じ判断
                                                          （X-Forwarded-For は信頼しない）
  2. typeof code === 'string' && code.length <= 256
  3. ハンドオフファイルを読む。無い／壊れている → 410 Gone   ← 消費済みはここに落ちる
  4. Date.now() > expiresAt なら unlink して 410 Gone
  5. hashToken(code) を timingSafeEqual で pairingHash と比較。不一致は 401
  6. unlinkSync(file)          ← 比較成功の直後、cookie を作る前に消す
  7. cookies.set(AUTH_COOKIE_NAME, sessionToken, buildAuthCookieOptions(getTokenMaxAge()))
  8. 200 { success: true }     ← ボディにトークンを載せない
```

- **失敗も成功もレスポンスに区別可能な情報を最小化する**（410 と 401 の出し分けは、既に「コードを持っている人」にしか意味がない）
- **6 を 7 より前に置く**のが一度限りの本体。cookie 生成で例外が出ても、ファイルは消えている（fail-closed）
- **`sessionToken` は 6 の前にメモリへ読み出しておく**（unlink 後に読めなくなるため）。関数のローカル変数に留め、モジュールレベルに残さない
- 成功／失敗は `logSecurityEvent` に記録するが、**コードもトークンも details に入れない**

### 7.4 失効

| 契機 | 効果 |
|---|---|
| 1 度の使用 | ハンドオフファイルを unlink。以後は「読めない」＝ 410 |
| TTL 超過（既定 10 分、`--pairing-expires`） | 410 |
| `remote stop` / サーバ停止 | ハンドオフファイルを削除する。サーバのプロセス消滅で平文トークンはメモリからも消える |
| `CM_AUTH_EXPIRE` 超過 | ペアリングに成功しても、cookie の値は `verifyToken` / middleware の期限判定で一律 false になる |

### 7.5 `src/lib/security/` の再利用と新規

| 部品 | 扱い |
|---|---|
| `generateToken()` | **再利用**（トークン／ペアリングコードの原資） |
| `hashToken()` | **再利用**（コード比較・トークンハッシュ） |
| `buildAuthCookieOptions()` | **再利用**。`HttpOnly` / `SameSite=strict` / `Secure=isHttpsEnabled()` が既に要件を満たす |
| `getTokenMaxAge()` | **再利用**（cookie の maxAge） |
| `parseDuration()` / `computeExpireAt()` | **再利用**（`--expires`。1h〜30d の制約もそのまま適用） |
| `createRequestRateLimiter()` | **再利用**（ペアリング試行のレート制限） |
| `verifyToken()` / `middleware.ts` の検証 | **触らない**（§9.1） |
| `AUTH_EXCLUDED_PATHS` | **1 要素だけ追加**（`/api/remote/pair`） |
| `logSecurityEvent()` | **再利用**（`command: 'remote'`） |
| `env-sanitizer.ts` の `SENSITIVE_ENV_KEYS` / `log-export-sanitizer.ts` | **触らない**。§7.2 の決定により秘匿値を env に置かないため。ただし「置いていないこと」をテストで固定する（U-5） |
| ペアリングコードの生成・消費、ハンドオフファイルの読み書き | **新規**: `src/lib/security/pairing-code.ts`（Node ランタイム限定。Edge からは使わない） |
| Provider 抽象 | **新規**: `src/lib/remote/{types,tailscale,cloudflare,provider-registry}.ts` |

**`Secure` フラグの注意**: `buildAuthCookieOptions()` の `secure` は `isHttpsEnabled()`＝`CM_HTTPS_CERT` の有無で決まる。
Tunnel / Serve 越しは**外側が HTTPS でオリジンは平文 HTTP** なので、`CM_HTTPS_CERT` は立たず `Secure` が付かない。
これは Tunnel 構成では正しい挙動（`Secure` を立てると 127.0.0.1 の HTTP では cookie が拒まれる）だが、
**設計上の判断として明記しておく**必要がある。U-6 に上げた。

---

## 8. 認証フローの図

```
PC (commandmate remote)                サーバ (Next.js, 127.0.0.1:3000)          スマホ
──────────────────────────             ─────────────────────────────────        ────────────
token   = generateToken()
code    = pairingCode()

~/.commandmate/remote-pairing.json  (mode 0600)
  { pairingHash: sha256(code), expiresAt, sessionToken: token }

runStart({daemon:true}) ────────────►  起動 env（**秘匿値なし**）:
                                         CM_AUTH_TOKEN_HASH     = sha256(token)
                                         CM_AUTH_EXPIRE         = 8h
                                         CM_REMOTE_PAIRING_FILE = <上のパス>

Provider.start({port}) ──► https://host.ts.net ──► 127.0.0.1:3000

QR = https://host.ts.net/login#code=<code>
  │
  └───────────── 画面に表示 ─────────────────────────────────────────────────►  QR 読取

                                                        GET /login  ◄────────── 遷移
                                       （/login は AUTH_EXCLUDED_PATHS。素通し）
                                                                     ──────────► 画面表示

                                                 useFragmentLogin:
                                                   history.replaceState() で #code= を消す
                                                   POST /api/remote/pair {code}  ◄──

                                       /api/remote/pair （AUTH_EXCLUDED_PATHS）
                                         rate limit → 長さ検査
                                         → ハンドオフファイル読取（無ければ 410 = 消費済み）
                                         → 期限判定
                                         → timingSafeEqual(sha256(code), pairingHash)
                                         → unlink(ファイル)          ← 一度限りの本体
                                         → Set-Cookie: cm_auth_token = sessionToken
                                                       HttpOnly; SameSite=Strict; Max-Age=残り
                                         → 200 {success:true}         ──────────► cookie 保存

                                                        GET /  ◄─────────────── 遷移
                                       middleware (Edge):
                                         IP 制限 → excluded? → cookie を sha256
                                         → XOR 定数時間比較 vs CM_AUTH_TOKEN_HASH → 通過
                                                                     ──────────► アプリ表示

                                                 WS upgrade  ◄────────────────── 接続
                                       ws-server (Node):
                                         isAuthEnabled() → parseCookies()
                                         → verifyToken() → timingSafeEqual → 通過
                                                                     ──────────► ターミナル
```

**この図の要点は「新しい認証経路を作っていない」こと**である。
新規なのは `POST /api/remote/pair` の 1 本だけで、そこから先は `#383` 以来の cookie 経路にそのまま合流する。
middleware も ws-server も無改修で通る。

---

## 9. `CM_BIND` の既定 127.0.0.1 を壊さないことの担保

### 9.1 触らないもの（変更禁止リスト）

| 対象 | 理由 |
|---|---|
| `server.ts` の `const hostname = getEnvByKey('CM_BIND') \|\| '127.0.0.1'` | ここが既定の唯一の出所 |
| `src/cli/utils/env-setup.ts` の `ENV_DEFAULTS.CM_BIND` および `init.ts` の書き出し | `init` が `.env` に書く既定値 |
| `src/middleware.ts` の検証ロジック | ペアリングは middleware を通らない（excluded path）ので改修不要。**触らないことが最大の安全策** |
| `src/lib/security/auth.ts` の `verifyToken` / `storedTokenHash` / `expireAt` | 決定 B により Phase 1 では多クレデンシャル化しない |
| `src/lib/ws-server.ts` の upgrade 認証 | 同上 |
| `REVERSE_PROXY_WARNING` の内容と発火条件 | `remote` は `--auth` 相当で起動するので元々この経路に入らない |

`remote` が起動 env に足すのは `CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE`（どちらも `start --auth` が既に使う既存キー）と、
**秘匿値ではないパス** `CM_REMOTE_PAIRING_FILE` の 3 つだけである。

**`remote` は `CM_BIND` を読まないし書かない。** Provider は `http://127.0.0.1:<port>` を固定でアップストリームにする。
`CM_BIND=0.0.0.0` で既に運用している人が `remote` を使っても、`remote` はその設定を変えない（外へ出す口を増やすだけ）。

### 9.2 固定するテスト

| 固定したいこと | テスト |
|---|---|
| `remote` が起動時 env に `CM_BIND` を含めない | 新規。`runStart` をモックし、渡された env のキー集合を assert |
| **`remote` が起動時 env に秘匿値を入れない** | 新規。渡された env のキー集合が `CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE` / `CM_REMOTE_PAIRING_FILE`（＋ `start` 由来の既存キー）に**完全一致**することを assert。`agent-launch-plan-secrets-1933.test.ts` が `prepareLaunch` の env キーを完全一致で固定しているのと同じ形 |
| **ハンドオフファイルが 0600 で作られ、ペアリング成功で消える** | 新規。`statSync().mode & 0o777 === 0o600`、および 200 応答後に `existsSync() === false` |
| `remote` が起動時 env に Auto-Yes 有効化キーを含めない | 新規。同上 |
| Provider のアップストリームが常に `127.0.0.1` | 新規。`start()` に渡るコマンド引数を assert（`0.0.0.0` / `localhost` を明示的に禁止） |
| cloudflared の `--metrics` が `127.0.0.1:` で始まる | 新規。同上 |
| `CM_BIND` 既定 `127.0.0.1` の解決 | **既存を壊さないことで担保**: `tests/unit/env.test.ts`、`tests/unit/cli/utils/server-url.test.ts`（`resolveServerEndpoint` の 9 ケース。`0.0.0.0` は `127.0.0.1` へダイヤル）、`tests/unit/cli/utils/api-client.test.ts`、`tests/unit/cli/utils/daemon.test.ts`、`playwright.config.ts` の `CM_BIND: '127.0.0.1'` |
| `AUTH_EXCLUDED_PATHS` に増えたのが 1 本だけ | 新規。配列の完全一致で固定する（S002 の完全一致方針と整合。**増やすときにテストが必ず目に入る**） |
| Provider の `stop()` が全消しコマンドを撃たない | 新規のガードテスト。**陽性対照つき**（禁止語を 1 箇所に入れると赤くなることを同じテストで確認） |

---

## 10. 対象外

- 公式 Managed Relay / CommandMate アカウント / Relay 経由の E2E 暗号化 / `commandmate.app` 配下の固定 URL / チーム共有 / 複数ユーザー権限 / Passkey・生体認証 / 複数 PC の統合管理 / Provider の追加 / 課金 — **Issue が MVP 対象外と明記しているため本書では設計しない。**

---

## 11. 未解決の論点（実装時に実測が要る）

| ID | 論点 | なぜ設計で決められないか | 実装時にやること |
|---|---|---|---|
| **U-1** | ターミナル QR の依存 | `react-qr-code` は React 専用で CLI から使えない。推移依存に `qr.js@0.0.0` があるが**未保守の 0.0.0 を直接依存に昇格**するのは判断が要る。`qrcode` などの新規依存は CLI の起動時間とインストールサイズに効く | 候補を実測比較する: (a) `qr.js` を直接依存化、(b) `qrcode` を追加、(c) 自前エンコード。**判定軸は「バンドルサイズ」「`build:cli`（`tsconfig.cli.json`）で型が通るか」「半角ブロック文字で 200 桁未満の端末に収まるか」** |
| **U-2** | Tailscale の実際のコマンド体系 | この開発機に `tailscale` が無く、`serve` のサブコマンド構文・`serve status --json` の有無・`--bg` の挙動・off の指定方法を**推測でしか書けない**。バージョン差も大きい領域 | Tailscale を入れた実機で `tailscale serve --help` / `serve status --json` / 既存 serve がある状態での off を採取し、§6.4 の表を実測値で置き換える。**既存 serve 設定を持つ環境での stop を必ず試す**（壊すと回復手段が無いため） |
| **U-3** | Quick Tunnel の URL 取得経路 | バイナリに `/quicktunnel` の文字列があることは確認したが、**それが `--metrics` のサーバに生えている HTTP ルートであることまでは未確認**。stderr バナーは文言変更で腐る | `cloudflared tunnel --url http://127.0.0.1:<port> --metrics 127.0.0.1:<port2>` を実際に起動し、`GET http://127.0.0.1:<port2>/quicktunnel` の応答形を採取する。**公開 Tunnel を作る操作なので、実行前に利用者の承認を取る**。取れなければ第 2 候補（stderr）へ落とし、その旨をコメントに残す |
| **U-4** | 「サーバが既に `--auth` 付きで動いている」場合の扱い | 既存サーバは `CM_REMOTE_PAIRING_FILE` を持たず、env は起動後に足せないため、ペアリングエンドポイントが 404 のままになる。中断が正しいか、停止して張り直すのが正しいかは UX 判断 | 実機で挙動を確認し、**対話なら「停止して張り直す？」を尋ね、非対話なら `CONFIG_ERROR`** の線で確定させる |
| **U-5** | ハンドオフファイルの露出 | §7.2 で秘匿値を env から追い出したので `SENSITIVE_ENV_KEYS` は触らずに済む**はず**だが、それは「実装が本当に env に入れていない」ことが前提。また 0600 ファイルは同一 UID のエージェントからは原理的に読める | (1) 起動 env のキー集合を完全一致で固定するテストを置く（§9.2）。(2) **実際に `commandmate remote` を動かした状態で、tmux pane から `env | grep -i token` と `cat $CM_REMOTE_PAIRING_FILE` を撃ち**、前者が空・後者はペアリング後に ENOENT になることを実測する。(3) ペアリング前に読めてしまう窓が許容できるか、実測値（何分開くか）を見て判断する |
| **U-6** | Tunnel 越しの `Secure` 属性 | `buildAuthCookieOptions()` の `secure` は `CM_HTTPS_CERT` の有無で決まる。Tunnel 構成ではオリジンが平文 HTTP なので `Secure` が付かない。**Issue の要件「Cookie は Secure」と実装の既定が食い違う** | 実機で「`Secure` を立てると 127.0.0.1 の HTTP アクセスで cookie が落ちる」ことを確認したうえで、(a) 現状維持＋docs に明記、(b) remote セッション時だけ `Secure` を立て、ローカル HTTP アクセスは別扱いにする、のどちらかを決める |
| **U-7** | Edge サンドボックスの env スナップショットの本番挙動 | ソース（`buildEnvironmentVariablesFrom` / `moduleContexts`）からは「コピー＋キャッシュ」と読めるが、**production build の実機で 1 回確認していない** | 起動後に Node 側で `process.env.CM_AUTH_TOKEN_HASH` を書き換え、middleware の判定が変わらないことを実機で 1 回確認する。**決定 B の根拠なので、ここが覆るなら §3 を書き直す** |
| **U-9** | `server.ts` と Next route handler のモジュール分離 | §7.2 は「`server.ts` 側のモジュールレベル変数は route handler から見えない」（tsconfig.server.json でビルドされる側と Next の bundle は別インスタンス）という前提で、ファイル方式を選んでいる。**ソースの構成からはそう読めるが実測していない** | route handler から `server.ts` 由来のモジュール状態が見えるかを 1 回確認する。**見えるなら**ファイル方式のままでも損は無い（露出窓が縮む利点は残る）ので設計変更は不要。見えないことの確認は、他の Issue でも効く知見 |
| **U-8** | WSL2 / Linux での Provider 可用性 | 受入条件が「macOS／Linux／WSL2 について対応可否と制約が明記される」を要求している。WSL2 は `localhost` 転送の構成差が大きく（`docs/user-guide/wsl2-setup.md` が「localhost が効かない場合」の節を持っている）、Tunnel のアップストリーム `127.0.0.1` が WSL2 内部を指すのか Windows 側を指すのかが構成依存 | 3 環境で `remote` を通し、**対応可否の表を docs に書く**。効かない構成では明示的に理由を出して落とす（黙って別インタフェースに逃げない） |

---

## 12. 実装 Issue への分割案

Phase 1 を実装可能な粒度に割った。**次回の並列開発の入力**である。

| # | 目的 | 主な影響ファイル | 依存 | 想定規模 |
|---|---|---|---|---|
| **R1** | **Provider 抽象の型と registry**。`RemoteProvider` / `RemoteHandle` / `ProviderDetection` / `StopOutcome` と、`detect()` を回して選ぶ registry。**実装は空の stub 2 本**（常に `available:false`）で、選択規則とテストだけ先に確定させる | 新規 `src/lib/remote/types.ts` / `provider-registry.ts`、新規テスト | なし | **小〜中** |
| **R2** | **Cloudflare Quick Tunnel Provider**。detect / start（`--url` `--no-autoupdate` `--metrics 127.0.0.1:` `--pidfile`）/ URL 取得（U-3）/ stop（owned.pid に SIGTERM） | 新規 `src/lib/remote/cloudflare.ts`、新規テスト | R1 | **中** |
| **R3** | **Tailscale Serve Provider**。detect（available / ready 2 値）/ snapshot / start / stop（**owned かつ not preexisting だけ**） | 新規 `src/lib/remote/tailscale.ts`、新規テスト | R1、**U-2 の実測** | **中〜大**（実測待ちがボトルネック） |
| **R4** | **全消し禁止ガード**。`src/lib/remote/**` で `serve reset` / `tunnel cleanup` 等を禁止する lint ルールまたはガードテスト（**陽性対照つき**） | `eslint.config` もしくは新規ガードテスト | R1 | **小** |
| **R5** | **ペアリングコードの生成・消費**。`pairing-code.ts`（生成 / Base32 / ハンドオフファイルの 0600 書き込み・読み取り・unlink / `hashToken` の timing-safe 比較）＋ `POST /api/remote/pair` ＋ `AUTH_EXCLUDED_PATHS` に 1 要素追加 | 新規 `src/lib/security/pairing-code.ts`、新規 `src/app/api/remote/pair/route.ts`、`src/config/auth-config.ts`、新規テスト | なし（R1〜R4 と並列可） | **中** |
| **R6** | **受け口の転用**。`useFragmentLogin` を `#code=` 対応に拡張（`#token=` は deprecation ログつきで残す）。`/login` にペアリング中の表示を足す | `src/hooks/useFragmentLogin.ts`、`src/app/login/page.tsx`、`locales/{en,ja}/auth.json`（キー追加）、`tests/unit/hooks/useFragmentLogin.test.tsx` | R5 | **小〜中** |
| **R7** | **既存 QR ログインの撤去**（決定 A）。`QrCodeGenerator.tsx` と同テスト削除、`login/page.tsx` の `dynamic()` と `hidden md:block` ブロック削除、i18n の**10 キーだけ**削除、`docs/module-reference.md` 更新 | `src/components/auth/QrCodeGenerator.tsx`（削除）、`tests/unit/components/QrCodeGenerator.test.tsx`（削除）、`src/app/login/page.tsx`、`locales/{en,ja}/auth.json`、`docs/module-reference.md` | **R6（`login/page.tsx` と `auth.json` を共有 → 直列化必須）** | **小** |
| **R8** | **ターミナル QR レンダラ**。依存の選定（U-1）と、URL → 端末表示の関数。**幅の狭い端末での折返し**を含む | `package.json`、新規 `src/cli/utils/qr-terminal.ts`、新規テスト | U-1 の判定 | **小〜中** |
| **R9** | **`commandmate remote` 本体**。`runRemote()`（exit しない）＋ `createRemoteCommand()`、`up` / `status` / `stop`、状態ファイル、`runStart` への env 注入、期限監視 | 新規 `src/cli/commands/remote.ts`、新規 `src/cli/utils/remote-state.ts`、`src/cli/program.ts`、`src/cli/types/index.ts`、`src/cli/config/security-messages.ts`（承認文言）、新規テスト | **R1・R5・R8**（R2/R3 は stub のまま結線できる） | **大** |
| **R10** | **秘匿値が漏れないことの固定**（U-5）。起動 env のキー集合を完全一致で assert、ハンドオフファイルの 0600 とペアリング後の消滅を assert。**`SENSITIVE_ENV_KEYS` は変更しない**（変更が必要になったなら §7.2 の前提が崩れているので設計に戻る） | 新規テストのみ（`src/lib/security/env-sanitizer.ts` は**触らない**） | R9（キー名の確定） | **小** |
| **R11** | **docs**。`docs/security-guide.md`（remote の節・Quick Tunnel のリスク・`Secure` の扱い U-6）、`docs/user-guide/webapp-guide.md`（スマホ接続手順を QR 経路に差し替え）、`docs/TRUST_AND_SAFETY.md`（「外部アクセス時の依存」を更新）、`README.md`（FAQ の `CM_BIND=0.0.0.0` 案内を見直す）、`docs/user-guide/cli-operations-guide.md`（`remote` のコマンド表）、**macOS / Linux / WSL2 の対応可否表**（U-8） | 上記 docs、`CLAUDE.md` の CLI コマンド節 | R9、**U-8 の実測** | **中** |
| **R12** | **実機 UAT**。3 OS ×2 Provider の疎通、WS 疎通、未認証端末の遮断、`remote stop` 後の URL 失効、**既存 Tailscale Serve 設定を持つ環境での非破壊確認**、U-2/U-3/U-6/U-7/U-8 の確定 | `dev-reports/` 配下の報告 | R9・R11 | **中〜大** |

### 12.1 依存と並列可否

```
R1 ─┬─ R2 ────────────────┐
    ├─ R3 (U-2 実測待ち) ──┤
    └─ R4                  │
                           ├─ R9 ─┬─ R10
R5 ─── R6 ─── R7           │      ├─ R11 ─── R12
                           │      │
R8 (U-1 判定) ─────────────┘      │
```

- **並列で走れる**: `{R1,R2,R4}` / `{R5,R6}` / `{R8}` の 3 群
- **直列が必須**: **R6 → R7**（`src/app/login/page.tsx` と `locales/*/auth.json` を両方が触る。同時に走らせると衝突する）
- **R9 は結線の合流点**。R2 / R3 が未完でも registry の stub で結線できるので、**R9 を R2/R3 の完了待ちにしない**
- R3 は U-2 の実機実測が前提。**実測が取れるまで着手しない**（推測で書くと §6.4 の表ごと作り直しになる）
- `CHANGELOG.md` は全 Issue が触る衝突点なので、各 Issue は `dev-reports/changelog/` の断片で提出し、統合時に 1 回だけ本体へ入れる

### 12.2 受入条件の割り当て

Issue の受入条件は **20 項目**（`gh issue view 1937` の `- [ ]` 実数）。
**そのすべてが Phase 1 で満たせる。** これは決定 B（端末別認証を落とす）を支持する事実である —
端末の個別失効・接続端末の一覧は Issue の **MVP リスト**には載っているが、**受入条件には 1 項目も無い**。
落としても受入条件を 1 つも失わない。

| 受入条件 | 担当 |
|---|---|
| `commandmate remote` だけで開始できる | R9 |
| Tailscale が優先される | R1・R3 |
| 公開 Tunnel 前に説明と明示承認 | R9（承認文言は `security-messages.ts`） |
| QR 読取でペアリング画面が開く | R6・R8 |
| トークンを手入力せず接続できる | R5・R6 |
| ペアリングコードは一度だけ | R5 |
| ペアリングコードは時間で失効 | R5 |
| QR に長期トークンが含まれない | R7（発行側の削除）＋ R5 |
| 認証済みスマホから API / WS | R5（既存経路に合流するため追加実装なし。R12 で確認） |
| 未認証端末から API / WS 不可 | 既存 middleware / ws-server（**触らないことで担保**）。R12 で確認 |
| `CM_BIND` の既定を壊さない | §9.2 のテスト群 |
| `remote status` で Provider・URL・有効期限・接続状態 | R9。**「接続状態」は Provider の状態とサーバの稼働・ペアリングの消費有無**と解釈する。端末単位の接続一覧は端末 ID が存在しないため Phase 1 では出せない（§3.4） |
| `remote stop` | R9 |
| 停止時に一時認証情報が失効 | R9（プロセス終了）＋ R5 |
| CommandMate が作っていない設定を削除しない | R3・R4・R12 |
| Quick Tunnel 終了後に URL 無効 | R2・R12 |
| Auto Yes 既定無効 | 構造的に成立。§9.2 のテストで固定 |
| セキュリティ／ユーザーガイド更新 | R11 |
| 既存 QR ログイン（#383）の扱いが決定され、記録される | **本書 §2 で充足済み**（決定 A）。記録の反映は R7 |
| macOS / Linux / WSL2 の対応可否明記 | R11・R12（U-8） |

**受入条件ではないが Phase 2 へ送るもの**（決定 B）: 端末の個別失効（`remote revoke`）、接続端末の一覧（`remote devices`）、
PC 側の承認ステップ。いずれも Issue の MVP リストにはあるが受入条件には無い。
