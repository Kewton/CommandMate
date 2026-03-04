# Issue #401 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**全体評価**: 中リスク

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 6 |
| Nice to Have | 3 |
| **合計** | **11** |

Issue #401の修正はシェルスクリプト群（stop.sh, stop-server.sh, build-and-start.sh）に限定されており、CLIモジュール（commandmate stop/start）への直接的なコード変更は不要である。しかし、以下の2点が影響範囲分析で重要な未考慮事項として特定された。

1. **PIDファイルパスの分断**: シェルスクリプト群（`logs/server.pid`）とCLI（`~/.commandmate/.commandmate.pid`）が異なるPIDファイルパスを使用しており、相互運用できない制約が未記載。
2. **rebuild SKILLへの影響**: `.claude/skills/rebuild/SKILL.md`が`stop.sh + build-and-start.sh --daemon`を連続実行しており、影響範囲テーブルに未記載。

---

## 影響エリア一覧

| エリア | 重要度 | 影響内容 |
|--------|--------|----------|
| `scripts/stop.sh` | High | 直接修正対象。restart.sh, rebuild SKILLから呼び出される |
| `scripts/stop-server.sh` | High | 直接修正対象。setup.shのヘルプで案内される |
| `scripts/build-and-start.sh` | High | 直接修正対象。setup.sh Step 4から呼び出される |
| `scripts/restart.sh` | Medium | 修正なし。stop.sh呼び出しの影響テスト対象 |
| `.claude/skills/rebuild/SKILL.md` | Medium | 修正なし。stop.sh + build-and-start.sh連続実行のテスト対象 |
| `scripts/status.sh` | Low | 修正なし。複数PID表示の一貫性確認対象 |
| `scripts/setup.sh` | Low | 修正なし。build-and-start.sh呼び出しの影響テスト対象 |
| CLI (daemon.ts / pid-manager.ts) | Low | 修正不要。PIDファイルパス分断の制約確認対象 |
| `docs/DEPLOYMENT.md` | Low | ドキュメント整合性確認対象 |

---

## Must Fix（必須対応）

### IF-001: シェルスクリプトとCLIのPIDファイルパス分断がIssueで未考慮

**カテゴリ**: 影響範囲
**重要度**: Must Fix

**問題**:
シェルスクリプト群とCLIが異なるPIDファイルパスを使用しており、相互運用できない制約がIssueに記載されていない。

| コンポーネント | PIDファイルパス |
|---------------|----------------|
| `build-and-start.sh` / `stop-server.sh` | `$PROJECT_DIR/logs/server.pid` |
| CLI (`commandmate start/stop`) | `~/.commandmate/.commandmate.pid`（グローバル） |
| CLI worktree | `~/.commandmate/pids/{issueNo}.pid` |

**証拠**:

`scripts/build-and-start.sh` L18:
```bash
PID_FILE="$LOG_DIR/server.pid"
```

`src/cli/utils/env-setup.ts` L149-161:
```typescript
export function getPidFilePath(issueNo?: number): string {
  const configDir = _getConfigDir();
  if (issueNo !== undefined) {
    const pidsDir = getPidsDir();
    // ...
    return join(pidsDir, `${issueNo}.pid`);
  }
  return join(configDir, '.commandmate.pid');
}
```

この分断により:
- `build-and-start.sh --daemon`で起動 → `commandmate stop`で停止不可
- `commandmate start --daemon`で起動 → `stop-server.sh`で停止不可（ポートベースでは停止可能だがCLIのPIDファイルが残留）

**推奨対応**:
Issueの「参考: CLI側の停止メカニズムとの関係」セクションにPIDファイルパスの分断を明記し、本Issueのスコープ外であることを明確にすべき。

---

### IF-002: rebuild SKILLへの影響がIssueの影響範囲テーブルに未記載

**カテゴリ**: 影響範囲
**重要度**: Must Fix

**問題**:
`.claude/skills/rebuild/SKILL.md`では以下のコマンドを連続実行する:

```bash
cd {TARGET_DIR} && ./scripts/stop.sh && ./scripts/build-and-start.sh --daemon
```

stop.shの修正（複数PID対応、停止後確認処理の追加）はrebuildスキルの実行フローに直接影響する。特にstop.shが新たにプロセス生存チェック（`kill -0`）を追加する場合、スクリプトの終了コードや実行時間が変わり、`&&`チェーンに影響する可能性がある。

**証拠**:

`.claude/skills/rebuild/SKILL.md` L39:
```bash
cd {TARGET_DIR} && ./scripts/stop.sh && ./scripts/build-and-start.sh --daemon
```

**推奨対応**:
Issueの「影響範囲」テーブルに`| .claude/skills/rebuild/SKILL.md | 修正なし（stop.sh + build-and-start.sh連続実行のテスト対象） |`を追加すべき。

---

## Should Fix（推奨対応）

### IF-003: xargsコマンドのGNU/BSD間の動作差異に対する考慮不足

**カテゴリ**: 互換性

**問題**:
xargsはGNU（Linux）とBSD（macOS）で空入力時の動作が異なる。GNU xargsはデフォルトで引数なしでもコマンドを実行するが、BSD xargsは引数なしでは実行しない。

現行のstop-server.shではL20の`if [ -n "$PIDS" ]`で空チェック後にxargsを呼び出しているため問題ないが、stop.shの修正時も同様のガードを維持する必要がある。

**推奨対応**:
- stop.shの修正時に`if [ -n "$PID" ]`のガードを維持すること
- `xargs kill 2>/dev/null`のようにエラー出力を抑制すること
- Issueの実装タスクに「xargs呼び出し前のPID空チェック維持」を注記として追加

---

### IF-004: build-and-start.shのCM_PORT環境変数未対応がポートベースalready running判定に影響

**カテゴリ**: 影響範囲

**問題**:
build-and-start.shは現在CM_PORT環境変数を参照していない。ポートベースのalready running判定を追加する場合、`$PORT`の値をどこから取得するかが問題となる。

各スクリプトのポート設定状況:

| スクリプト | ポート設定 |
|-----------|-----------|
| `stop.sh` L21 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` |
| `status.sh` L27 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` |
| `health-check.sh` L10 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` |
| `stop-server.sh` L11 | `PORT=3000` (Issue #401で修正予定) |
| `build-and-start.sh` | **ポート変数なし** |

**推奨対応**:
build-and-start.shの冒頭に`PORT=${CM_PORT:-${MCBD_PORT:-3000}}`を追加し、他スクリプトと統一すべき。この変更をIssueの実装タスクに明示的に含めること。

---

### IF-005: 並行実行（commandmate start --issue XXX）環境での影響が未分析

**カテゴリ**: 影響範囲

**問題**:
Issue #136のworktree並列開発機能により、`commandmate start --issue 135`のように複数サーバーが異なるポート（3001-3100）で起動できる。stop-server.shのCM_PORT対応により`CM_PORT=3035 ./scripts/stop-server.sh`でworktreeサーバーを停止できるようになるが、CLIのPIDファイル（`~/.commandmate/pids/135.pid`）が残留する。

**証拠**:

`src/cli/utils/port-allocator.ts` L86-87:
```typescript
const basePort = this.range.min + (issueNo % (this.range.max - this.range.min));
```

**推奨対応**:
Issueに「worktreeサーバーの停止にはcommandmate stop --issue XXXを使用すべき。シェルスクリプト経由で停止した場合、CLIのPIDファイルが残留する」旨を記載すること。

---

### IF-006: lsof出力をkillコマンドに渡す際のPIDバリデーション不足

**カテゴリ**: セキュリティ

**問題**:
stop.shおよびstop-server.shでは`lsof -ti:$PORT`の出力を直接killコマンドに渡している。防御的プログラミングの観点からは、killに渡す前にPIDが数値であることを検証すべきである。特にstop-server.shのL32では`kill -9 -$PID`（プロセスグループkill）を使用しており、不正な値が含まれると危険である。

CLI側の参考実装（`src/cli/utils/pid-manager.ts` L43-46）:
```typescript
const content = readFileSync(this.pidFilePath, 'utf-8').trim();
const pid = parseInt(content, 10);
if (isNaN(pid) || pid <= 0) {
  return null;
}
```

**推奨対応**:
- PIDファイル読み取り値: `grep -E '^[0-9]+$'`で数値バリデーション
- lsof出力: `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$'`でフィルタリング

---

### IF-007: lsof -tの重複PID出力に対する考慮

**カテゴリ**: 互換性

**問題**:
同一プロセスがIPv4とIPv6の両方でポートをリッスンする場合、`lsof -ti:$PORT`が同一PIDを複数回出力することがある。killが同一PIDに対して複数回呼ばれると、2回目以降で「No such process」エラーが出力される。

**推奨対応**:
`lsof -ti:$PORT 2>/dev/null | sort -u`のように重複PID除去を追加することを推奨。

---

### IF-008: status.shのPID表示も複数PID対応が必要

**カテゴリ**: 運用

**問題**:
`scripts/status.sh` L29の`PID=$(lsof -ti:$PORT)`もstop.shと同様に複数PIDを変数に格納する。表示目的のため動作上の問題は軽微だが、一貫性の観点から言及すべき。

**証拠**:

`scripts/status.sh` L28-33:
```bash
if lsof -ti:$PORT &> /dev/null; then
  PID=$(lsof -ti:$PORT)
  echo "Process:"
  echo "  Port: $PORT"
  echo "  PID: $PID"
```

**推奨対応**:
Issueの影響範囲テーブルに`| scripts/status.sh | 修正なし（複数PID表示の一貫性確認対象） |`を追加。

---

## Nice to Have（あれば良い）

### IF-009: setup.shの初回セットアップフローへの影響確認

**カテゴリ**: 運用

`scripts/setup.sh` L118で`build-and-start.sh --daemon`を呼び出している。修正後は起動前にポート使用を検知してエラーメッセージを表示する（ユーザー体験の改善）。テスト範囲として明示すべき。

---

### IF-010: docs/DEPLOYMENT.mdのトラブルシューティングとの整合性

**カテゴリ**: 影響範囲

`docs/DEPLOYMENT.md` L320-321に`lsof -ti:3000 | xargs kill -9`が記載されている。stop-server.shで段階的停止を導入する場合、ドキュメントとの整合性確認が必要だが、本Issueのスコープ外としてよい。

---

### IF-011: テスト・CI/CDへの影響は限定的

**カテゴリ**: 影響範囲

GitHub Actions CI/CD（ci-pr.yml, publish.yml）ではシェルスクリプト群を直接呼び出していない。シェルスクリプトの自動テストは存在しないため、手動テスト（受入条件の検証手順）が主な品質担保手段となる。将来的にbats-core等のテスト導入を検討してもよいが、本Issueのスコープ外。

---

## スクリプト呼び出し依存関係図

```
setup.sh
  └── build-and-start.sh --daemon  [修正対象]
        └── (PID_FILE: logs/server.pid)

restart.sh
  ├── stop.sh  [修正対象]
  └── start.sh

rebuild SKILL
  ├── stop.sh  [修正対象]
  └── build-and-start.sh --daemon  [修正対象]

stop-server.sh  [修正対象]
  └── (PID_FILE: logs/server.pid, 同一ファイル)

CLI (commandmate start/stop)
  └── daemon.ts → pid-manager.ts
        └── (PID_FILE: ~/.commandmate/.commandmate.pid)  [異なるパス]
```

---

## 参照ファイル

### 直接修正対象
| ファイル | 修正内容 |
|---------|---------|
| `scripts/stop.sh` | 複数PID対応（xargs kill方式）、停止後確認 |
| `scripts/stop-server.sh` | CM_PORT対応、PIDバリデーション、段階的停止 |
| `scripts/build-and-start.sh` | PIDバリデーション、ポートベースalready running判定 |

### 影響テスト対象
| ファイル | 確認内容 |
|---------|---------|
| `scripts/restart.sh` | stop.sh修正後のrestart動作 |
| `scripts/setup.sh` | build-and-start.sh修正後のsetup動作 |
| `.claude/skills/rebuild/SKILL.md` | stop.sh + build-and-start.sh連続実行 |
| `scripts/status.sh` | 複数PID表示の一貫性 |

### 参考（修正不要）
| ファイル | 参照理由 |
|---------|---------|
| `src/cli/utils/daemon.ts` | 段階的停止の参考実装（L133-161） |
| `src/cli/utils/pid-manager.ts` | PIDバリデーションの参考実装（L43-46） |
| `src/cli/utils/env-setup.ts` | CLIのPIDファイルパス確認（L149-161） |
| `src/cli/utils/port-allocator.ts` | worktreeポート割当範囲の確認 |
| `docs/DEPLOYMENT.md` | ドキュメント整合性確認 |

---

## 総合評価

Issue #401の修正スコープはシェルスクリプト群に限定されており、CLIモジュールへの直接的なコード変更は不要である。修正の主なリスクは以下の3点:

1. **PIDファイルパス分断の認識不足**: シェルスクリプトとCLIが異なるPIDファイルを使用する制約がIssueで未記載であり、混乱を招く可能性がある。（IF-001）
2. **呼び出し元スクリプトへの影響**: restart.sh、rebuild SKILL、setup.shがstop.shまたはbuild-and-start.shを呼び出しており、修正の波及テストが必要。（IF-002）
3. **OS互換性**: xargsおよびlsofの動作差異（GNU vs BSD）への考慮が必要。（IF-003, IF-007）

これらの点をIssueに反映することで、実装時のリスクを軽減できる。CI/CDへの影響はなく、既存のユニットテスト・結合テストへの影響もないため、全体としては**中リスク**と評価する。
