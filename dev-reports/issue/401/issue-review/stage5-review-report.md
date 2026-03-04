# Issue #401 Stage 5 レビューレポート（通常レビュー 2回目）

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 2回目
**対象Issue**: fix: stop.shが古いサーバープロセスを取りこぼす問題の修正

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 1 |
| **合計** | **3** |

**総合評価**: 良好

Stage 1-4で指摘された全19件の適用対象指摘事項（must_fix 6件、should_fix 11件、nice_to_have 2件）が正しくIssueに反映されていることを確認した。Issue本文の行番号参照は全て実際のソースコードと一致しており、技術的な記述の正確性は高い。2回目レビューで新たに発見された3件の指摘はいずれもshould_fix以下であり、Issueは実装可能な品質に達している。

---

## 前回指摘事項の反映確認

### Stage 1（通常レビュー 1回目）: 12件中10件反映、2件妥当なスキップ

| ID | 重要度 | 反映状況 | 詳細 |
|----|--------|----------|------|
| MF-1 | must_fix | 反映済み | stop.shのPIDファイルベースという誤記述を削除し、ポートベース停止の正確な記述に修正 |
| MF-2 | must_fix | 反映済み | 的外れな提案を削除し、複数PID対応・xargs方式への変更を正確に記載 |
| MF-3 | must_fix | 反映済み | stop-server.shの存在・役割・機能差分を「停止スクリプトの構成」テーブルで明記 |
| MF-4 | must_fix | 反映済み | 実装タスクをファイル名・行番号レベルで正確に書き直し |
| SF-1 | should_fix | 反映済み | 複数PID対応不備を「問題1」として詳述 |
| SF-2 | should_fix | 反映済み | SIGKILL即時使用の懸念を「問題5」として記載 |
| SF-3 | should_fix | 反映済み | 受入条件6項目に具体的な検証手順を追加 |
| SF-4 | should_fix | 反映済み | ポートハードコード問題を「問題4」として記載、比較テーブル付き |
| SF-5 | should_fix | 反映済み | CLI停止メカニズムとの関係を「参考」セクションで詳細に記載 |
| NTH-1 | nice_to_have | 反映済み | restart.shの影響を受入条件と影響範囲テーブルに追記 |
| NTH-2 | nice_to_have | スキップ（妥当） | メモリ消費の再現手順はIssue報告者が追記すべき情報 |
| NTH-3 | nice_to_have | スキップ（妥当） | lsof可用性は本Issueスコープ外 |

### Stage 3（影響範囲レビュー 1回目）: 11件中8件反映、3件妥当なスキップ

| ID | 重要度 | 反映状況 | 詳細 |
|----|--------|----------|------|
| IF-001 | must_fix | 反映済み | PIDファイルパスの分断を「参考」セクションに明記 |
| IF-002 | must_fix | 反映済み | rebuild SKILLを影響範囲テーブルに追加 |
| IF-003 | should_fix | 反映済み | xargsのGNU/BSD差異を「互換性に関する注意事項」に記載 |
| IF-004 | should_fix | 反映済み | build-and-start.shのCM_PORT対応を実装タスクに追加 |
| IF-005 | should_fix | 反映済み | worktree並列環境での制約を「参考」セクションに追記 |
| IF-006 | should_fix | 反映済み | lsof出力のPIDバリデーションを実装タスクに追加 |
| IF-007 | should_fix | 反映済み | lsof出力の重複PID除去を実装タスクに追加 |
| IF-008 | should_fix | 反映済み | status.shを影響範囲テーブルに追加 |
| IF-009 | nice_to_have | スキップ（妥当） | setup.shへの影響は軽微 |
| IF-010 | nice_to_have | スキップ（妥当） | docs更新は本Issueスコープ外 |
| IF-011 | nice_to_have | スキップ（妥当） | CI/CD影響なし |

---

## 行番号参照の正確性検証

Issueで参照されている全ての行番号をソースコードと照合し、全て正確であることを確認した。

| ファイル | 行番号 | Issue記載内容 | 検証結果 |
|---------|--------|-------------|----------|
| `scripts/stop.sh` | L21 | `PORT=${CM_PORT:-${MCBD_PORT:-3000}}` | 正確 |
| `scripts/stop.sh` | L22 | `PID=$(lsof -ti:$PORT 2>/dev/null \|\| true)` | 正確 |
| `scripts/stop.sh` | L25 | `kill "$PID"` | 正確 |
| `scripts/build-and-start.sh` | L69-76 | PIDファイルチェックブロック | 正確 |
| `scripts/build-and-start.sh` | L70 | `OLD_PID=$(cat "$PID_FILE")` | 正確 |
| `scripts/stop-server.sh` | L11 | `PORT=3000` | 正確 |
| `scripts/stop-server.sh` | L22 | `echo "$PIDS" \| xargs kill -9` | 正確 |
| `scripts/stop-server.sh` | L28 | `PID=$(cat "$PID_FILE")` | 正確 |
| `scripts/stop-server.sh` | L32 | `kill -9 -$PID` | 正確 |
| `scripts/stop-server.sh` | L42 | 残留チェック lsof | 正確 |
| `scripts/stop-server.sh` | L45 | `echo "$REMAINING" \| xargs kill -9` | 正確 |
| `scripts/status.sh` | L27 | `PORT=${CM_PORT:-...}` | 正確 |
| `scripts/status.sh` | L29 | `PID=$(lsof -ti:$PORT)` | 正確 |
| `scripts/health-check.sh` | L10 | `PORT=${CM_PORT:-...}` | 正確 |
| `src/cli/utils/daemon.ts` | L133-161 | stop()メソッド | 正確 |
| `src/cli/utils/pid-manager.ts` | L43-44 | trim() + parseInt() | 正確 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### F2-001: lsof PIDバリデーションと重複除去の実装タスク統合

**カテゴリ**: 明確性
**場所**: 実装タスク セクション（最後の2項目）

**問題**:
実装タスクに以下の2項目が別々のチェックボックスとして記載されている:
- 「lsof出力のPIDバリデーション追加: `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$'`」
- 「lsof出力の重複PID除去: `lsof -ti:$PORT 2>/dev/null | sort -u`」

実際の実装では `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u` のように1つのパイプラインに統合される。タスクが分かれていると、一方のみ適用して他方を忘れるリスクがある。

**推奨対応**:
2つのタスクを1つに統合し、「lsof出力のパイプライン強化: `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u` で数値バリデーションと重複除去を統合（stop.sh, stop-server.sh共通。build-and-start.shは新規追加のポートベース判定に適用）」とする。

---

#### F2-002: stop.shの停止失敗時のフォールバック動作が不明確

**カテゴリ**: 完全性
**場所**: 実装タスク セクション（stop.sh関連タスク）

**問題**:
stop.shの実装タスクに「停止後のプロセス確認（kill -0による生存チェック）を追加」があるが、生存確認後に何をするか（SIGKILLで強制停止するか、エラーメッセージのみ出力するか）が不明確。stop-server.shはL42-47で残留プロセスの二段構え（再度lsofで検出してxargs kill -9）を実装済みであり、stop.shにも同等の処理を追加するか否かを明確にすべき。

現在のstop.shの `kill "$PID"` はデフォルトSIGTERMを送信するため、stop-server.shの即時SIGKILLとは異なるアプローチを取っている。修正後もstop.shはSIGTERM方式を維持しつつ、生存確認でプロセスが残っていた場合にSIGKILLへエスカレーションする設計が望ましいが、この判断がIssueに記載されていない。

**推奨対応**:
stop.shの実装タスク「停止後のプロセス確認（kill -0による生存チェック）を追加」の直後に、「残留プロセスがある場合はSIGKILLで強制停止する（stop-server.sh L42-47と同等の二段構え）」のようにフォールバック動作を明記する。

---

### Nice to Have（あれば良い）

#### F2-003: build-and-start.shフォアグラウンドモードのポート競合検知未考慮

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

**問題**:
実装タスクではbuild-and-start.shの--daemonモード（L65-103）のalready running判定改善に焦点を当てているが、フォアグラウンドモード（L104-112）にはポート競合チェックが存在しない。フォアグラウンドモードでは `npm start` がポート競合時にエラーを出力するため実害は少ないが、ユーザー体験の一貫性の観点からは改善の余地がある。

**推奨対応**:
本Issueのスコープでは対応不要。フォアグラウンドモードではプロセス管理がユーザーに委ねられる（Ctrl+Cで停止）ため、本Issueの主題（古いプロセスの残留）とは直接関係しない。将来的な改善として認識するにとどめる。

---

## Issue全体の一貫性・完全性評価

### 一貫性: 良好

- 問題記述（背景・課題）と提案する解決策と実装タスクの間に矛盾はない
- 5つの問題点それぞれに対応する実装タスクが存在する
- 受入条件は各問題点をカバーしている
- 影響範囲テーブルは修正対象と確認対象を明確に区別している
- CLI側との分断についてスコープ外であることが明示されている

### 完全性: 概ね良好

- 全ての修正対象ファイルの問題点が行番号レベルで特定されている
- 互換性注意事項（xargs GNU/BSD差異、lsof重複PID）が記載されている
- PIDファイルパスの分断とworktree並列環境の制約が明記されている
- 唯一の懸念はstop.shの生存確認後フォールバック動作の不明確さ（F2-002）

### 正確性: 優秀

- 全行番号参照がソースコードと一致（16箇所全て検証済み）
- コードスニペットが実際のコードと完全に一致
- スクリプト間の呼び出し関係（restart.sh -> stop.sh, rebuild SKILL -> stop.sh + build-and-start.sh, setup.sh -> build-and-start.sh）が正確
- CLI側の実装詳細（daemon.tsのSIGTERM→waitForExit→SIGKILL、pid-manager.tsのtrim()+parseInt()）が正確

### 明確性: 良好

- 各問題点にbashコードスニペットが付与されており、問題箇所が一目でわかる
- 比較テーブル（ポート設定の対応状況）で差異が視覚的に理解しやすい
- 受入条件に具体的な検証手順が記載されている

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `scripts/stop.sh` | 直接修正対象。全行番号参照が正確。 |
| `scripts/stop-server.sh` | 直接修正対象。全行番号参照が正確。 |
| `scripts/build-and-start.sh` | 直接修正対象。全行番号参照が正確。フォアグラウンドモード未考慮。 |
| `scripts/restart.sh` | 影響テスト対象。L21でstop.sh呼び出し。 |
| `scripts/status.sh` | 確認対象。L27, L29参照正確。 |
| `scripts/health-check.sh` | 比較参照。L10のCM_PORT対応が比較テーブルと一致。 |
| `.claude/skills/rebuild/SKILL.md` | 影響テスト対象。stop.sh + build-and-start.sh連続実行パターン。 |
| `src/cli/utils/daemon.ts` | 参考実装。L133-161の段階的停止。 |
| `src/cli/utils/pid-manager.ts` | 参考実装。L43-44のPIDバリデーション。 |
| `src/cli/utils/env-setup.ts` | PIDファイルパス確認。L157, L160。 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト全体のスクリプト構成・コマンド体系の参照ドキュメント |
