# Issue #401 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**Issue**: fix: stop.shが古いサーバープロセスを取りこぼす問題の修正

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 4 |
| Should Fix | 5 |
| Nice to Have | 3 |
| **合計** | **12** |

**総合判定: 要改善**

Issue #401の記載内容に**重大な事実誤認が複数存在**する。仮説検証により、`stop.sh`は既にポートベース停止（`lsof -ti:$PORT`）を実装済みであることが確認されており、Issue本文の「stop.shがPIDファイルベースでのみ停止を試みる」という前提が根本的に誤っている。この前提に基づく提案・実装タスクの大半がコード実態と乖離しており、Issueの大幅な書き直しが必要である。

さらに、`scripts/stop-server.sh`（多層停止処理を実装済みの53行のスクリプト）がIssueで全く言及されておらず、スクリプト群全体の停止メカニズムに対する理解が不足している。

---

## Must Fix（必須対応）

### MF-1: 「stop.shがPIDファイルベースでのみ停止」という記述が事実と異なる

**カテゴリ**: 正確性
**場所**: ## 背景・課題 セクション

**問題**:
Issue本文で「stop.shがPIDファイルベースでのみ停止を試みるが、PIDファイルに複数行が混入したり...」と記載されているが、`stop.sh`はPIDファイルを一切使用していない。

**証拠**:
```bash
# scripts/stop.sh L21-29（現行コード）
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
PID=$(lsof -ti:$PORT 2>/dev/null || true)

if [ -n "$PID" ]; then
    kill "$PID"
    echo "Application stopped (PID: $PID)"
else
    echo "Application is not running on port $PORT"
fi
```

PIDファイルへの参照は`stop.sh`全31行のどこにも存在しない。

**推奨対応**:
Issue本文を実際のコードに合わせて修正し、正確な問題記述にすべき。`stop.sh`の実際の問題点（複数PIDが返された場合のkill動作の不安定性、`kill -9`ではなく`kill`（SIGTERM）のみの使用等）を記載すること。

---

### MF-2: 「stop.shにポートベース停止をフォールバックとして追加」という提案が的外れ

**カテゴリ**: 正確性
**場所**: ## 提案する解決策 / ### 主要な変更点 セクション

**問題**:
`stop.sh`は既にポートベースのみで動作しているため、「ポートベース停止をフォールバックとして追加」という提案は不要かつ的外れである。

**証拠**:
- `stop.sh`は全面的に`lsof -ti:$PORT`ベースで動作（PIDファイル処理なし）
- `stop-server.sh` L18-24は既に`lsof + xargs kill -9`を実装済み

**推奨対応**:
提案すべき解決策を以下のように修正すること:
1. `stop.sh`の複数PID対応（`xargs kill`方式への変更）
2. `build-and-start.sh` L69-76の`already running`判定にポートチェック追加
3. `stop-server.sh`のCM_PORT環境変数対応
4. `stop.sh`と`stop-server.sh`の機能重複の整理方針

---

### MF-3: stop-server.shの存在と役割がIssueで全く言及されていない

**カテゴリ**: 完全性
**場所**: Issue全体

**問題**:
`scripts/stop-server.sh`は`build-and-start.sh --daemon`モードの対になる停止スクリプトであり、既に多層停止処理を実装している。しかしIssueでは一切言及されておらず、スクリプト全体の停止メカニズムの分析が不完全である。

**証拠**:
```bash
# scripts/stop-server.sh -- 3段構えの停止処理
# L18-24: ポートベース停止（lsof + xargs kill -9）
PIDS=$(lsof -ti:$PORT 2>/dev/null)
echo "$PIDS" | xargs kill -9 2>/dev/null

# L27-36: PIDファイルベース停止（プロセスグループkill）
PID=$(cat "$PID_FILE")
kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null

# L42-47: 残留プロセス二重チェック
REMAINING=$(lsof -ti:$PORT 2>/dev/null)
echo "$REMAINING" | xargs kill -9 2>/dev/null
```

**推奨対応**:
`stop-server.sh`の存在・役割・`stop.sh`との機能差分をIssueに明記し、どちらを修正対象とするか（又は統合するか）を明確にすべき。

---

### MF-4: 実装タスクの最初の2項目がstop.shの実態と矛盾

**カテゴリ**: 正確性
**場所**: ## 実装タスク セクション

**問題**:
- タスク1「`stop.sh`: PIDファイル読み取り後のバリデーション追加」 -- `stop.sh`はPIDファイルを読み取らない
- タスク2「`stop.sh`: PIDベース停止失敗時のポートベースフォールバック追加」 -- `stop.sh`にPIDベース停止処理は存在しない

**証拠**:
`stop.sh`全31行にPIDファイルへの参照は存在しない。一方、PIDファイルのバリデーションが実際に必要なのは:
- `build-and-start.sh` L70: `OLD_PID=$(cat "$PID_FILE")` -- バリデーションなし
- `stop-server.sh` L28: `PID=$(cat "$PID_FILE")` -- バリデーションなし

**推奨対応**:
実装タスクを実際の修正対象ファイル・行番号に即して書き直すべき:
1. `build-and-start.sh` L70: PIDファイル読み取り時の数値バリデーション追加
2. `build-and-start.sh` L69-76: `already running`判定にポート使用チェック（`lsof -ti:$PORT`）を追加
3. `stop-server.sh` L28: PIDファイル読み取り時の数値バリデーション追加
4. `stop.sh` L25: 複数PID対応（`echo "$PID" | xargs kill`方式への変更）
5. `stop-server.sh` L11: CM_PORT環境変数対応

---

## Should Fix（推奨対応）

### SF-1: stop.shの複数PID返却時の問題が指摘されていない

**カテゴリ**: 完全性
**場所**: ## 背景・課題 セクション

**問題**:
`stop.sh` L22で`lsof -ti:$PORT`が複数PIDを改行区切りで返す場合（next-serverと親npmプロセスが同ポートをリッスン等）、L25の`kill "$PID"`はダブルクォート内で複数行が1引数になり、「invalid signal specification」エラーとなる可能性がある。

**証拠**:
```bash
# stop.sh L25 -- ダブルクォート内で複数行が問題に
kill "$PID"

# stop-server.sh L22 -- 正しく複数PID対応
echo "$PIDS" | xargs kill -9 2>/dev/null
```

**推奨対応**:
この問題をIssueの「背景・課題」セクションに追記し、`stop-server.sh`の`xargs`方式への統一を実装タスクに含めること。

---

### SF-2: kill -9（SIGKILL）の即時使用に対する設計判断の欠如

**カテゴリ**: 技術的妥当性
**場所**: ## 提案する解決策 セクション

**問題**:
`stop-server.sh`はSIGKILL（`kill -9`）を即座に使用しており、プロセスにクリーンアップの機会を与えない。一方、CLI側（`src/cli/utils/daemon.ts` L146-153）はSIGTERM→waitForExit→SIGKILLの段階的停止を実装している。

**証拠**:
- `stop-server.sh` L22/L32/L45: すべて`kill -9`を即時使用
- `src/cli/utils/daemon.ts` L146-153: `const signal = force ? 'SIGKILL' : 'SIGTERM'` -- 段階的停止

**推奨対応**:
SIGTERM→タイムアウト後SIGKILL方式の採用を検討すべき。少なくとも設計判断をIssueに記載すること。

---

### SF-3: 受入条件が抽象的で検証手順が不明確

**カテゴリ**: 受け入れ条件
**場所**: ## 受入条件 セクション

**問題**:
3つの受入条件はすべて「...できること」という定性的記述のみで、具体的な再現手順・検証コマンドが記載されていない。

**推奨対応**:
各条件に検証手順を追加:
1. 「PIDファイルが不正な場合でも...」 → `echo -e "12345\n67890" > logs/server.pid && ./scripts/stop-server.sh && lsof -ti:3000`
2. 「再起動後に古いプロセスが残留しない」 → `./scripts/build-and-start.sh --daemon && sleep 5 && ./scripts/build-and-start.sh --daemon && lsof -ti:3000 | wc -l` が1以下
3. 「既存動作に影響がない」 → 正常なPIDファイルでの停止・起動・再起動サイクルテスト手順

---

### SF-4: stop-server.shのポート番号がハードコード（3000固定）

**カテゴリ**: 完全性
**場所**: ## 実装タスク セクション

**問題**:
`stop-server.sh` L11: `PORT=3000`はハードコードされており、CM_PORT環境変数に対応していない。

**証拠**:
| スクリプト | ポート取得方法 |
|-----------|---------------|
| `stop.sh` L21 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` |
| `status.sh` L27 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` |
| `health-check.sh` L10 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` |
| `stop-server.sh` L11 | `PORT=3000` （ハードコード） |

**推奨対応**:
`stop-server.sh`のCM_PORT対応を実装タスクに追加すべき。Issue #136のworktree並列開発（ポート自動割当）では3000以外のポートが使用されるため、この問題は実際の運用に影響する。

---

### SF-5: CLI側の停止メカニズムとの関係が言及されていない

**カテゴリ**: 整合性
**場所**: Issue全体

**問題**:
`commandmate stop`コマンド（`src/cli/commands/stop.ts` + `src/cli/utils/daemon.ts` + `src/cli/utils/pid-manager.ts`）は独自のPIDファイル管理と停止メカニズムを持っている。shellスクリプト群との関係・使い分けが明示されていない。

**証拠**:
- `src/cli/utils/pid-manager.ts` L43: `.trim()`と`parseInt()`でPIDバリデーション実装済み
- `src/cli/utils/daemon.ts` L133-161: SIGTERM→waitForExit段階的停止を実装済み
- CLIはshellスクリプトよりも堅牢な実装

**推奨対応**:
修正範囲にCLI側の影響有無を明示し、shellスクリプトとCLIの使い分け方針をIssueに記載すべき。

---

## Nice to Have（あれば良い）

### NTH-1: restart.shとの整合性が未考慮

**カテゴリ**: 完全性

`restart.sh` L21-24では`stop.sh`を呼び出してから`start.sh`を実行する。`stop.sh`の修正は`restart.sh`の動作にも影響するため、テスト範囲として言及すべき。

---

### NTH-2: 問題の再現条件・メモリ消費の根拠が不足

**カテゴリ**: 完全性

「実測: 316MB」のメモリ消費について、再現手順・環境情報・プロセス一覧（`ps aux`出力等）を記載すると、問題の深刻度と修正の優先度が明確になる。

---

### NTH-3: lsofコマンドの可用性に対する考慮

**カテゴリ**: 技術的妥当性

`lsof`はmacOSでは標準搭載だが、一部のLinuxディストリビューション（Alpine Linux等）ではデフォルトで未インストールの場合がある。ただし現行スクリプトがすべて`lsof`を前提としているため、本Issueのスコープ外として扱ってもよい。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `scripts/stop.sh` | Issue記載と実態が大きく乖離する主要対象。既にポートベース停止を実装済み |
| `scripts/build-and-start.sh` | L69-76のalready running判定がPIDファイルのみで、実際の修正が必要 |
| `scripts/stop-server.sh` | Issueで未言及だが、多層停止処理を実装済みの重要スクリプト |
| `scripts/restart.sh` | stop.shを呼び出しており、修正の影響を受ける |
| `src/cli/utils/pid-manager.ts` | CLI側のPIDファイル管理。trim()+parseInt()バリデーション実装済み |
| `src/cli/utils/daemon.ts` | CLI側の停止処理。段階的停止（SIGTERM→SIGKILL）を実装済み |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト全体のスクリプト構成・コマンド体系の参照 |

---

## 総括

Issue #401は実際に存在する問題（古いプロセス残留、build-and-start.shのalready running誤判定）を指摘している点で価値がある。しかし、**問題の分析と対象スクリプトの特定が不正確**であり、提案する解決策と実装タスクがコードの実態と大きく乖離している。

以下の順序で修正を推奨する:
1. Issue本文の事実誤認を修正し、実際のコードに基づく正確な問題記述にする
2. `stop-server.sh`の存在と`stop.sh`との機能差分を明示する
3. 実装タスクを実際の修正対象ファイル・行番号に即して書き直す
4. 受入条件に具体的な検証手順を追加する
