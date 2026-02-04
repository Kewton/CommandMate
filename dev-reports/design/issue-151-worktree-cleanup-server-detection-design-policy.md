# Issue #151: worktree-cleanup サーバー検出機能改善 設計方針書

## 1. 概要

### 1.1 目的
`/worktree-cleanup` スキル実行時に、Worktreeディレクトリから `npm run dev` で起動したサーバーを検出・停止できるようにする。

### 1.2 背景
- `npm run dev` で直接起動したサーバーはPIDファイルを作成しない
- 既存のクリーンアップスクリプトはPIDファイルのみを確認
- Worktreeディレクトリ削除後、Next.jsファイルウォッチャーがエラーを発生

### 1.3 関連Issue
- #136 - Git Worktree並列開発環境の整備

---

## 2. 設計原則

### 2.1 SOLID原則の適用

| 原則 | 適用方法 |
|------|---------|
| **SRP** | サーバー検出ロジックを独立した関数（`check_lsof_available`, `stop_server_by_port`）に分離 |
| **OCP** | 新しいポート検出方法を追加可能な構造（`PORTS_TO_CHECK`配列） |
| **LSP** | N/A（継承関係なし） |
| **ISP** | 各関数は単一の責務を持つ |
| **DIP** | 外部コマンド（lsof）への依存を抽象化し、存在チェック関数で対応 |

### 2.2 KISS原則
- bashスクリプトのシンプルな拡張
- 既存のPIDファイル検出ロジックは変更せず、フォールバックとして追加

### 2.3 YAGNI原則
- 自動割り当てポート（3001-3100）のフルスキャンは実装しない
- 将来的な拡張は別Issueで対応

### 2.4 DRY原則
- Issue番号検証範囲を`MAX_ISSUE_NO = 2147483647`と整合
- worktree-cleanup.mdとworktree-setup.mdで同じ検証ロジックを使用

> **[MF-DRY-001] 対応方針**: 共通のbash関数ファイル `.claude/lib/validators.sh` を作成し、Issue番号検証ロジックを一元化する。両スクリプトは `source` コマンドでこのファイルを読み込み、検証関数 `validate_issue_no()` を呼び出す。これにより、将来的な検証範囲の変更（例: 999999から2147483647への変更）は1箇所のみの修正で完了する。
>
> ```bash
> # .claude/lib/validators.sh
> MAX_ISSUE_NO=2147483647
> validate_issue_no() {
>   local issue_no="$1"
>   if ! [[ "$issue_no" =~ ^[0-9]+$ ]] || [ "$issue_no" -lt 1 ] || [ "$issue_no" -gt "$MAX_ISSUE_NO" ]; then
>     return 1
>   fi
>   return 0
> }
> ```

---

## 3. アーキテクチャ設計

### 3.1 コンポーネント構成

```
worktree-cleanup.md
├── Phase 1: 入力検証（Issue番号検証範囲を1-2147483647に更新）
├── Phase 2: サーバー停止（拡張）
│   ├── Step 1: PIDファイルベース検出（既存）
│   └── Step 2: ポートベース検出（新規追加）
│       ├── check_lsof_available()
│       └── stop_server_by_port()
├── Phase 3: Worktree削除
├── Phase 4: ブランチ削除
├── Phase 5: リソースクリーンアップ
└── Phase 6: Worktree同期
```

### 3.2 フロー図

```
┌─────────────────┐
│ Phase 1: 検証   │
│ (1-2147483647)  │
└────────┬────────┘
         │
┌────────▼────────┐
│ Phase 2: サーバー停止 │
├─────────────────┤
│ Step 1: PIDファイル  │
│ 存在チェック         │
├─────────────────┤
│ Step 2: ポートベース │
│ 検出（フォールバック）│
│ ├─ lsof存在チェック  │
│ ├─ ポート3000検出    │
│ └─ 3{issueNo}検出   │
│    (4桁以下のみ)     │
└────────┬────────┘
         │
┌────────▼────────┐
│ Phase 3-6       │
│ (既存処理)      │
└─────────────────┘
```

### 3.3 OS互換性

| OS | cwd取得方法 |
|----|------------|
| macOS (Darwin) | `lsof -p "$PID" -F n \| grep '^ncwd' \| cut -c5-` |
| Linux | `readlink -f /proc/$PID/cwd` |

> **[MF-SEC-001] lsof出力解析の修正**: 従来の `lsof -p "$PID" | grep cwd | awk '{print $NF}'` 方式は、スペースを含むパスで正しく動作しない問題がある。`lsof -F n` フォーマット（機械可読形式）を使用することで、パス内のスペースや特殊文字を正しく処理できる。`-F n` オプションは各行の先頭に `n` プレフィックス付きでファイル名/パスを出力し、`grep '^ncwd'` で cwd 行を抽出、`cut -c5-` で `ncwd` プレフィックスを除去する。

---

## 4. 詳細設計

### 4.1 検出対象ポート

| パターン | ポート | 検出条件 |
|---------|--------|---------|
| デフォルト | 3000 | 常に検出対象 |
| Issue専用 | 3{issueNo} | Issue番号が4桁以下（1-9999） |
| 自動割り当て | 3001-3100 | スコープ外（PIDファイル検出に依存） |

### 4.2 Issue専用ポートの桁数制限

ポート番号上限65535のため：
- 1-4桁（1-9999）: `3{issueNo}`形式で検出可能
- 5桁以上（10000以上）: ポート検出スキップ、PIDファイル検出のみ

> **[SF-KISS-001] ポート算出ロジックの整合性**
>
> 既存の `worktree-setup.md` では `PORT=$((3000 + ISSUE_NO % 100 + 1))` という算出式を使用しており、本設計書の `3{issueNo}` 方式と異なる。この不整合を解決するため、以下の方針を採用する：
>
> | 方式 | 算出式 | 範囲 | 検出対象 |
> |------|--------|------|----------|
> | worktree-setup方式 | `3000 + ISSUE_NO % 100 + 1` | 3001-3100 | PIDファイル検出に依存 |
> | Issue専用方式 | `3{issueNo}` | 30001-39999 | ポートベース検出 |
>
> **統一方針**: worktree-cleanup では**両方式を検出対象**とする。
> - 既存のworktree-setupで起動したサーバー（3001-3100範囲）はPIDファイル検出で対応
> - `npm run dev --port 3{issueNo}` で直接起動したサーバーはポートベース検出で対応
>
> 将来的には、worktree-setup.mdのポート算出式を `3{issueNo}` 方式に統一することを検討する（別Issue）。

> **[MF-CONS-002] ポート算出ロジックの実装詳細**
>
> `src/cli/utils/port-allocator.ts` の `PortAllocator.allocate()` メソッドでは以下の算出式を使用:
> ```
> this.range.min + (issueNo % (this.range.max - this.range.min))
> = 3001 + (issueNo % 99)
> ```
>
> `worktree-setup.md` の算出式:
> ```
> 3000 + (ISSUE_NO % 100) + 1
> = 3001 + (issueNo % 100)
> ```
>
> **微妙な差異**: 同一Issue番号でも異なるポートに割り当てられる可能性がある。
> - 例: Issue #99 -> PortAllocator: 3001, worktree-setup: 3100
>
> **実装方針**: worktree-cleanup ではこの差異を吸収するため、以下の全てを検出対象とする:
> 1. デフォルトポート 3000
> 2. `3{issueNo}` 形式（4桁以下Issue向け）
> 3. PIDファイルに記録されたポート（3001-3100範囲の実際の割り当て）
>
> **将来的な統一検討**: port-allocator.ts と worktree-setup.md の算出ロジック統一は別Issueで対応（[SF-CONS-004]）。

### 4.3 関数設計

#### check_lsof_available()
```bash
# 責務: lsofコマンドの存在チェック
# 戻り値: 0（存在）/ 1（不在）
# 副作用: 不在時に警告メッセージと代替コマンドを表示
```

#### stop_server_by_port()

> **[SF-SRP-001] 責務分離設計**: この関数は単一責務原則(SRP)に従い、オーケストレーション関数として設計する。各サブ責務は以下の独立関数に分離する。

```bash
# 引数: PORT（ポート番号）
# 責務: 指定ポートでWorktreeから起動したサーバーを検出・停止（オーケストレーション）
# 内部で以下の関数を呼び出す:
#   - get_pid_by_port()     : ポートからPID取得
#   - get_process_cwd()     : OS判定込みでcwd取得
#   - is_worktree_process() : cwd検証
#   - graceful_kill()       : SIGTERM→SIGKILL処理
```

#### get_pid_by_port()
```bash
# 引数: PORT（ポート番号）
# 責務: lsofでポート使用プロセスのPIDを取得
# 戻り値: PID（標準出力）/ 空文字（未使用時）
```

#### get_process_cwd()
```bash
# 引数: PID（プロセスID）
# 責務: OS判定してプロセスのcwdを取得
# 戻り値: cwdパス（標準出力）/ 空文字（取得失敗時）
# 備考: macOS(Darwin)とLinuxで異なる取得方法を使用
```

> **[SF-DRY-002] 再利用性**: `get_process_cwd()` は将来的に他の機能（プロセス情報取得、デバッグツール等）でも必要になる可能性があるため、汎用関数として `.claude/lib/process-utils.sh` に配置することを推奨する。

#### is_worktree_process()
```bash
# 引数: PROC_CWD, WORKTREE_ABS
# 責務: cwdがWorktreeディレクトリにマッチするか検証
# 戻り値: 0（マッチ）/ 1（不一致）
```

#### verify_process_command() [SF-SEC-001対応]
```bash
# 引数: PID（プロセスID）
# 責務: プロセスがNode.js/npm関連であることを検証（防御の深層化）
# 戻り値: 0（node/npm）/ 1（その他）
# 実装: ps -p $PID -o comm= | grep -qE '^(node|npm)$'
# 備考: ポートとcwd検証に加え、プロセス種別を確認することで
#       誤検出リスクをさらに低減する
```

#### verify_process_ownership() [SF-SEC-003対応]
```bash
# 引数: PID（プロセスID）
# 責務: プロセスが現在ユーザー所有であることを明示的に検証
# 戻り値: 0（所有者一致）/ 1（不一致）
# 実装: ps -p $PID -o user= | grep -q "$(whoami)"
# 備考: OS標準のlsof/killは自ユーザープロセスのみ操作可能だが、
#       明示的な検証によりエラーメッセージの明確化と防御の深層化を実現
```

#### graceful_kill()
```bash
# 引数: PID（プロセスID）
# 責務: SIGTERM送信、待機、必要に応じてSIGKILL、セキュリティ監査ログ記録
# 手順:
#   1. セキュリティ監査ログ記録（開始）
#   2. SIGTERM送信
#   3. 3秒待機
#   4. プロセス存在確認、存在すればSIGKILL
#   5. セキュリティ監査ログ記録（結果）
```

> **[SF-SEC-002] セキュリティ監査ログ**: プロセス終了は破壊的操作であるため、監査証跡を記録する。ログ形式: `[TIMESTAMP] PROCESS_KILL issue=$ISSUE_NO pid=$PID cwd=$PROC_CWD result=success|failed`。ログ出力先: `~/.commandmate/logs/security.log`。これにより、いつ、どのIssue番号で、どのプロセスが終了されたかを追跡可能にする。

### 4.4 エラーハンドリング

| エラー | 対応 |
|--------|------|
| lsof不在 | 警告表示、代替コマンド案内、手動停止促進 |
| プロセス停止失敗 | 3秒待機後SIGKILL |
| Worktree不在 | スキップ（エラーにしない） |
| cwd取得失敗 | プロセス停止をスキップ |

---

## 5. セキュリティ設計

### 5.1 対策一覧

| ID | 脅威 | 対策 | 実装 |
|----|------|------|------|
| SEC-001 | コマンドインジェクション | Issue番号の整数検証 | `[[ "$ISSUE_NO" =~ ^[0-9]+$ ]]` |
| SEC-002 | パストラバーサル | `~/.commandmate/`内のみ許可 | 固定パス使用 |
| SEC-003 | 誤プロセス停止 | cwd検証 | `$PROC_CWD == "$WORKTREE_ABS"*` |
| SEC-004 | 権限昇格 | 現在ユーザーのプロセスのみ | lsof/killの標準動作 + verify_process_ownership() [SF-SEC-003] |
| SEC-005 | ポート番号インジェクション | 整数検証済み変数のみ使用 | `$ISSUE_NO`から算出 |
| SEC-006 | 監査証跡不足 | プロセス終了操作をログ記録 | security.logへの記録 [SF-SEC-002] |
| SEC-007 | 誤プロセス識別 | プロセスコマンド種別検証 | verify_process_command() [SF-SEC-001] |
| SEC-008 | TOCTOU競合 | 最小リスクとして許容 | 明示的なドキュメント化 [SF-SEC-004] |

### 5.2 cwd検証の重要性

```bash
# 悪意のある/無関係なプロセスを誤停止しないための検証
if [[ -n "$WORKTREE_ABS" && "$PROC_CWD" == "$WORKTREE_ABS"* ]]; then
  # Worktreeからの起動を確認してから停止
fi
```

> **補足**: 前方一致 `"$WORKTREE_ABS"*` を使用することで、Worktreeディレクトリ本体からの起動だけでなく、そのサブディレクトリ（例: `src/` や `packages/app/`）から起動したサーバーも検出対象となる。これは意図した動作であり、モノレポ構成等でサブディレクトリから `npm run dev` を実行するケースに対応する。

### 5.3 TOCTOU競合の認識 [SF-SEC-004対応]

cwd検証とプロセス終了の間には、最小限のTime-of-Check to Time-of-Use (TOCTOU) 競合ウィンドウが存在する。

```
[cwd検証] → [数マイクロ秒] → [kill送信]
           ↑
     この間にプロセスがcwdを変更する可能性
```

**リスク評価**:
- **発生確率**: 極めて低い（マイクロ秒単位のウィンドウ）
- **悪用難易度**: 高（ローカルアクセス + 精密なタイミングが必要）
- **影響度**: 低（最悪ケースでも別ディレクトリのプロセスが停止する程度）

**許容判断**: このTOCTOUウィンドウは、悪用に必要な条件（ローカルアクセス、精密なタイミング制御、プロセスのcwd変更能力）の複合性を考慮すると、実用上のリスクは無視できるレベルである。対策としてアトミック操作を導入するコストは、得られるセキュリティ向上に見合わない。

---

## 6. 影響範囲

### 6.1 変更対象ファイル

| ファイル | 変更内容 | 規模 |
|---------|---------|------|
| `.claude/commands/worktree-cleanup.md` | Phase 1修正、Phase 2拡張 | 約60-80行追加 |
| `.claude/commands/worktree-setup.md` | Phase 1検証範囲修正 | 約2行修正 |
| `.claude/lib/validators.sh` | 新規作成、Issue番号検証関数 | 約15行 |
| `.claude/lib/process-utils.sh` | 新規作成、プロセス関連関数 | 約30行 |

> **[MF-IMP-001] 対応**: 新規作成ファイルを変更対象ファイル一覧に追加。実装チェックリスト（セクション8）で詳細化されている内容をここでも明示する。

### 6.2 関連ドキュメント影響

> **[SF-IMP-001] 対応**: Issue番号検証範囲の変更に伴い、以下のドキュメントへの影響を確認する必要がある。

| ドキュメント | 影響内容 | 対応 |
|-------------|---------|------|
| `CLAUDE.md` | worktree-setup/cleanup スキルの説明（346-347行、418-419行）にIssue番号検証範囲の説明がある場合、整合性確認が必要 | テスト計画に確認ステップを追加（7.1 #9） |

### 6.3 CLIコマンドとの機能分担

> **[SF-IMP-003] 対応**: `commandmate stop --issue` と `/worktree-cleanup` の役割を明確化する。

| 機能 | `commandmate stop --issue` | `/worktree-cleanup` |
|------|---------------------------|---------------------|
| **対象** | デーモンモードで起動したサーバー | Worktree環境全体（サーバー + Worktree + ブランチ + リソース） |
| **検出方法** | PIDファイルのみ | PIDファイル + ポートベース検出 |
| **スコープ** | サーバー停止のみ | 環境クリーンアップ全体 |
| **使用場面** | サーバーを停止したいが環境は残したい | Issue完了後の環境削除 |
| **npm run dev対応** | 非対応（PIDファイルなし） | 対応（本Issue #151で追加） |

**使い分けガイドライン**:
- `commandmate stop --issue {issueNo}`: サーバーのみ停止、Worktree環境は保持
- `/worktree-cleanup {issueNo}`: Issue完了後、Worktree環境ごと削除

### 6.4 後方互換性

- **完全互換**: 既存のPIDファイル検出は維持
- **追加機能**: ポートベース検出はフォールバック
- **Graceful Degradation**: lsof不在時も既存機能は動作

---

## 7. テスト計画

### 7.1 手動テスト項目

| # | テスト | 期待結果 |
|---|--------|---------|
| 1 | npm run devで起動→cleanup | サーバー検出・停止 |
| 2 | commandmate startで起動→cleanup | PID+ポート両方で検出 |
| 3 | メインリポジトリでサーバー起動→別Issueのcleanup | メインは停止されない |
| 4 | Linux環境（Docker node:18-alpine） | /proc/$PID/cwdで動作 |
| 5 | lsof不在環境 | 警告表示、手動停止案内 |
| 6 | Issue番号12345（5桁） | ポート検出スキップ |
| 7 | Issue番号2147483647 | 正常受け入れ |
| 8 | worktree-setup 2147483647 | 正常受け入れ |
| 9 | CLAUDE.md整合性確認 | Issue番号検証範囲の説明がある場合、1-2147483647に更新されているか確認 |
| 10 | Issue #99等の境界値でポート検出 | port-allocator.ts(3001+99%99=3001)とworktree-setup(3001+99%100=3100)の差異を吸収し、両方検出可能 |

> **[SF-IMP-002] 対応**: テスト項目 #10 を追加。Issue #99 は `port-allocator.ts` と `worktree-setup.md` のポート算出式の差異が顕著になる境界値であり、worktree-cleanup が両方式で起動されたサーバーを正しく検出できることを確認する。

---

## 8. 実装チェックリスト

### 共通ライブラリ作成 [MF-DRY-001対応, SF-CONS-001対応]
- [ ] `.claude/lib/` ディレクトリ新規作成（現在存在しないため作成必要）
- [ ] `.claude/lib/validators.sh` 作成（Issue番号検証関数）
  - [ ] `MAX_ISSUE_NO=2147483647` 定数定義（`src/cli/utils/input-validators.ts` と整合）
  - [ ] `validate_issue_no()` 関数実装
  - [ ] 参照元コメント追加: `# Synced with: src/cli/utils/input-validators.ts MAX_ISSUE_NO`
- [ ] `.claude/lib/process-utils.sh` 作成（プロセス関連関数）[SF-DRY-002対応]

### Phase 1修正 [MF-CONS-001対応, SF-CONS-002対応]
- [ ] worktree-cleanup.md: Issue番号検証範囲を`1-2147483647`に更新（現行: 1-999999）
- [ ] worktree-cleanup.md: エラーハンドリング表の文言修正
  - 「正の整数（1-999999）を指定してください」 -> 「正の整数（1-2147483647）を指定してください」
- [ ] worktree-cleanup.md: `.claude/lib/validators.sh` を source で読み込み [MF-DRY-001]
- [ ] worktree-setup.md: Issue番号検証範囲を`1-2147483647`に更新（現行: 1-999999）
- [ ] worktree-setup.md: エラーハンドリング表の文言修正
  - 「正の整数（1-999999）を指定してください」 -> 「正の整数（1-2147483647）を指定してください」
- [ ] worktree-setup.md: `.claude/lib/validators.sh` を source で読み込み [MF-DRY-001]

### Phase 2拡張
- [ ] `check_lsof_available()`関数追加
- [ ] `get_pid_by_port()`関数追加 [SF-SRP-001対応]
- [ ] `get_process_cwd()`関数追加 [SF-SRP-001対応]
  - [ ] macOS: `lsof -p "$PID" -F n | grep '^ncwd' | cut -c5-` 形式を使用 [MF-SEC-001対応]
  - [ ] Linux: `readlink -f /proc/$PID/cwd` を使用
- [ ] `is_worktree_process()`関数追加 [SF-SRP-001対応]
- [ ] `verify_process_command()`関数追加 [SF-SEC-001対応]
  - [ ] `ps -p $PID -o comm= | grep -qE '^(node|npm)$'` でプロセス種別検証
- [ ] `verify_process_ownership()`関数追加 [SF-SEC-003対応]
  - [ ] `ps -p $PID -o user= | grep -q "$(whoami)"` で所有者検証
- [ ] `graceful_kill()`関数追加 [SF-SRP-001対応]
  - [ ] セキュリティ監査ログ記録機能を追加 [SF-SEC-002対応]
  - [ ] ログ形式: `[TIMESTAMP] PROCESS_KILL issue=$ISSUE_NO pid=$PID cwd=$PROC_CWD result=success|failed`
  - [ ] ログ出力先: `~/.commandmate/logs/security.log`
- [ ] `stop_server_by_port()`オーケストレーション関数追加
- [ ] ポート配列`PORTS_TO_CHECK`定義（両方式対応）[SF-KISS-001対応]
- [ ] OS判定ロジック（Darwin/Linux）
- [ ] ユーザー確認プロンプト
- [ ] 待機時間を3秒に統一 [SF-CONS-003対応]
  - 現行worktree-cleanup.mdは`sleep 2`を使用
  - graceful_kill()の設計に合わせて`sleep 3`に更新

---

## 9. レビュー指摘対応サマリー

### Stage 1: 設計原則レビュー (2026-02-04)

| ID | 種別 | 原則 | 対応状況 |
|----|------|------|---------|
| MF-DRY-001 | Must Fix | DRY | 対応済み - 共通validators.sh導入 |
| SF-SRP-001 | Should Fix | SRP | 対応済み - 関数分離設計を追加 |
| SF-KISS-001 | Should Fix | KISS | 対応済み - ポート算出ロジック整合性を明記 |
| SF-DRY-002 | Should Fix | DRY | 対応済み - process-utils.sh導入推奨を追加 |

### Stage 2: 整合性レビュー (2026-02-04)

| ID | 種別 | 内容 | 対応状況 |
|----|------|------|---------|
| MF-CONS-001 | Must Fix | Issue番号検証範囲の不一致 | 対応済み - 1-2147483647に統一 |
| MF-CONS-002 | Must Fix | ポート算出ロジックの不整合 | 対応済み - 両方式検出を明記 |
| SF-CONS-001 | Should Fix | .claude/lib/ディレクトリ作成 | 対応済み - チェックリストに追加 |
| SF-CONS-002 | Should Fix | エラーハンドリング表の文言更新 | 対応済み - チェックリストに追加 |
| SF-CONS-003 | Should Fix | 待機時間の統一(2s→3s) | 対応済み - 3秒に統一 |
| SF-CONS-004 | Should Fix | port-allocator.ts整合性 | 対応済み - 将来検討事項に追加 |

### Stage 3: 影響分析レビュー (2026-02-04)

| ID | 種別 | 内容 | 対応状況 |
|----|------|------|---------|
| MF-IMP-001 | Must Fix | .claude/lib/ディレクトリがセクション6.1に未記載 | 対応済み - セクション6.1に新規作成ファイルを追加 |
| SF-IMP-001 | Should Fix | CLAUDE.mdへの影響が未記載 | 対応済み - セクション6.2に関連ドキュメント影響を追加、テスト項目#9追加 |
| SF-IMP-002 | Should Fix | ポート算出ロジック不整合のテストケース不足 | 対応済み - テスト項目#10にIssue #99境界値テストを追加 |
| SF-IMP-003 | Should Fix | CLIコマンド(stop)との機能分担が不明確 | 対応済み - セクション6.3にCLIコマンドとの機能分担を追加 |

### Stage 4: セキュリティレビュー (2026-02-04)

| ID | 種別 | OWASP | 内容 | 対応状況 |
|----|------|-------|------|---------|
| MF-SEC-001 | Must Fix | A03 | lsof出力解析がスペース含むパスで失敗 | 対応済み - `lsof -F n` 形式に変更（セクション3.3, 4.3, 8） |
| SF-SEC-001 | Should Fix | A07 | プロセスコマンド検証の欠如 | 対応済み - verify_process_command()関数を追加（セクション4.3, 5.1, 8） |
| SF-SEC-002 | Should Fix | A09 | セキュリティ監査ログの欠如 | 対応済み - graceful_kill()にログ記録機能を追加（セクション4.3, 5.1, 8） |
| SF-SEC-003 | Should Fix | A01 | 明示的なプロセス所有者検証の欠如 | 対応済み - verify_process_ownership()関数を追加（セクション4.3, 5.1, 8） |
| SF-SEC-004 | Should Fix | A04 | TOCTOUウィンドウの未ドキュメント化 | 対応済み - セクション5.3にTOCTOU競合の認識と許容判断を追加 |

**セキュリティレビュー総評**: 全体的なリスクレベルは「低」と評価。入力検証（SEC-001）、cwd検証（SEC-003）、OS標準の権限制御（SEC-004）により、主要な脅威に対応済み。Stage 4で追加された防御の深層化対策（プロセスコマンド検証、明示的所有者検証、監査ログ）により、セキュリティ体制がさらに強化された。

---

## 10. 将来検討事項

### 10.1 ポート算出ロジック統一 [SF-CONS-004関連]

現在、以下の3箇所でポート算出/検出ロジックが存在し、完全には統一されていない:

| 箇所 | 算出式 | 備考 |
|------|--------|------|
| `src/cli/utils/port-allocator.ts` | `3001 + (issueNo % 99)` | TypeScript実装 |
| `.claude/commands/worktree-setup.md` | `3000 + (ISSUE_NO % 100) + 1` | bashスクリプト |
| `.claude/commands/worktree-cleanup.md` | 検出のみ（PIDファイル + 3{issueNo}） | bashスクリプト |

**推奨アクション**（別Issue）:
1. ポート算出ロジックをTypeScript側（port-allocator.ts）に統一
2. bashスクリプトはCLI経由でポートを取得
3. または、設定ファイル（JSON/env）で共有

### 10.2 MAX_ISSUE_NO同期メカニズム [NTH-CONS-001関連]

`.claude/lib/validators.sh` と `src/cli/utils/input-validators.ts` で `MAX_ISSUE_NO` を二重管理している。
将来的には以下を検討:
- ビルド時に自動生成
- 設定ファイルからの読み込み
- テストによる整合性チェック

---

## 11. 参考資料

- Issue #151: https://github.com/Kewton/CommandMate/issues/151
- Issue #136: Git Worktree並列開発環境の整備
- `src/cli/utils/input-validators.ts`: `MAX_ISSUE_NO = 2147483647`
- `src/cli/utils/port-allocator.ts`: `DEFAULT_PORT_RANGE: { min: 3001, max: 3100 }`

---

*Created: 2026-02-04*
*Last Updated: 2026-02-04 (Stage 4 Security Review Applied)*
