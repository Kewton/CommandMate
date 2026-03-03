# Issue #405 Stage 1 レビューレポート

**レビュー日**: 2026-03-04
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目
**仮説検証結果**: 全5仮説 Confirmed

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 6 |
| Nice to Have | 4 |

**全体評価**: medium

Issue #405は問題の分析と背景説明が正確であり、全仮説がConfirmedとなった。課題の本質（N+1パターン、重複capture、ポーリング効率）を的確に捉えている。しかし、キャッシュ設計の詳細（行数差異への対応、無効化戦略）、captureSessionOutputの全呼び出し箇所の網羅、isRunning()のI/Oコストの考慮が不足している。

---

## Must Fix（必須対応）

### R1-007: 受入条件「UIのステータス更新遅延が体感上許容範囲」が検証不可能

**カテゴリ**: consistency
**場所**: 受入条件

**問題**:
受入条件の3番目「UIのステータス更新遅延が体感上許容範囲であること」は主観的であり、自動テストでの検証が不可能。パフォーマンス改善Issueにおいて、改善前後の定量的な比較基準がないと、リグレッションの検出も困難。

**推奨対応**:
以下のいずれかに具体化すべき:

- A案（定量的）: 「キャッシュ導入後、セッションステータスの反映遅延がキャッシュTTL（1-2秒）以内に収まること」
- B案（定性的＋条件付き）: 「ユーザーがコマンド送信後、次回ポーリングでステータスが更新されること（キャッシュ無効化が正しく動作すること）」
- C案（測定ベース）: 「10worktree環境でGET /api/worktreesのレスポンスタイムが改善前比50%以上改善されること」

少なくとも、改善前のベースラインレスポンスタイムを計測する手順を受入条件に含めるべき。

---

## Should Fix（推奨対応）

### R1-001: captureSessionOutput呼び出し箇所の網羅性不足

**カテゴリ**: completeness
**場所**: 背景・課題 > S3 / 影響範囲テーブル

**問題**:
Issueでは重複取得箇所を4つ列挙しているが、実際にはcaptureSessionOutput()を呼び出している箇所は少なくとも7箇所存在する。

列挙済み:
1. `src/app/api/worktrees/route.ts` (L57)
2. `src/app/api/worktrees/[id]/current-output/route.ts` (L70)
3. `src/lib/auto-yes-manager.ts` (L510)
4. `src/lib/response-poller.ts` (L1031)

**未列挙**:
5. `src/app/api/worktrees/[id]/route.ts` (L67) - 個別worktree取得API
6. `src/app/api/worktrees/[id]/prompt-response/route.ts` (L96) - プロンプト応答前の再検証
7. `src/lib/assistant-response-saver.ts` (L243) - 保留中レスポンス保存時

**推奨対応**:
影響範囲テーブルにこれら3ファイルを追加。ただしprompt-response APIはリアルタイム性要求が高いため、キャッシュバイパスが必要な可能性がある点を明記すること。

---

### R1-002: captureLines行数の差異がキャッシュ設計に与える影響の未記載

**カテゴリ**: correctness
**場所**: 提案する解決策 > 1. tmux captureキャッシュ導入

**問題**:
呼び出し箇所ごとにcaptureLines引数が大きく異なる:

| 呼び出し箇所 | captureLines |
|-------------|-------------|
| route.ts (worktrees一覧) | 100行 (opencode: 200行) |
| current-output API | 10,000行 |
| auto-yes-manager | 5,000行 |
| response-poller | 10,000行 |
| prompt-response | 5,000行 |

100行のキャッシュを10,000行要求に流用すると情報不足、逆はメモリ効率悪化。

**推奨対応**:
キャッシュ設計方針として以下を明記:
- A案: 最大行数でキャッシュし、少ない行数要求にはsliceで対応（推奨: シンプルで効果大）
- メモリ消費量の見積もり（10worktree x 10,000行 x 平均行長）を記載

---

### R1-003: isRunning()のtmux I/Oコストがキャッシュ対象として検討されていない

**カテゴリ**: completeness
**場所**: 背景・課題 > S1 / 実装タスク

**問題**:
全5つのCLIツールの`isRunning()`実装がtmux `has-session`コマンド（外部プロセス起動）を呼び出しており、10worktree x 5CLI = 50回のhasSession()だけでも相当なコスト。さらに`captureSessionOutput()`内部でも`hasSession()`を呼ぶため、1セッションあたり2回の重複呼び出しが発生。

**推奨対応**:
- `tmux list-sessions`の一括取得（5N回のhas-sessionを1回に集約）を実装タスクに追加
- `captureSessionOutput()`内の`hasSession()`をキャッシュ利用時はスキップするオプション検討

---

### R1-005: キャッシュ無効化戦略の記載なし

**カテゴリ**: completeness
**場所**: 提案する解決策 > 1. tmux captureキャッシュ導入

**問題**:
TTLベースのキャッシュのみでは以下のケースで問題発生:
1. `sendKeys()`でコマンド送信直後、古いキャッシュが返される
2. セッション停止後にキャッシュが残る
3. auto-yesがプロンプト応答直後、古いキャッシュで二重応答リスク

**推奨対応**:
Write操作時の明示的なキャッシュ無効化を設計に含めるべき:
- `sendKeys()`/`sendMessage()`: 該当セッションのキャッシュクリア
- `killSession()`: 該当セッションのキャッシュクリア
- prompt-response API: キャッシュバイパスオプション提供

---

### R1-009: 影響範囲テーブルとCLAUDE.mdの整合性

**カテゴリ**: consistency
**場所**: 実装タスク

**問題**:
新規ファイル`src/lib/tmux-capture-cache.ts`作成時、CLAUDE.mdのモジュール説明テーブルへの追加が実装タスクに含まれていない。

**推奨対応**:
実装タスクに「CLAUDE.mdのモジュール説明テーブル更新」を追加。

---

### R1-010: 「実行中CLIツールのみcapture」タスクの方針不明確

**カテゴリ**: completeness
**場所**: 実装タスク / 提案する解決策 > 2

**問題**:
現在のroute.ts（L53）では既に`isRunning()`がtrueの場合のみ`captureSessionOutput()`を呼び出している。真のボトルネックは`isRunning()`が全5ツールに対して呼ばれること。

**推奨対応**:
タスクの説明を修正: 「DBのworktreeレコードからactive CLI tool情報を事前取得し、isRunning()呼び出し対象を1-2ツールに絞り込む（tmux list-sessionsの一括取得も検討）」

---

## Nice to Have

### R1-004: N+1パターンの数値説明の精緻化

**カテゴリ**: correctness
**場所**: 背景・課題 > S1

最悪ケースのtmux操作回数は50回ではなく150回程度（isRunning 50 + 内部hasSession 50 + capturePane 50）。概算としての方向性は正しいが、正確な記述があるとベター。

---

### R1-006: キャッシュモジュールの型設計・インターフェースの事前定義

**カテゴリ**: completeness
**場所**: 実装タスク

キャッシュのインターフェース（関数シグネチャ、キャッシュキー構成、globalThisパターン使用有無、メモリ上限）を事前定義しておくと実装時の迷いが減る。

---

### R1-008: ポーリング間隔見直しの具体値未決定

**カテゴリ**: completeness
**場所**: 提案する解決策 > 3

キャッシュTTLとポーリング間隔の関係を明記すべき。TTL=2秒、ポーリング=2秒だとキャッシュヒット率が低い。推奨: TTL=2秒、ポーリング=3秒。

---

### R1-011: stampede問題（並行キャッシュミス）の考慮

**カテゴリ**: completeness
**場所**: 提案する解決策 > 1

Promise.all内で複数worktreeが同時にキャッシュミスし、各々がtmux captureを実行する可能性がある。singleflightパターンの検討を推奨。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/app/api/worktrees/route.ts` (L44-78) | N+1パターンの主要箇所 |
| `src/app/api/worktrees/[id]/current-output/route.ts` (L70) | captureSessionOutput(10000行)の呼び出し |
| `src/lib/auto-yes-manager.ts` (L510) | captureSessionOutput(5000行)の呼び出し |
| `src/lib/response-poller.ts` (L1031) | captureSessionOutput(10000行)の呼び出し |
| `src/app/api/worktrees/[id]/route.ts` (L67) | Issue未記載のcapture呼び出し |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` (L96) | Issue未記載のcapture呼び出し（リアルタイム性要求高） |
| `src/lib/assistant-response-saver.ts` (L243) | Issue未記載のcapture呼び出し |
| `src/lib/cli-session.ts` (L38-72) | captureSessionOutput()実装（内部hasSession二重呼び出し） |
| `src/lib/tmux.ts` (L68-76) | hasSession()実装（execFile外部プロセス起動） |
| `src/contexts/WorktreeSelectionContext.tsx` (L29-36) | ポーリング間隔定数 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | モジュール説明テーブルの更新が必要 |
