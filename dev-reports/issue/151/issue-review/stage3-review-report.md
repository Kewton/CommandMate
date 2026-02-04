# Issue #151 影響範囲レビューレポート

**レビュー日**: 2026-02-04
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

**総合評価**: Good

Issue #151の影響範囲は限定的で、主な変更は `.claude/commands/worktree-cleanup.md` のPhase 2拡張のみです。既存のCLIコマンドやTypeScriptモジュールへの変更は不要であり、破壊的変更もありません。

---

## 影響範囲分析

### 直接影響

| ファイル | 変更種別 | 説明 |
|----------|---------|------|
| `.claude/commands/worktree-cleanup.md` | 修正 | Phase 2セクションを拡張し、ポートベース検出ロジックを追加（約60-80行追加） |

### 間接影響

| ファイル | 影響種別 | リスク |
|----------|---------|--------|
| `.claude/commands/worktree-setup.md` | ドキュメント | Low |
| `src/cli/commands/start.ts` | なし | None |
| `src/cli/commands/stop.ts` | なし | None |
| `src/cli/utils/daemon.ts` | なし | None |
| `src/cli/utils/pid-manager.ts` | なし | None |
| `src/lib/session-cleanup.ts` | 将来的な検討 | Low |

### ユーザー影響

**ポジティブな影響**:
- `npm run dev` で起動したサーバーがWorktree削除時に自動停止され、ENOENTエラーが発生しなくなる
- ユーザーが手動でサーバーを停止する必要がなくなり、ワークフローがスムーズになる
- Issue専用ポート（3{issueNo}形式）も検出対象に含まれ、複数Worktree同時開発時の安全性が向上

**ニュートラルな影響**:
- lsofが利用不可の環境では従来通り手動停止が必要（警告メッセージで案内）
- 5桁以上のIssue番号では3{issueNo}形式のポート検出はスキップ（PIDファイル検出に依存）

### 破壊的変更

なし

---

## リスク評価

**全体リスク**: Low

| リスク要因 | 緩和策 | 残存リスク |
|-----------|--------|-----------|
| 誤プロセス停止 | cwd検証により、Worktreeディレクトリ以外から起動したプロセスは停止しない | Very Low |
| lsofの環境依存 | check_lsof_available()関数で事前チェック、不在時は警告と代替コマンド案内 | Low |
| macOS/Linux間の挙動差 | OS判定によるlsofオプション/cwdの取得方法を分岐 | Low |
| プロセス強制終了によるデータ損失 | SIGTERM後3秒待機してからSIGKILL、ユーザー確認プロンプト表示 | Very Low |

---

## Should Fix（推奨対応）

### SF-IMPACT-001: テスト環境の具体化

**カテゴリ**: テスト範囲
**場所**: テスト計画セクション - 手動テスト4

**問題**:
テスト計画にLinux環境でのcwd取得方法（/proc/$PID/cwd）の検証が含まれているが、具体的なテスト環境（Docker等）の指定がない。

**証拠**:
「Docker等でLinux環境を用意し、同様のテストを実施」とあるが、Dockerイメージの指定やCI統合の有無が不明。

**推奨対応**:
テスト用Dockerイメージ（例: `node:18-alpine`）を指定するか、CI/CD環境（GitHub Actions `ubuntu-latest`）での自動テストを検討する旨を追記。

---

### SF-IMPACT-002: 変更規模の明示

**カテゴリ**: 影響ファイル
**場所**: 影響範囲セクション

**問題**:
影響範囲セクションに具体的な変更内容（行数、追加/修正）が記載されていない。

**証拠**:
「/worktree-cleanup スキル - Phase 2を拡張」とあるが、具体的な変更規模が不明。

**推奨対応**:
予想される変更行数（例: 約60-80行追加）や、既存コードの削除/修正があるかを明記。

---

### SF-IMPACT-003: 既存ユーザーへの影響明示

**カテゴリ**: 移行考慮
**場所**: 推奨される改善策セクション

**問題**:
既存のworktree-cleanup.mdを使用しているユーザーへの影響が未考慮。

**証拠**:
Phase 2の「置き換え」と記載されているが、既存の手順でクリーンアップを実行した場合の挙動変化が説明されていない。

**推奨対応**:
変更後の挙動は上位互換であり、既存ユーザーの手順変更は不要である旨を明記。

---

## Nice to Have（あれば良い）

### NTH-IMPACT-001: CLAUDE.md更新計画

**カテゴリ**: ドキュメント更新

CLAUDE.mdの最近の実装機能セクションへの追記が未計画。完了後にCLAUDE.mdのコマンド一覧やセキュリティ考慮事項に本機能の説明を追加する旨を記載することを推奨。

---

### NTH-IMPACT-002: session-cleanup.tsとの統合検討

**カテゴリ**: 依存関係

`src/lib/session-cleanup.ts` はWebアプリ側のセッションクリーンアップを担当。CLIスキルとの統一的なクリーンアップAPIの可能性を将来課題として記載することを推奨。

---

### NTH-IMPACT-003: 単体テスト計画

**カテゴリ**: テスト範囲

手動テストのみ記載されており、bashスクリプトの単体テストはスコープ外。将来的にshellcheck/bats等でのテスト導入を検討する旨を記載することを推奨。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|----------|--------|
| `.claude/commands/worktree-cleanup.md` | 直接変更対象。Phase 2セクションの拡張 |
| `.claude/commands/worktree-setup.md` | 関連スキル。クリーンアップ改善に伴う整合性確認 |
| `src/cli/commands/start.ts` | 間接影響。PIDファイル生成の既存実装確認 |
| `src/cli/commands/stop.ts` | 間接影響。PIDファイルベース停止の既存実装確認 |
| `src/cli/utils/daemon.ts` | 間接影響。デーモン管理の既存実装確認 |
| `src/cli/utils/pid-manager.ts` | 間接影響。PIDファイル管理の既存実装確認 |
| `src/lib/session-cleanup.ts` | 将来的な統合ポイント。Facadeパターンによるクリーンアップ統合 |
| `src/cli/utils/input-validators.ts` | 整合性確認。MAX_ISSUE_NO定数（2147483647）との整合 |
| `tests/unit/session-cleanup.test.ts` | テストパターン参考。クリーンアップ関連テストの実装例 |

### ドキュメント

| ファイル | 関連性 |
|----------|--------|
| `CLAUDE.md` | ドキュメント更新候補。最近の実装機能セクションへの追記 |
| `docs/features/sidebar-status-indicator.md` | 参考ドキュメント。検出ロジックの記述パターン |

---

## 結論

Issue #151は影響範囲が限定的で、安全に実装可能なIssueです。主な変更は `.claude/commands/worktree-cleanup.md` のみであり、既存のCLIコマンドやTypeScriptモジュールへの変更は不要です。

Stage 1（通常レビュー）とStage 2（指摘反映）で指摘された問題は適切に対処されており、本影響範囲レビューで新たなMust Fix項目は検出されませんでした。

Should Fix 3件（テスト環境具体化、変更規模明示、既存ユーザー影響明示）を対応することで、Issueの品質がさらに向上します。
