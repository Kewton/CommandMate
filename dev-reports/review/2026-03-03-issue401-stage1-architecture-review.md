# Architecture Review Report: Issue #401 - Stage 1 (設計原則)

## Executive Summary

| 項目 | 値 |
|------|-----|
| **Issue** | #401 fix: stop.shが古いサーバープロセスを取りこぼす問題の修正 |
| **レビューステージ** | Stage 1: 設計原則レビュー |
| **レビュー日** | 2026-03-03 |
| **対象文書** | `dev-reports/design/issue-401-stop-script-fix-design-policy.md` |
| **評価** | 良好 (conditionally_approved) |
| **スコア** | 4/5 |

設計方針書は全体として高品質であり、SOLID/KISS/YAGNI/DRYの各原則を適切に考慮している。既存CLIモジュール（`daemon.ts`/`pid-manager.ts`）の堅牢な実装を参考にしながら、シェルスクリプトの特性に合わせた実用的な設計判断がなされている。代替案との比較テーブルやスコープ外の明示など、設計ドキュメントとしての完成度も高い。

must_fix 1件、should_fix 3件、nice_to_have 4件の指摘があり、must_fixの反映により実装品質が向上する。

---

## Detailed Findings

### Must Fix (1件)

#### D1-006: stop-server.shのPIDファイルベース停止でプロセスグループ指定の設計判断が欠落

| 項目 | 内容 |
|------|------|
| **ID** | D1-006 |
| **重要度** | must_fix |
| **カテゴリ** | 防御的プログラミング |

**問題の詳細**

設計方針書セクション4.2の修正方針テーブルで、L32の `kill -9 -$PID` をSIGTERM + フォールバックに変更する方針が示されている。しかし、修正後のコードで `kill -$PID`（プロセスグループ指定）を維持するのか、`kill $PID`（単一プロセス）に変更するのかが明示されていない。

現在の `stop-server.sh` L32:
```bash
kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null
```

この行がSIGTERM + フォールバックに変更される際、プロセスグループ指定（`-$PID`）をどう扱うかは重要な設計判断である。`daemon.ts`では`process.kill(pid, signal)`で単一プロセスを対象としているが、`nohup npm start` で起動されたNode.jsプロセスは子プロセス（next server）を持つため、プロセスグループ停止の意味が異なる。

**修正提案**

設計方針書セクション4.2に以下を明記する:

1. SIGTERM段階ではプロセスグループ指定 `kill -- -$PID` を使用し、Next.jsの子プロセスも含めてグレースフルシャットダウンの機会を与える
2. nohup起動時はプロセスグループリーダーとなることを前提条件として明記する
3. フォールバック段階では既存パターン `kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null` を維持する理由を記載する

---

### Should Fix (3件)

#### D1-001: CM_PORT環境変数のバリデーション不足

| 項目 | 内容 |
|------|------|
| **ID** | D1-001 |
| **重要度** | should_fix |
| **カテゴリ** | 防御的プログラミング |

**問題の詳細**

設計方針書セクション5.3で「CM_PORT / MCBD_PORT の値はそのまま使用」と記載されている。CLI側の `daemon.ts` では `parseInt()` で数値化しており、同等の防御がシェルスクリプト側には存在しない。

`stop.sh` L21:
```bash
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
```

CM_PORTに不正な値（空文字列、文字列、65536超）が設定された場合、lsofのエラーは `2>/dev/null` で抑制されるが、ユーザーに何も通知されず、停止が無音で失敗する可能性がある。

**修正提案**

設計方針書セクション5.3にポート番号バリデーションパターンを追加する:

```bash
if ! echo "$PORT" | grep -qE '^[0-9]+$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "ERROR: Invalid port number: $PORT" >&2
    exit 1
fi
```

---

#### D1-002: stop.shの || true 記述位置と残留チェックの非対称性

| 項目 | 内容 |
|------|------|
| **ID** | D1-002 |
| **重要度** | should_fix |
| **カテゴリ** | 防御的プログラミング |

**問題の詳細**

設計方針書セクション4.1の修正案で、PID取得パイプラインには `|| true` が付加されている一方、残留チェックの `REMAINING=$(lsof ... | grep ... | sort -u)` には `|| true` がない。

```bash
# || true あり
PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)

# || true なし
REMAINING=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u)
```

現在の `stop.sh` には `set -e` がないため直接の問題にはならないが、将来的な変更やsource経由での呼び出し時にリスクとなる。

**修正提案**

1. `stop.sh` に `set -e` を追加しない方針を設計方針書で明記する（または追加する場合はpipefailとの相互作用を考慮）
2. 残留チェックの `REMAINING=$(...)` にも `|| true` を統一的に付加する

---

#### D1-004: build-and-start.shのPIDファイルクリーンアップとポートチェックの状態遷移

| 項目 | 内容 |
|------|------|
| **ID** | D1-004 |
| **重要度** | should_fix |
| **カテゴリ** | SRP / 防御的プログラミング |

**問題の詳細**

設計方針書セクション4.3の修正案で、PIDファイルチェックの後にポートベースチェックを追加する方針が示されている。PIDファイルが「不正またはプロセス終了済み」の場合にPIDファイルを削除した後、ポート使用中が検知されると `exit 1` でユーザーに `stop-server.sh` の使用を案内する。

しかし、この時点でPIDファイルは既に削除済みであるため、`stop-server.sh` のPIDファイルベース停止パスは機能しない。`stop-server.sh` のポートベース停止（Step 1）が機能するため実害はないが、この状態遷移が設計方針書で明示されていない。

**修正提案**

設計方針書セクション4.3に、PIDファイル削除後のフローにおいて `stop-server.sh` がポートベース停止で対処可能であることを設計根拠として明記する。または、PIDファイル削除をポートチェック後に遅延させる方式を検討する。

---

### Nice to Have (4件)

#### D1-003: PIDバリデーションパイプラインの重複箇所へのコメント付記

| 項目 | 内容 |
|------|------|
| **ID** | D1-003 |
| **重要度** | nice_to_have |
| **カテゴリ** | DRY |

同一パイプラインパターン `lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u` が修正後の全スクリプトで計6箇所に出現する。共通関数化はYAGNI違反として不採用の判断は正しいが、各箇所に `# Safe PID pipeline: validate numeric + deduplicate` のコメントを付記する方針を追加すると保守性が向上する。

---

#### D1-005: 段階的停止の累積待機時間に関する記載

| 項目 | 内容 |
|------|------|
| **ID** | D1-005 |
| **重要度** | nice_to_have |
| **カテゴリ** | KISS |

トレードオフテーブルの「停止に最大2秒追加」は正確だが、`restart.sh` や rebuild SKILL のチェーン実行での累積影響（stop.sh 2秒 + build-and-start.sh起動確認 3秒 = 合計5秒+）も言及すると完全性が向上する。グレースフルシャットダウンの利点が上回るため、設計判断自体は適切。

---

#### D1-007: スコープ外の明示が適切

| 項目 | 内容 |
|------|------|
| **ID** | D1-007 |
| **重要度** | nice_to_have |
| **カテゴリ** | YAGNI |

セクション9で5項目のスコープ外を明示し、代替案との比較テーブル（セクション8）で「bashの共通関数ファイル化」を不採用（YAGNI）とした根拠が明確。指摘なし、現状の設計方針が適切。

---

#### D1-008: stop.shとstop-server.shの責務定義テーブルの追加

| 項目 | 内容 |
|------|------|
| **ID** | D1-008 |
| **重要度** | nice_to_have |
| **カテゴリ** | SOLID (SRP) |

両スクリプトの責務の違いが暗黙的であるため、設計方針書セクション2に責務定義テーブルを追加すると、修正方針の差異（stop.shにはPIDファイル操作がない等）の理由が更に明確になる。

| スクリプト | 主な呼び出し元 | 責務 |
|-----------|--------------|------|
| stop.sh | restart.sh, rebuild SKILL | PM2またはポートベースの汎用停止（PIDファイル非管理） |
| stop-server.sh | ユーザー直接実行 | daemon起動サーバーの停止（PIDファイル+ポート多段停止） |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | プロセスグループ指定の設計判断欠落による実装時の不整合 | Medium | Medium | P1 |
| 技術的リスク | 不正ポート番号による無音失敗 | Low | Low | P2 |
| 運用リスク | || true の非対称性によるset -e追加時の問題 | Low | Low | P3 |
| セキュリティリスク | PIDバリデーションの追加により適切にカバー | Low | Low | - |

---

## Design Principles Compliance Summary

| 原則 | 評価 | コメント |
|------|------|---------|
| **Single Responsibility** | Good | stop.sh / stop-server.sh の分離維持は適切。責務定義の明文化で更に改善可能（D1-008） |
| **Open/Closed** | Good | 既存の呼び出し元（restart.sh, rebuild SKILL, setup.sh）との互換性を維持する設計。exitコードの変更なし |
| **KISS** | Good | シェルスクリプトの変更は必要最小限。段階的停止パターンはCLI側の既存実装を参考にしており、新規の複雑性を導入していない |
| **YAGNI** | Excellent | スコープ外の明示（5項目）、代替案の不採用理由が明確。共通関数化をYAGNI違反として退けた判断は正しい |
| **DRY** | Acceptable | パイプラインパターンの重複は共通関数化のコスト（sourceパス管理）とのトレードオフで許容。コメント付記で保守性向上可能 |
| **防御的プログラミング** | Needs Improvement | PIDバリデーション追加は良いが、CM_PORTバリデーション不足（D1-001）、|| true の非対称性（D1-002）、プロセスグループ指定の設計判断欠落（D1-006）を改善すべき |

---

## Approval Status

**conditionally_approved** - must_fix 1件（D1-006: プロセスグループ指定の設計判断明記）の反映を条件として承認。should_fix 3件も反映を推奨する。

---

## Reviewed Files

| ファイル | レビュー内容 |
|---------|-------------|
| `dev-reports/design/issue-401-stop-script-fix-design-policy.md` | 設計方針書（レビュー対象） |
| `scripts/stop.sh` | 現在の実装との比較 |
| `scripts/stop-server.sh` | 現在の実装との比較 |
| `scripts/build-and-start.sh` | 現在の実装との比較 |
| `scripts/restart.sh` | 呼び出し元として確認 |
| `scripts/start.sh` | 関連スクリプトとして確認 |
| `scripts/setup.sh` | 呼び出し元として確認 |
| `src/cli/utils/daemon.ts` | CLIモジュール参照実装との比較 |
| `src/cli/utils/pid-manager.ts` | CLIモジュール参照実装との比較 |
| `.claude/skills/rebuild/SKILL.md` | rebuild SKILLの呼び出しフロー確認 |

---

*Generated: 2026-03-03*
*Reviewer: Architecture Review Agent (Stage 1 - 設計原則)*
