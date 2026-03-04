# Issue #401 Stage 7 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2
**総合評価**: 低リスク

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 2 |

2回目の影響範囲レビューにおいて、Stage 3-4で指摘された全8件のmust_fix/should_fix（IF-001からIF-008）がIssueに正しく反映されていることを確認した。Stage 5-6で追加されたF2-001（lsofパイプライン統合）およびF2-002（stop.shのSIGKILLフォールバック明確化）も適切に反映済みである。

影響範囲テーブルは当初4行から9行に拡充され、以下を網羅している:

- **修正対象**: stop.sh / stop-server.sh / build-and-start.sh（3ファイル）
- **テスト対象**: restart.sh / rebuild SKILL（2件）
- **確認対象**: status.sh / setup.sh（2件）
- **スコープ外明示**: src/cli/ / docs/DEPLOYMENT.md（2件）

残存する影響範囲の問題は発見されなかった。nice_to_have 2件はIssue修正不要の実装時注意事項である。

---

## 前回指摘事項の反映状況確認

### Stage 3 Must Fix（2件） -- 全て反映済み

| ID | タイトル | 反映状況 |
|----|---------|---------|
| IF-001 | シェルスクリプトとCLIのPIDファイルパス分断 | 反映済み: 「参考」セクションに段落追加。env-setup.ts L160/build-and-start.sh L18と一致 |
| IF-002 | rebuild SKILLへの影響が未記載 | 反映済み: 影響範囲テーブルにSKILL.md追加。L39のパターン記載 |

### Stage 3 Should Fix（6件） -- 全て反映済み

| ID | タイトル | 反映状況 |
|----|---------|---------|
| IF-003 | xargsのGNU/BSD動作差異 | 反映済み: 「互換性に関する注意事項」新設セクション |
| IF-004 | build-and-start.shのCM_PORT未対応 | 反映済み: 実装タスクに明示的タスク追加 |
| IF-005 | worktree並列起動環境での制約 | 反映済み: 「参考」セクションに段落追加 |
| IF-006 | lsof出力のPIDバリデーション不足 | 反映済み（F2-001で統合パイプライン化） |
| IF-007 | lsofの重複PID | 反映済み（F2-001で統合パイプライン化） |
| IF-008 | status.shの複数PID対応 | 反映済み: 影響範囲テーブルに追加 |

### Stage 5 Should Fix（2件） -- 全て反映済み

| ID | タイトル | 反映状況 |
|----|---------|---------|
| F2-001 | lsofパイプラインタスクの統合 | 反映済み: 2タスクを1つの統合パイプラインに統合 |
| F2-002 | stop.shのSIGKILLフォールバック明確化 | 反映済み: 生存チェック後のkill -9強制停止を明記 |

---

## 影響範囲テーブルの完全性評価

### 修正対象ファイル（3件）

| ファイル | 実装タスク数 | 評価 |
|---------|------------|------|
| `scripts/stop.sh` | 3項目 | 十分。複数PID対応、空チェック維持+エラー抑制、生存チェック+SIGKILLフォールバック |
| `scripts/stop-server.sh` | 3項目 | 十分。CM_PORT対応、PIDバリデーション、段階的停止検討 |
| `scripts/build-and-start.sh` | 3項目 | 十分。CM_PORT対応、PIDバリデーション、ポートベース判定追加 |

### 間接影響対象（4件）

| ファイル | 種別 | 評価 |
|---------|------|------|
| `scripts/restart.sh` | テスト対象 | 適切。受入条件にも含まれている |
| `.claude/skills/rebuild/SKILL.md` | テスト対象 | 適切。&&チェーンへの影響を認識 |
| `scripts/status.sh` | 確認対象 | 適切。一貫性の観点から言及 |
| `scripts/setup.sh` | 確認対象 | 適切。初回セットアップへの影響を認識 |

### スコープ外明示（2件）

| ファイル | 理由 | 評価 |
|---------|------|------|
| `src/cli/` | PIDファイルパス分断 | 適切。分断の詳細と制約が明記されている |
| `docs/DEPLOYMENT.md` | 将来対応 | 適切。トラブルシューティングコマンドの整合性は別Issue |

---

## Nice to Have（実装時注意事項）

### IF7-001: stop.shのPM2パスとの整合性

**カテゴリ**: 実装注意事項

stop.sh（L11-17）にはPM2経由の停止パスが存在する。Issue #401の修正対象はelse節（L18-29）のlsof/killパスのみである。PM2パスには変更を加えないことを確認するだけで十分であり、Issueの記載は正確。

### IF7-002: build-and-start.shのset -eとの相互作用

**カテゴリ**: 実装注意事項

`build-and-start.sh` L12で `set -e` が設定されている。ポートベースalready running判定で使用する統合パイプライン `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u` において、grepがマッチなしで終了コード1を返す場合に `set -e` によりスクリプトが終了するリスクがある。

**対処方法**: 変数代入時に `|| true` を末尾に付ける。

```bash
PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
```

stop.sh L22では既に `|| true` パターンが使用されており、一貫性のある対処となる。

---

## 総合評価

**低リスク** -- Issue #401は実装着手可能な状態にある。

### 根拠

1. **影響範囲の網羅性**: 修正対象3ファイル、間接影響4件、スコープ外2件が全て影響範囲テーブルに記載されている
2. **前回指摘の完全反映**: Stage 3の8件およびStage 5の2件、計10件の指摘事項が全てIssueに正しく反映されている
3. **実装タスクの具体性**: ファイル名・行番号レベルで具体的な修正内容が記載されている
4. **受入条件の検証可能性**: 6項目全てに具体的な検証手順が付与されている
5. **互換性への配慮**: xargs GNU/BSD差異、lsof重複PIDの互換性注意事項が記載されている
6. **スコープの明確性**: CLIとの分断、worktree並列環境の制約、docs更新がスコープ外として明示されている

### 実装時の注意ポイント（まとめ）

- `build-and-start.sh` の `set -e` との相互作用に注意し、lsofパイプラインに `|| true` を付加する
- stop.shのPM2パス（L11-17）には変更を加えない
- 統合パイプライン `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u` を3ファイル共通で使用する

---

## 参照ファイル

### コード（直接修正対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/scripts/stop.sh`: 複数PID対応、生存チェック+SIGKILLフォールバック追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/scripts/stop-server.sh`: CM_PORT対応、PIDバリデーション、段階的停止
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/scripts/build-and-start.sh`: ポートベース判定、PIDバリデーション、CM_PORT対応

### コード（間接影響・参照）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/scripts/restart.sh`: テスト対象（stop.sh呼び出し）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/scripts/status.sh`: 確認対象（複数PID表示）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/scripts/setup.sh`: 確認対象（build-and-start.sh呼び出し）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/.claude/skills/rebuild/SKILL.md`: テスト対象（stop.sh + build-and-start.sh連続実行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/src/cli/utils/daemon.ts`: 段階的停止の参考実装（L133-161）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/src/cli/utils/pid-manager.ts`: PIDバリデーションの参考実装（L43-44）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/src/cli/utils/env-setup.ts`: PIDファイルパス（L157/L160）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-401/docs/DEPLOYMENT.md`: トラブルシューティングとの整合性（将来対応）
