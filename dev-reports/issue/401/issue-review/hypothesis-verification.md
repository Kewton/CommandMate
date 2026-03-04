# Issue #401 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | stop.shがPIDファイルベースでのみ停止を試みる | Rejected | stop.shはlsof -ti:$PORT（ポートベース）を使用。PIDファイルを使っていない |
| 2 | PIDファイルに複数行が混入し停止失敗が起きる | Partially Confirmed | build-and-start.shのPIDファイル読み取りに複数行バリデーションなし（stop-server.shも同様） |
| 3 | プロセスが既に終了済みの場合にエラーとなる | Partially Confirmed | build-and-start.shのkill -0ガードは正常に機能するが、別プロセスにPIDが再利用されると誤判定の可能性 |
| 4 | build-and-start.shが「already running」と誤判定し起動失敗 | Confirmed | build-and-start.sh L69-76でPIDファイルのみで判定。ポート使用状況を確認しない |

## 詳細検証

### 仮説 1: stop.shがPIDファイルベースでのみ停止する

**Issue内の記述**: "stop.shがPIDファイルベースでのみ停止を試みるが、PIDファイルに複数行が混入したり..."

**検証手順**:
1. `scripts/stop.sh` を読み込み（全31行）
2. 非PM2分岐のロジックを確認

**判定**: Rejected

**根拠**: `stop.sh` L21-29 を確認したところ、非PM2の場合は `lsof -ti:$PORT` でポートベース停止を実施済みである。PIDファイルは一切使用していない。

```bash
# scripts/stop.sh L21-29（現行コード）
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$PID" ]; then
    kill "$PID"
    echo "✓ Application stopped (PID: $PID)"
else
    echo "Application is not running on port $PORT"
fi
```

**Issueへの影響**: Issue記載の「stop.shがPIDファイルベースのみ」という前提が誤り。ただし、ポートベース停止でも `lsof -ti:$PORT` が複数行を返した場合（複数プロセスが同ポートを使用）に `kill` が正しく動作しない可能性はある。

---

### 仮説 2: PIDファイルに複数行が混入する

**Issue内の記述**: "PIDファイルに複数行が混入したり"

**検証手順**:
1. `scripts/build-and-start.sh` L69-76 を確認
2. `scripts/stop-server.sh` L28 を確認

**判定**: Partially Confirmed

**根拠**:

`build-and-start.sh`:
```bash
# L69-76: バリデーションなしでPIDを読み取り
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")   # 複数行でも全部取り込む
    if kill -0 "$OLD_PID" 2>/dev/null; then  # 複数行だとkill -0がエラー
```

`stop-server.sh`:
```bash
# L28: 同様にバリデーションなし
PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
```

PIDファイルが複数行の場合、bashの `kill -0 "$OLD_PID"` は「invalid PID」エラーとなりkillスキップされる（`2>/dev/null` で抑制）。結果として停止処理が不完全になる。

---

### 仮説 3: プロセスが既に終了済みの場合にエラーとなる

**Issue内の記述**: "プロセスが既に終了済みの場合にエラーとなる"

**検証手順**:
1. `build-and-start.sh` L71 の `kill -0` ガードを確認
2. PID再利用シナリオを検討

**判定**: Partially Confirmed

**根拠**: `kill -0 "$OLD_PID" 2>/dev/null` はプロセスが存在しない場合に `false` を返すため、一般的な「終了済み」ケースは正常に処理される。ただし、停止後にPIDが別プロセス（例: システムプロセス）に再利用された場合、「Server is already running」と誤判定する問題がある（PID再利用問題）。

---

### 仮説 4: build-and-start.shの「already running」判定がポートベースでない

**Issue内の記述**: "build-and-start.shも「Server is already running」と判定し起動に失敗するケース"

**検証手順**:
1. `build-and-start.sh` のdaemonモード起動チェック（L65-76）を確認

**判定**: Confirmed

**根拠**:
```bash
# build-and-start.sh L69-76
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Server is already running (PID: $OLD_PID)"
        echo "Use ./scripts/stop-server.sh to stop it first"
        exit 1
    fi
    # ※ PIDファイルが古くプロセスが死んでいてもファイルが残ると...
    # kill -0が失敗 → 条件成立せず → 起動継続（これは正常）
    # ただしPIDが別プロセスに再利用されている場合は誤判定
fi
# ※ PIDファイルが存在しない場合でも、ポート3000が使用中であれば起動は失敗する
# （しかしその場合はexit 1ではなくnpmが失敗する）
```

ポート使用状況をチェックしないため、PIDファイルなしで別の手段でサーバーが起動している場合に二重起動が発生する可能性がある。

---

## Stage 1レビューへの申し送り事項

1. **stop.shの記述誤り**: Issue本文で「stop.shがPIDファイルベースのみ」と書かれているが実際は既にポートベース。この誤解を修正すべき。
2. **実際の問題スコープ明確化**: 実際の問題は `build-and-start.sh` のdaemon起動時の「already running」判定ロジックと、PIDファイルバリデーション不備にある。
3. **stop.shの複数PID対応**: `lsof -ti:$PORT` が複数PIDを返す場合に `kill` が正常動作するかのチェックが必要（xargsを使うかのバリデーション）。
4. **stop-server.shとstop.shの重複**: 両スクリプトが似た機能を持ち、整理・統合の余地がある。
