# Issue #403 レビューレポート - Stage 7

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**Stage**: 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 2 |

**総合評価**: good

Stage 3で指摘した3件のshould_fix項目（IF-1/IF-2/IF-3）は全て適切にIssueに反映されている。新たな影響範囲の見落としは発見されなかった。Issue全体の品質は良好であり、実装に着手可能な状態と判断する。

---

## Stage 3 指摘事項の反映確認

### IF-1: logs.shの認識事項 -> resolved

**元の指摘**: logs.shがbuild-and-start.sh --daemonのログ表示に対応していない。ローテーション済みログの閲覧手段がない。

**反映状況**: 「影響範囲に関する注記」セクションが新設され、以下が全て明記されている。
- scripts/logs.sh が現状 PM2/systemd のみ対応であること
- build-and-start.sh --daemon 起動時の logs/server.log の表示に未対応であること（既存の課題）
- ローテーション済みログ（server.log.1等）の閲覧手段が logs.sh にないこと
- 本Issue のスコープ外であり、必要に応じて別Issue で対応する旨

**コード整合性確認**: `scripts/logs.sh` L27-29 の実際の出力（"No logs found. Application may not be running with PM2 or systemd."）と整合。

---

### IF-2: restart.shのローテーション非実行 -> resolved

**元の指摘**: restart.sh（stop.sh + start.sh経路）ではローテーションが実行されない。build-and-start.sh経由と動作が異なる。

**反映状況**: 設計方針セクションの「ローテーション実行経路」項目に以下が明記されている。
- build-and-start.sh を経由する起動（直接実行、setup.sh Step 4、rebuild SKILL）でのみ実行
- restart.sh は PM2 を使用する起動パスであり、PM2 には独自のログ管理があるため影響は限定的

**コード整合性確認**:
- `scripts/restart.sh` L11-18: PM2分岐（pm2 restart）
- `scripts/restart.sh` L20-24: stop.sh + start.sh 分岐（build-and-start.sh を呼ばない）
- `.claude/skills/rebuild/SKILL.md` L39: stop.sh + build-and-start.sh --daemon（ローテーション実行経路に含まれる）

全ての記載がソースコードと整合している。

---

### IF-3: テスト手順の具体化 -> resolved

**元の指摘**: テスト追加タスクが漠然としており、bashスクリプトのテスト方針が不明確。

**反映状況**: 「テスト手順」サブセクションが新設され、以下が具体的なコマンド付きで記載されている。
- **基本動作テスト**: dd if=/dev/zero bs=1M count=15 で15MBファイル作成、build-and-start.sh --daemon 実行、server.log.1 作成確認
- **世代管理テスト**: 3世代存在時のシフトと最古世代（server.log.3）の削除確認
- **エッジケース**: ファイル未存在/閾値未満/ディレクトリ未存在の3パターン
- 受入条件にも「上記テスト手順がすべてパスすること」を追加
- Vitest スコープ外であることが冒頭に明記

テスト手順は網羅的であり、基本パス・世代シフト・境界条件を全てカバーしている。

---

## Nice to Have

### NTH-1: PRODUCTION_CHECKLIST.md日本語版の明示

**カテゴリ**: ドキュメント更新
**場所**: 実装タスク セクション - PRODUCTION_CHECKLIST.md更新タスク

**指摘**:
実装タスクのPRODUCTION_CHECKLIST.md更新は英語版（`docs/en/internal/PRODUCTION_CHECKLIST.md`）のみ言及している。日本語版（`docs/internal/PRODUCTION_CHECKLIST.md` L164）にも同じ「ログのローテーション設定がされている（オプション）」項目が存在する。Stage 3 IF-4、Stage 5 NTH-1から引き続きの指摘。

**推奨対応**:
実装タスクを「`docs/en/internal/PRODUCTION_CHECKLIST.md` および `docs/internal/PRODUCTION_CHECKLIST.md` の Log rotation 項目にビルトインローテーションの説明を追加」に変更する。

---

### NTH-2: Monthly Log cleanup項目への影響

**カテゴリ**: 影響ファイル
**場所**: 実装タスク セクション（間接影響）

**指摘**:
PRODUCTION_CHECKLIST.mdの「Monthly」セクション（英語版L344-345 "Log cleanup"、日本語版L344-345 "ログのクリーンアップ"）に月次のLog cleanupタスクが記載されている。ローテーション機能の導入により自動で古い世代が削除されるため、この手動Log cleanupの必要性が変わる可能性がある。Stage 3 IF-5から引き続きの指摘。

**推奨対応**:
PRODUCTION_CHECKLIST.md更新時に、Monthly Log cleanup項目に「ビルトインローテーション有効時は自動的に古い世代が削除される」旨の補足を追加する。

---

## 影響範囲分析の検証

### 直接変更対象ファイル

| ファイル | 変更種別 | 検証結果 |
|---------|---------|---------|
| `scripts/build-and-start.sh` | modify | L17 LOG_FILE定義、L107 nohup追記を確認。ローテーション挿入位置はL106-107の間が適切 |
| `docs/en/internal/PRODUCTION_CHECKLIST.md` | modify | L164 Log rotation項目の更新 |
| `docs/internal/PRODUCTION_CHECKLIST.md` | modify | L164 日本語版Log rotation項目の更新（Issueでは英語版のみ明示） |

### 間接影響ファイル検証

| ファイル | 影響度 | 検証結果 |
|---------|--------|---------|
| `scripts/stop-server.sh` | none | LOG_DIR/PID_FILEを共有するがログ内容操作なし。影響なし確認済み |
| `scripts/restart.sh` | none (documented) | stop.sh + start.sh経路。ローテーション非実行。Issue記載と整合 |
| `scripts/setup.sh` | none | L118でbuild-and-start.sh --daemon呼び出し。初回は閾値未達で影響なし |
| `scripts/logs.sh` | none (documented) | PM2/systemdのみ対応。Issue記載と整合 |
| `scripts/status.sh` | none | ログファイル非参照 |
| `scripts/health-check.sh` | none | ログファイル非参照 |
| `.claude/skills/rebuild/SKILL.md` | none | logs/server.log参照あるがファイル名不変のため影響なし |
| `docs/user-guide/cli-setup-guide.md` | none | CLI経路のため影響なし |
| `src/config/log-config.ts` | none | data/logs/パスで完全に独立 |
| `src/cli/utils/daemon.ts` | none | L106 stdio:'ignore'でlogs/server.log非使用 |
| `.gitignore` | none | L52 logs/ディレクトリ全体除外。ローテーションファイルも自動除外 |

### 新規発見

Stage 3の影響範囲分析と比較して、新たな影響ファイルや見落としは発見されなかった。`server.log` への参照箇所を網羅的に検索（scripts/、docs/、.claude/、src/）した結果、全てIssue既存の分析に含まれている。

---

## 破壊的変更

なし。ローテーション機能の追加は既存の起動フロー・ログ表示フロー・停止フローに影響を与えない。

---

## 参照ファイル

### コード
- `scripts/build-and-start.sh`: ローテーション実装の主要対象（L17, L63, L107）
- `scripts/restart.sh`: ローテーション実行経路外の確認（L11-18, L20-24）
- `scripts/logs.sh`: PM2/systemdのみ対応の確認（L10-26）
- `scripts/setup.sh`: ローテーション実行経路の確認（L118）
- `scripts/stop-server.sh`: 影響なしの確認（L9-11）
- `.claude/skills/rebuild/SKILL.md`: ローテーション実行経路の確認（L39）
- `src/cli/utils/daemon.ts`: CLIデーモンモードでlogs/server.log非使用の確認（L106）
- `.gitignore`: logs/ディレクトリ除外の確認（L52）

### ドキュメント
- `docs/en/internal/PRODUCTION_CHECKLIST.md`: L164 Log rotation項目、L344-345 Monthly Log cleanup
- `docs/internal/PRODUCTION_CHECKLIST.md`: L164 日本語版Log rotation項目、L344-345 月次ログクリーンアップ
