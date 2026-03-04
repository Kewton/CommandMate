# 設計方針書: Issue #401 stop.shが古いサーバープロセスを取りこぼす問題の修正

## 1. 概要

### 対象Issue
- **Issue番号**: #401
- **タイトル**: fix: stop.shが古いサーバープロセスを取りこぼす問題の修正
- **種別**: バグ修正（シェルスクリプト）

### 修正スコープ
シェルスクリプト群（`scripts/stop.sh`、`scripts/stop-server.sh`、`scripts/build-and-start.sh`）のプロセス停止・再起動処理の堅牢性を向上させる。

### 設計方針の要約
1. 既存のスクリプト構造を維持しつつ、防御的プログラミングの手法を追加
2. CLI側（`src/cli/utils/daemon.ts`、`src/cli/utils/pid-manager.ts`）の堅牢な実装を参考に、同等の信頼性をシェルスクリプトに適用
3. macOS/Linux両環境での互換性を確保

---

## 2. アーキテクチャ設計

### スクリプト間の依存関係

```
restart.sh ──呼出──> stop.sh ──修正対象──
                     start.sh

rebuild SKILL ──呼出──> stop.sh ──修正対象──
              ──呼出──> build-and-start.sh --daemon ──修正対象──

setup.sh ──呼出──> build-and-start.sh --daemon ──修正対象──

build-and-start.sh ──案内──> stop-server.sh ──修正対象──
```

### 停止処理のレイヤー構成

```
                      ┌─────────────────────────┐
                      │  呼び出し元              │
                      │  restart.sh / rebuild    │
                      │  setup.sh               │
                      └──────────┬──────────────┘
                                 │
                      ┌──────────▼──────────────┐
                      │  停止スクリプト          │
                      │  stop.sh (汎用)         │
                      │  stop-server.sh (daemon)│
                      └──────────┬──────────────┘
                                 │
                      ┌──────────▼──────────────┐
                      │  OS層                   │
                      │  lsof / kill / xargs    │
                      └─────────────────────────┘
```

---

## 3. 設計パターン

### 3.1 多段フォールバック停止パターン

`stop-server.sh`に既に実装されている3段構えのパターンを`stop.sh`にも適用する。

```
Step 1: ポートベース停止（SIGTERM）
  ↓ 失敗時
Step 2: 残留チェック + SIGKILL強制停止
  ↓
Step 3: 最終確認（ポート解放の検証）
```

### 3.2 安全なPIDパイプラインパターン

lsof出力をkillに渡す際のバリデーションを共通化する。

```bash
# 安全なPID取得パイプライン（全スクリプト共通）
PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u)
```

**設計根拠**:
- `grep -E '^[0-9]+$'`: 数値以外を排除（PIDバリデーション）
- `sort -u`: IPv4/IPv6の重複PID除去
- `2>/dev/null`: lsof自体のエラー出力抑制

### 3.3 段階的停止パターン（SIGTERM → SIGKILL）

CLI側の`daemon.ts` L133-161の実装を参考に、段階的停止をシェルスクリプトでも適用する。

```bash
# Step 1: SIGTERM（グレースフルシャットダウン）
echo "$PIDS" | xargs kill 2>/dev/null

# Step 2: 待機
sleep 2

# Step 3: 残留チェック + SIGKILL
REMAINING=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u)
if [ -n "$REMAINING" ]; then
    echo "$REMAINING" | xargs kill -9 2>/dev/null
fi
```

---

## 4. 変更対象ファイル別の設計

### 4.1 scripts/stop.sh

**現状の問題**:
- L25: `kill "$PID"` が複数PIDを正しく処理できない
- 停止後の残留チェックがない

**修正方針**:

```bash
# 修正前（L22-26）
PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$PID" ]; then
    kill "$PID"
    echo "✓ Application stopped (PID: $PID)"
fi

# 修正後
PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
if [ -n "$PIDS" ]; then
    echo "Stopping process(es) on port $PORT: $(echo $PIDS | tr '\n' ' ')"
    echo "$PIDS" | xargs kill 2>/dev/null

    # 残留チェック（SIGTERM → SIGKILL フォールバック）
    sleep 2
    REMAINING=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
    if [ -n "$REMAINING" ]; then
        echo "Force killing remaining processes: $(echo $REMAINING | tr '\n' ' ')"
        echo "$REMAINING" | xargs kill -9 2>/dev/null
        sleep 1
    fi

    echo "✓ Application stopped"
fi
```

**設計判断**:
- PM2パス（L11-17）は変更しない（PM2が独自のプロセス管理を持つため）
- `|| true` を維持し、`set -e` 環境下でもパイプラインが失敗しないようにする
- [D1-002] `REMAINING`変数取得のパイプラインにも `|| true` を統一的に付加する。grepが0件マッチ時にexit code 1を返すため、`set -e`やpipefail環境下でパイプライン全体が失敗するリスクを防止する。`PIDS`取得と`REMAINING`取得で `|| true` の有無が非対称にならないよう統一する

### 4.2 scripts/stop-server.sh

**修正方針**:

| 行番号 | 修正内容 | 理由 |
|--------|---------|------|
| L11 | `PORT=3000` → `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` | 他スクリプトとの統一 |
| L18 | PIDバリデーション追加 | 安全性向上 |
| L22 | `kill -9` → SIGTERM + フォールバック | グレースフルシャットダウン |
| L28 | PIDファイル読み取りバリデーション | 不正PIDファイル対策 |
| L32 | `kill -9 -$PID` → SIGTERM + フォールバック | グレースフルシャットダウン |
| L42 | PIDバリデーション追加 | 安全性向上 |

**PIDファイルバリデーション**:
```bash
# 修正前（L28）
PID=$(cat "$PID_FILE")

# 修正後
PID=$(cat "$PID_FILE" 2>/dev/null | head -1 | grep -E '^[0-9]+$')
```

**設計根拠**:
- `head -1`: 複数行混入時は最初の行のみ使用
- `grep -E '^[0-9]+$'`: 数値以外のPIDを排除
- バリデーション失敗時は`PID`が空になり、後続の`if kill -0 "$PID"`で自然にスキップされる

**段階的停止の実装**:
```bash
# 修正前（L18-24）
PIDS=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill -9 2>/dev/null
    stopped=true
fi

# 修正後
PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
if [ -n "$PIDS" ]; then
    echo "Stopping process(es) on port $PORT: $(echo $PIDS | tr '\n' ' ')"
    echo "$PIDS" | xargs kill 2>/dev/null  # SIGTERM first
    sleep 2

    # SIGKILLフォールバック [D1-002: || true 統一]
    REMAINING=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
    if [ -n "$REMAINING" ]; then
        echo "Force killing remaining: $(echo $REMAINING | tr '\n' ' ')"
        echo "$REMAINING" | xargs kill -9 2>/dev/null
    fi
    stopped=true
fi
```

**PIDファイルベース停止のプロセスグループ指定に関する設計判断** [D1-006]:

PIDファイルから取得したPIDに対するkillでは、プロセスグループ指定（`-$PID`）の使用方針を以下のように定める。

| 段階 | コマンド | 理由 |
|------|---------|------|
| SIGTERM段階 | `kill -- -$PID` (プロセスグループ指定) | nohup起動時はプロセスグループリーダーとなるため、`-$PID`でNode.jsの子プロセス（next server等）も含めてグレースフルシャットダウンの機会を与える |
| SIGKILLフォールバック段階 | `kill -9 -$PID 2>/dev/null \|\| kill -9 $PID 2>/dev/null` (既存パターン維持) | プロセスグループが形成されていないケース（例: nohup以外の起動方法や環境差異）へのフォールバックとして、グループkill失敗時に単一プロセスkillを試行する |

**前提条件**: `build-and-start.sh`で`nohup`経由で起動されたプロセスは、プロセスグループリーダーとなる。そのため、PIDファイルに記録されたPIDに対する`kill -- -$PID`はプロセスグループ全体に送信される。

```bash
# PIDファイルベース停止の修正後コード
PID=$(cat "$PID_FILE" 2>/dev/null | head -1 | grep -E '^[0-9]+$')
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # SIGTERM: プロセスグループにグレースフルシャットダウンを送信
    kill -- -$PID 2>/dev/null || kill $PID 2>/dev/null
    sleep 2

    # フォールバック: SIGKILL（既存パターン維持）
    if kill -0 "$PID" 2>/dev/null; then
        kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null
    fi
    stopped=true
fi
```

**Final checkセクション（L38-47）の修正** [C2-003]:

現行コードL42の `REMAINING=$(lsof -ti:$PORT 2>/dev/null)` にはPIDバリデーションがない。セクション4.2の表でL42に「PIDバリデーション追加」と記載のとおり、共通パイプラインパターンに統一する。

```bash
# 修正前（L38-47）
sleep 1
# Final check
REMAINING=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$REMAINING" ]; then
    echo "Cleaning up remaining processes: $REMAINING"
    echo "$REMAINING" | xargs kill -9 2>/dev/null
    sleep 1
fi

# 修正後
sleep 1
# Final check
REMAINING=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
if [ -n "$REMAINING" ]; then
    echo "Cleaning up remaining processes: $REMAINING"
    echo "$REMAINING" | xargs kill -9 2>/dev/null  # Final check: SIGKILL最終手段
    sleep 1
fi
```

**設計判断**: Final checkはStep 1（ポートベース停止のSIGTERM+SIGKILL段階）およびStep 2（PIDファイルベース停止のSIGTERM+SIGKILL段階）を既に経た後の最終確認である。この時点でまだ残留しているプロセスに対してはグレースフルシャットダウンの機会を十分に与えた後であるため、SIGKILL（`kill -9`）の即座使用が適切である。SIGTERMを再度送信しても効果がないプロセスのみが残留している想定のため、待機コストを避けSIGKILLで確実に終了させる。

**修正後のstop-server.sh全体フロー** [C2-004]:

```
Step 1: ポートベース停止
  └─ lsof -ti:$PORT でPID取得（バリデーション付き）
  └─ SIGTERM送信（xargs kill）
  └─ sleep 2（グレースフルシャットダウン待機）
  └─ 残留チェック → SIGKILLフォールバック（xargs kill -9）

Step 2: PIDファイルベース停止
  └─ PIDファイル読み取り（head -1 + grep バリデーション）
  └─ kill -0 でプロセス存在確認
  └─ SIGTERM送信（プロセスグループ指定: kill -- -$PID）
  └─ sleep 2（グレースフルシャットダウン待機）
  └─ kill -0 で残留チェック → SIGKILLフォールバック（kill -9 -$PID || kill -9 $PID）

Step 3: Final check（最終確認）
  └─ sleep 1（Step 2からの安定待機）
  └─ lsof -ti:$PORT で残留PID取得（バリデーション付き）
  └─ SIGKILL即座送信（Step 1-2でSIGTERM→SIGKILL段階を完了済み）
  └─ sleep 1（SIGKILL後の安定待機）
```

各ステップの役割:
- **Step 1**: ポート番号に基づく網羅的なプロセス停止。PIDファイルの有無に依存しない
- **Step 2**: PIDファイルに記録されたプロセスおよびその子プロセス（プロセスグループ）の停止。Step 1で捕捉できなかったプロセス（ポートをリッスンしていない子プロセス等）に対応
- **Step 3**: Step 1-2で停止しきれなかったプロセスの最終クリーンアップ。SIGTERM/SIGKILLの段階的停止を既に試行済みのため、SIGKILL即座使用が妥当

### 4.3 scripts/build-and-start.sh

**修正方針**:

1. **CM_PORT環境変数の追加**（スクリプト冒頭）:
```bash
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
```

2. **PIDファイルバリデーション**（L70）:
```bash
# 修正前
OLD_PID=$(cat "$PID_FILE")

# 修正後
OLD_PID=$(cat "$PID_FILE" 2>/dev/null | head -1 | grep -E '^[0-9]+$')
if [ -z "$OLD_PID" ]; then
    # PIDファイルが不正 → 削除して続行
    rm -f "$PID_FILE"
fi
```

3. **ポートベースalready running判定の追加**（L69-76の後）:
```bash
# 既存のPIDファイルチェック
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null | head -1 | grep -E '^[0-9]+$')
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Server is already running (PID: $OLD_PID)"
        echo "Use ./scripts/stop-server.sh to stop it first"
        exit 1
    fi
    # PIDファイルが不正またはプロセスが終了済み → 削除
    rm -f "$PID_FILE"
fi

# 新規: ポートベースのチェック（PIDファイルなしでもプロセス残留を検知）
PORT_PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
if [ -n "$PORT_PIDS" ]; then
    echo "Port $PORT is already in use by process(es): $(echo $PORT_PIDS | tr '\n' ' ')"
    echo "Use ./scripts/stop-server.sh to stop it first"
    exit 1
fi
```

**CLIモードとの分断に関する注記** [I3-003]:

上記のエラーメッセージでは`stop-server.sh`の使用を案内しているが、CLIモード（`commandmate start --issue XXX`）で起動されたプロセスがポートを使用している場合は、`commandmate stop`コマンドで停止する必要がある。CLIモードとスクリプトモードではPIDファイルパスが異なるため（CLI: `~/.commandmate/pids/{issueNo}.pid`、スクリプト: `$PROJECT_DIR/logs/server.pid`）、`stop-server.sh`はCLIモードのPIDファイルを参照できない。ただし、`stop-server.sh`のStep 1（ポートベース停止）はPIDファイルに依存しないため、CLIモードで起動されたプロセスもポートベースで停止可能である。この分断の解消はセクション9「スコープ外の明示」項目1で別Issueとして整理済み。

**PIDファイル削除後のポート残留検知時の状態遷移** [D1-004]:

PIDファイルチェックで「PIDファイルが不正またはプロセスが終了済み」と判定された場合、PIDファイルは削除される。その後のポートベースチェックでプロセス残留が検知された場合、ユーザーには`stop-server.sh`の実行が案内される。この時点でPIDファイルは既に削除済みだが、`stop-server.sh`はStep 1（ポートベース停止: `lsof -ti:$PORT`）で対処可能なため、PIDファイルの有無に依存せずプロセスを停止できる。この動作フローは設計上意図されたものであり、`stop-server.sh`の多段停止パターン（ポートベース → PIDファイルベース → 最終確認）により安全にカバーされる。

```
PIDファイル不正/プロセス終了済み → PIDファイル削除
  → ポート残留検知 → exit 1 + "Use stop-server.sh" 案内
  → ユーザーが stop-server.sh 実行
  → Step 1: ポートベース停止（PIDファイル不要）で対処
```

**`set -e`との相互作用に関する注意**:
- `build-and-start.sh` L12で `set -e` が有効
- `lsof` パイプラインが失敗した場合にスクリプトが中断しないよう、`|| true` を付加する
- `kill -0` のエラーも `2>/dev/null` で抑制する

---

## 5. セキュリティ設計

### 5.1 PIDバリデーション

| チェック | 方法 | 対策対象 |
|---------|------|---------|
| 数値チェック | `grep -E '^[0-9]+$'` | 不正文字列のkill引数渡し防止 |
| 単一行チェック | `head -1` | 複数行混入時の安全な処理 |
| 重複除去 | `sort -u` | 同一PIDへの重複kill防止 |

### 5.2 シグナル送信の安全性

- SIGTERM（デフォルト）を先に送信し、プロセスにクリーンアップの機会を与える
- SIGKILL（kill -9）はフォールバックとしてのみ使用
- `xargs` + `2>/dev/null` で既に終了済みプロセスへのkillエラーを抑制

### 5.3 環境変数の検証

- `CM_PORT` / `MCBD_PORT` の値はそのまま使用（`lsof -ti:$PORT`でポート番号として解釈される）
- lsofが不正なポート値でエラーを返す場合は `2>/dev/null` で抑制

**ポート番号バリデーション** [D1-001] [S4-001] [S4-005]:

CLI側の`daemon.ts`では`parseInt()`で数値化しているのと同等の防御をシェルスクリプト側にも適用する。`PORT`変数の解決直後にバリデーションを行い、不正な値の場合は早期終了する。

```bash
# ポート番号バリデーション（bash組み込みパターンマッチング + 範囲チェック）
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo 'ERROR: Invalid port number specified in CM_PORT or MCBD_PORT' >&2
    exit 1
fi
```

**設計判断**:
- [S4-001] `echo "$PORT" | grep -qE` の代わりにbashの `[[ "$PORT" =~ ^[0-9]+$ ]]` パターンマッチングを使用する。これにより (1) grepサブプロセス起動を回避、(2) bashの正規表現マッチングはシェルのコマンド展開を伴わないため、CM_PORTにシェルメタ文字が含まれていた場合のバリデーション到達前のシェル展開リスクを軽減する
- [S4-005] バリデーション失敗時のエラーメッセージには固定文字列を使用し、未検証の`$PORT`値を含めない。これによりログインジェクション（改行文字やANSIエスケープシーケンスの注入）を防止する
- stop.sh / stop-server.sh: バリデーション失敗時は`exit 1`でエラー終了する。停止スクリプトでデフォルト3000へフォールバックすると、意図しないポートのプロセスを停止するリスクがあるため、エラー通知が適切
- build-and-start.sh: バリデーション失敗時は`exit 1`でエラー終了する。不正なポートでのサーバー起動を防止する
- このバリデーションを全3スクリプト（stop.sh、stop-server.sh、build-and-start.sh）の`PORT`変数解決直後に配置する

### 5.4 PIDファイルのパーミッション [S4-003]

build-and-start.shでPIDファイルを書き込む際、CLI側のPidManager.writePid()（`0o600` + `O_EXCL`）と同等のセキュリティ水準を確保する。

```bash
# PIDファイルを600パーミッション（owner read/write only）で書き込み
echo $SERVER_PID > "$PID_FILE" && chmod 600 "$PID_FILE"
```

**設計根拠**:
- デフォルトのumask（通常022）では644（rw-r--r--）となり、同一マシンの他ユーザーからPIDファイルの内容が読み取り可能になる
- `chmod 600` により、owner以外のread/writeを明示的に禁止する
- CLI側のPidManager.writePid()が `0o600` + `O_EXCL` でアトミックに書き込んでいることとの整合性を確保する
- シェルスクリプトでは `O_EXCL` 相当のアトミック書き込みは困難なため、`chmod 600` による事後設定で対応する

### 5.5 シグナル送信のEPERMエラーハンドリング [S4-004]

stop-server.shのPIDファイルベース停止（D1-006）において、`kill -- -$PID` がEPERMエラー（権限不足）を返す場合の動作方針を定める。

**問題**: プロセスグループに他ユーザー所有のプロセスが含まれている場合、あるいはroot所有のプロセスに対して一般ユーザーからkillを試行した場合、EPERMエラーが発生する。`2>/dev/null` によりエラー出力は抑制されるが、プロセスが残留していることがユーザーに通知されない。

**設計方針**: SIGKILLフォールバック後の `kill -0` チェックで停止の成否を判定し、停止できなかった場合は警告を出力する。

```bash
# PIDファイルベース停止（EPERM対応付き）
kill -- -$PID 2>/dev/null || kill $PID 2>/dev/null
sleep 2
if kill -0 "$PID" 2>/dev/null; then
    kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
        echo 'WARNING: Process could not be stopped (permission denied or other error)' >&2
    fi
fi
```

**設計根拠**:
- `kill -0` はプロセス存在確認に使用される。EPERMの場合もプロセスが存在すれば成功を返す（`kill -0` はシグナル送信せず権限チェックのみ）
- SIGKILLフォールバック後にまだプロセスが存在する場合、権限不足が原因である可能性が高い
- 警告メッセージは固定文字列を使用し、PID値を含めない（S4-005のログインジェクション対策と統一）

### 5.6 既知のセキュリティ制限事項 [S4-002]

シェルスクリプトによるプロセス停止処理には、以下の既知のセキュリティ制限が存在する。

**TOCTOU（Time-of-Check to Time-of-Use）競合**:

lsofによるPID取得（Check）とkillによるシグナル送信（Use）の間にタイムウィンドウが存在し、以下のシナリオが理論的に可能である。

```
1. lsof -ti:$PORT → PID 12345 を取得（Check）
2. PID 12345 のプロセスが自然終了
3. 別のプロセスが PID 12345 を再利用
4. kill 12345 → 無関係のプロセスにシグナル送信（Use）
```

**リスク評価**: 低
- ローカル開発環境での使用が前提であり、意図的な攻撃にはマシンへの物理アクセスが必要
- PID再利用にはカーネルのPID空間を一周する必要があり（Linux: デフォルト32768、macOS: 99999）、短時間でのPID衝突確率は低い
- CLI側のdaemon.ts（`process.kill(pid, 0)` + `process.kill(pid, signal)`）にも同じTOCTOU問題が存在するが、PIDファイルベース管理により対象が限定されている

**緩和策**:
- 現設計では lsof → kill を直接パイプで実行し、遅延を最小化している
- `lsof -ti:$PORT -c node` のようにプロセス名フィルタを追加することで、誤killの対象範囲を限定する検討が可能（ただし、本Issueのスコープでは既存の`lsof -ti:$PORT`パターンを維持し、将来のセキュリティ強化として検討する）
- シェルスクリプトでのTOCTOU完全解消はカーネルレベルのアトミック操作が必要であり、現実的には困難

---

## 6. 互換性設計

### 6.1 macOS / Linux互換性

| コマンド | macOS (BSD) | Linux (GNU) | 対策 |
|---------|------------|-------------|------|
| `xargs` | 空入力時は実行しない | 空入力時もコマンド実行 | `if [ -n "$PIDS" ]` で空チェック |
| `lsof -t` | 標準動作 | IPv4/IPv6で重複PID出力の可能性 | `sort -u` で重複除去 |
| `grep -E` | 標準動作 | 標準動作 | 互換性問題なし |
| `kill` | 標準動作 | 標準動作 | 互換性問題なし |

### 6.2 既存呼び出し元との互換性

| 呼び出し元 | 期待する動作 | 互換性 | 待機時間への影響 [I3-001] |
|-----------|------------|--------|--------------------------|
| `restart.sh` | `stop.sh` が正常終了（exit 0）| 維持（exitコードは変更しない） | stop.sh内の待機(最大3秒) + restart.sh自身のsleep 2 = 合計最大5秒。現状の約2秒から増加するが許容範囲内 |
| `rebuild SKILL` | `stop.sh && build-and-start.sh --daemon` | 維持（&&チェーンの動作を保持） | stop.sh内の待機(最大3秒)が追加。rebuild全体の実行時間に影響するが許容範囲内 |
| `setup.sh` | `build-and-start.sh --daemon` が正常動作 | 維持（新規チェックは既存動作を阻害しない） | 影響なし（stop.shは呼び出されない） |

---

## 7. テスト方針

### 7.1 手動テスト項目

シェルスクリプトの自動テストフレームワーク（bats-core等）は本プロジェクトでは未導入のため、手動テストで品質を担保する。

| # | テストケース | 手順 | 期待結果 |
|---|------------|------|---------|
| 1 | 複数PID停止 | 同一ポートで複数プロセス起動 → `stop.sh`実行 | 全プロセスが停止 |
| 2 | PIDファイルなしでプロセス残留 | daemon起動 → PIDファイル削除 → 再daemon起動 | 残留検知・停止・新規起動 |
| 3 | 不正PIDファイル | PIDファイルに`12345\n67890`書込み → `stop-server.sh`実行 | エラーなく停止 |
| 4 | CM_PORT指定 | `CM_PORT=3001`で起動 → `CM_PORT=3001 ./scripts/stop-server.sh` | 正しいポート停止 |
| 5 | 正常サイクル | `build-and-start.sh --daemon` → `stop-server.sh` → 再起動 | 正常動作 |
| 6 | restart.sh | `restart.sh`実行 | 停止+再起動が正常動作 |
| 7 | nohup以外の起動方法でのstop-server.sh動作確認 [I3-002] | `npm start`等でフォアグラウンド起動 → バックグラウンドに回す → `stop-server.sh`実行 | `kill -- -$PID`フォールバック（`kill $PID`）でプロセスが停止される |

### 7.2 既存テストへの影響

- **影響なし**: 既存の単体テスト（`tests/unit/cli/`）はCLIモジュールを対象としており、シェルスクリプト修正の影響を受けない
- **CI/CD影響なし**: GitHub Actions CI/CDではシェルスクリプトを直接呼び出していない

---

## 8. 設計上の決定事項とトレードオフ

### 採用した設計

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| SIGTERM→SIGKILL段階的停止 | プロセスにクリーンアップの機会を与える | stop.sh: 停止に最大3秒追加（SIGTERM後sleep 2 + SIGKILL後sleep 1）。stop-server.sh: 各ステップでsleep 2追加。restart.shでは合計最大5秒の待機となる（stop.sh内最大3秒 + restart.sh自身のsleep 2）[I3-001] |
| lsof出力のPIDバリデーション | 不正な値がkillに渡されることを防止 | パイプラインが若干複雑化 |
| PIDファイルのhead -1 | 複数行混入時でも安全に動作 | 2行目以降のPIDは無視される |
| stop.shとstop-server.shの分離維持 | 後方互換性と用途の明確性を維持 | 一部ロジックが重複 |

### 代替案との比較

| 代替案 | メリット | デメリット | 判定 |
|--------|---------|----------|------|
| stop.shとstop-server.shの統合 | DRY原則準拠 | restart.sh/rebuildの呼び出し変更が必要 | 不採用（スコープ過大） |
| bashの共通関数ファイル化 | コード再利用 | sourceパスの管理が複雑化 | 不採用（YAGNI） |
| bats-coreテスト導入 | 自動テスト可能 | 新規依存の追加 | 不採用（スコープ外） |

---

## 9. スコープ外の明示

以下は本Issueのスコープ外とする：

1. **CLIとシェルスクリプトのPIDファイルパス統合**: 異なるPIDファイルパスの分断解消は別Issue
2. **build-and-start.shフォアグラウンドモードのポート競合検知**: フォアグラウンドではnpm startがエラーを出す
3. **docs/DEPLOYMENT.mdの更新**: 段階的停止導入後のドキュメント整合性は別Issue
4. **lsof未インストール環境への対応**: 全スクリプトがlsofを前提としている
5. **bats-coreテストフレームワークの導入**: 将来課題
6. **restart.shのsleep 2の短縮** [I3-001]: stop.shの修正により段階的停止の待機処理（最大3秒）が追加されるため、restart.sh L22のsleep 2が冗長になる可能性がある。restart.shのsleep 2を削除または短縮（sleep 1）することは、本Issueのスコープ外とする

---

## 10. レビュー指摘事項の反映サマリ

### Stage 1 レビュー（設計原則）

**レビュー日**: 2026-03-03
**全体評価**: 良好
**指摘件数**: Must Fix 1件、Should Fix 3件、Nice to Have 4件（合計8件）

#### 反映済み指摘

| ID | 重要度 | カテゴリ | タイトル | 反映箇所 |
|----|--------|---------|---------|---------|
| D1-006 | must_fix | 防御的プログラミング | stop-server.shのPIDファイルベース停止でプロセスグループ指定の設計判断を明記 | セクション4.2 |
| D1-001 | should_fix | 防御的プログラミング | CM_PORT環境変数のバリデーションパターン追加 | セクション5.3 |
| D1-002 | should_fix | 防御的プログラミング | REMAINING変数にも `\|\| true` を統一追加 | セクション4.1、4.2 |
| D1-004 | should_fix | SRP | build-and-start.shのポートベースチェック後の状態遷移を明示 | セクション4.3 |

#### スキップした指摘（Nice to Have）

| ID | カテゴリ | タイトル | スキップ理由 |
|----|---------|---------|-------------|
| D1-003 | DRY | PIDバリデーションパイプラインの重複箇所にコメント追記 | Nice to have: 実装時にコメント付記で対応可能 |
| D1-005 | KISS | 段階的停止の累積待機時間のドキュメント記載 | Nice to have: 許容範囲内の遅延 |
| D1-007 | YAGNI | スコープ外の明示が適切 | Nice to have: 指摘なし（現状適切） |
| D1-008 | SOLID | stop.shとstop-server.shの責務分離の文書化 | Nice to have: 実装時にコメントで対応可能 |

### Stage 2 レビュー（整合性）

**レビュー日**: 2026-03-03
**全体評価**: 要改善
**指摘件数**: Must Fix 1件、Should Fix 3件、Nice to Have 4件（合計8件）

#### 反映済み指摘

| ID | 重要度 | カテゴリ | タイトル | 反映箇所 |
|----|--------|---------|---------|---------|
| C2-001 | must_fix | 設計内部整合性 | セクション11の実装チェックリストがセクション4の中核修正を網羅していない | セクション11: Core Changesカテゴリ追加 |
| C2-002 | should_fix | 設計内部整合性 | セクション4.2のPIDS取得パイプラインに \|\| true が欠落しD1-002統一方針と矛盾 | セクション4.2: PIDS行に \|\| true 追加 |
| C2-003 | should_fix | コード整合性 | stop-server.shのFinal checkセクション（L38-47）の修正後コードサンプルが欠落 | セクション4.2: Final check修正後コードサンプル追加 |
| C2-004 | should_fix | コード整合性 | stop-server.shセクション4.2の修正後コードでFinal checkとの関係が不明確 | セクション4.2: 修正後全体フロー図追加 |

#### スキップした指摘（Nice to Have）

| ID | カテゴリ | タイトル | スキップ理由 |
|----|---------|---------|-------------|
| C2-005 | Issue要件整合性 | rebuildスキルのstop.sh呼び出しパターンに関する影響分析 | Nice to have: 互換性は維持される |
| C2-006 | コード整合性 | 設計書のアーキテクチャ図でsetup.shの呼び出し先が不完全 | Nice to have: 修正対象依存関係に限定する方針 |
| C2-007 | 設計内部整合性 | セクション3.2の共通パイプラインパターンと個別実装の形式差異 | Nice to have: C2-002反映により主要な不整合は解消 |
| C2-008 | Issue要件整合性 | daemon.tsの10秒タイムアウトとシェルスクリプトの2秒待機の対比 | Nice to have: セクション8で言及済み |

### Stage 3 レビュー（影響分析）

**レビュー日**: 2026-03-03
**全体評価**: 低リスク
**指摘件数**: Must Fix 0件、Should Fix 3件、Nice to Have 3件（合計6件）

#### 反映済み指摘

| ID | 重要度 | カテゴリ | タイトル | 反映箇所 |
|----|--------|---------|---------|---------|
| I3-001 | should_fix | 副作用リスク | stop.shのsleep 2追加によるrestart.sh合計待機時間の増加 | セクション6.2: 待機時間影響列追加、セクション8: トレードオフに待機時間詳細記載、セクション9: restart.shのsleep 2短縮をスコープ外に追記 |
| I3-002 | should_fix | エラー伝播 | stop-server.shのPIDファイルベース停止でプロセスグループリーダーでないPIDに対するkill -- -$PIDの挙動 | セクション7.1: テスト項目#7追加（nohup以外の起動方法でのstop-server.sh動作確認） |
| I3-003 | should_fix | 並行実行の安全性 | CLIモードとスクリプトモードのPIDファイルパス分断による検知漏れリスク | セクション4.3: CLIモードとの分断に関する注記追加 |

#### スキップした指摘（Nice to Have）

| ID | カテゴリ | タイトル | スキップ理由 |
|----|---------|---------|-------------|
| I3-004 | 環境依存性 | lsofがpreflight-check.shの依存チェック対象に含まれていない | Nice to have: セクション9で既にスコープ外として明示済み |
| I3-005 | 後方互換性 | CM_PORT/MCBD_PORT未設定時のデフォルト3000の一貫性 | Nice to have: リスクなしと評価済み |
| I3-006 | 副作用リスク | build-and-start.shのポートベースチェック追加によるset -eとの安全な相互作用 | Nice to have: 現在の設計で安全性が確保されている |

### Stage 4 レビュー（セキュリティ）

**レビュー日**: 2026-03-03
**全体評価**: 中リスク
**指摘件数**: Must Fix 1件、Should Fix 4件、Nice to Have 3件（合計8件）

#### 反映済み指摘

| ID | 重要度 | カテゴリ | タイトル | 反映箇所 |
|----|--------|---------|---------|---------|
| S4-001 | must_fix | シェルインジェクション | PORT変数のバリデーションにbash組み込みパターンマッチング使用、固定文字列エラーメッセージ | セクション5.3: バリデーションコードをbash `[[ =~ ]]` に変更、エラーメッセージを固定文字列に変更 |
| S4-002 | should_fix | TOCTOU競合 | lsof→kill間のTOCTOU競合リスクの文書化 | セクション5.6: 既知のセキュリティ制限事項として追記、リスク評価・緩和策を明記 |
| S4-003 | should_fix | PIDファイル改竄 | PIDファイルパーミッション（chmod 600）の設計方針追記 | セクション5.4: PIDファイルのパーミッション設計を追加、CLI側PidManager（0o600+O_EXCL）との整合性を明記 |
| S4-004 | should_fix | 権限昇格リスク | EPERMエラーハンドリングの設計方針追記 | セクション5.5: kill失敗時の警告出力方針を追加、固定文字列メッセージ使用 |
| S4-005 | should_fix | 情報漏洩 | バリデーションエラーメッセージを固定文字列に変更 | セクション5.3: S4-001と統合して対応済み |

#### スキップした指摘（Nice to Have）

| ID | カテゴリ | タイトル | スキップ理由 |
|----|---------|---------|-------------|
| S4-006 | DoS防止 | 予約ポート（1-1023）の考慮 | Nice to have: デフォルトポート3000であり開発ツール用途。バリデーション範囲変更の必要性なし |
| S4-007 | DoS防止 | xargs killへの大量PID入力に対する制限 | Nice to have: xargsのデフォルト分割処理により実用上問題なし |
| S4-008 | シェルインジェクション | PIDファイルパスのパストラバーサル検証 | Nice to have: `cd ... && pwd` によるシンボリックリンク解決で既に緩和済み。レビュー結果でも「変更不要」と評価 |

---

## 11. 実装チェックリスト

### Core Changes [C2-001]

- [ ] stop.sh: `kill "$PID"` を `echo "$PIDS" | xargs kill 2>/dev/null` 方式に変更し複数PIDに対応
- [ ] stop.sh: SIGTERM後のsleep 2 + 残留チェック + SIGKILL強制停止を追加
- [ ] stop-server.sh L11: `PORT=3000` を `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` に変更
- [ ] stop-server.sh L18: PIDバリデーション付きPIDS取得パイプライン追加
- [ ] stop-server.sh L22: `kill -9` をSIGTERM + sleep 2 + SIGKILLフォールバックに変更
- [ ] stop-server.sh L28: PIDファイルバリデーション（head -1 + grep）追加
- [ ] stop-server.sh L29-34: PIDファイルベース停止にSIGTERM（プロセスグループ） + SIGKILL段階化
- [ ] build-and-start.sh: CM_PORT環境変数追加 + ポート番号バリデーション
- [ ] build-and-start.sh L70: PIDファイルバリデーション追加
- [ ] build-and-start.sh L69-76: ポートベースalready running判定追加

### Must Fix (Stage 1 Review)

- [ ] [D1-006] stop-server.shのPIDファイルベース停止: SIGTERM段階で `kill -- -$PID` を使用しプロセスグループにグレースフルシャットダウンを送信する
- [ ] [D1-006] stop-server.shのPIDファイルベース停止: SIGKILLフォールバック段階で `kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null` パターンを維持する

### Should Fix (Stage 1 Review)

- [ ] [D1-001] stop.shにポート番号バリデーション（数値・範囲1-65535チェック）を追加する
- [ ] [D1-001] stop-server.shにポート番号バリデーション（数値・範囲1-65535チェック）を追加する
- [ ] [D1-001] build-and-start.shにポート番号バリデーション（数値・範囲1-65535チェック）を追加する
- [ ] [D1-002] stop.shのREMAINING変数取得パイプラインに `|| true` を追加する
- [ ] [D1-002] stop-server.shのREMAINING変数取得パイプラインに `|| true` を追加する
- [ ] [D1-004] build-and-start.shでPIDファイル削除後のポート残留検知時、stop-server.shのポートベース停止で対処可能であることをコメントで明記する

### Should Fix (Stage 3 Review)

- [ ] [I3-001] stop.sh修正後の待機時間がrestart.sh合計待機時間に与える影響を認識した上で実装する（最大5秒の待機は許容範囲内）
- [ ] [I3-002] 手動テスト時にnohup以外の起動方法（手動npm start等）でのstop-server.sh動作を確認し、kill -- -$PIDフォールバック（kill $PID）が正しく動作することを検証する
- [ ] [I3-003] build-and-start.shのポート競合検知エラーメッセージにおいて、CLIモードのプロセスもstop-server.shのポートベース停止で対処可能であることを認識する

### Must Fix (Stage 4 Review)

- [ ] [S4-001] 全3スクリプトのポート番号バリデーションでbash組み込みパターンマッチング `[[ "$PORT" =~ ^[0-9]+$ ]]` を使用する（`echo "$PORT" | grep -qE` は使用しない）
- [ ] [S4-001] バリデーション失敗時のエラーメッセージを固定文字列 `'ERROR: Invalid port number specified in CM_PORT or MCBD_PORT'` にする（$PORT値を含めない）

### Should Fix (Stage 4 Review)

- [ ] [S4-002] セクション5.6の既知のセキュリティ制限事項（TOCTOU競合）を認識した上で実装する
- [ ] [S4-003] build-and-start.shのPIDファイル書き込み後に `chmod 600 "$PID_FILE"` を追加し、CLI側PidManager（0o600）との整合性を確保する
- [ ] [S4-004] stop-server.shのPIDファイルベース停止で、SIGKILLフォールバック後にまだプロセスが存在する場合、固定文字列の警告メッセージを出力する
- [ ] [S4-005] 全スクリプトのバリデーションエラーメッセージで未検証の変数値を含めない（S4-001で対応済み）

---

*設計方針書作成日: 2026-03-03*
*Stage 1 レビュー反映日: 2026-03-03*
*Stage 2 レビュー反映日: 2026-03-03*
*Stage 3 レビュー反映日: 2026-03-03*
*Stage 4 レビュー反映日: 2026-03-03*
*Issue: https://github.com/Kewton/CommandMate/issues/401*
