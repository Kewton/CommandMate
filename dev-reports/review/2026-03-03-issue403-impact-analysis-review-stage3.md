# Architecture Review: Issue #403 Stage 3 - Impact Analysis

## Executive Summary

Issue #403 (Server Log Rotation) の設計方針書に対するStage 3 影響範囲レビューを実施した。設計方針書の影響分析は概ね正確であり、主要な直接変更ファイル（`scripts/build-and-start.sh`、PRODUCTION_CHECKLIST 2ファイル）の特定は適切である。「影響を受けないファイル」リストも大部分が正確だが、`build-and-start.sh` を呼び出す間接的な呼び出し元（rebuild SKILL、setup.sh）の分析が不足している。

- **Status**: Conditionally Approved
- **Score**: 4/5
- **Must Fix**: 0件
- **Should Fix**: 3件
- **Nice to Have**: 6件

## Review Scope

| 項目 | 内容 |
|------|------|
| Issue | #403 サーバーログローテーション機能 |
| Stage | 3 (影響範囲) |
| 対象 | 設計方針書 `dev-reports/design/issue-403-server-log-rotation-design-policy.md` |
| 確認ファイル数 | 19ファイル |

## Impact Analysis Matrix

### Direct Changes (設計方針書に記載済み)

| ファイル | 変更内容 | 設計方針書の記載 | 検証結果 |
|---------|---------|----------------|---------|
| `scripts/build-and-start.sh` | `rotate_logs()` 関数追加、定数追加、呼び出し追加 | セクション2, 4-1, 4-2, 4-3 | 正確。L63-68間への挿入位置も実コードと整合 |
| `docs/en/internal/PRODUCTION_CHECKLIST.md` | Log rotation 項目更新 | セクション9 | 正確。L164 付近の記載も確認済み |
| `docs/internal/PRODUCTION_CHECKLIST.md` | Log rotation 項目更新（日本語版） | セクション9 | 正確 |

### Indirect Callers (build-and-start.sh を呼び出すファイル)

| ファイル | 呼び出し方式 | 設計方針書の記載 | リスク |
|---------|-------------|----------------|-------|
| `.claude/skills/rebuild/SKILL.md` | `./scripts/stop.sh && ./scripts/build-and-start.sh --daemon` | **記載なし** | 低（ローテーションが追加されるが正常動作する） |
| `scripts/setup.sh` | `./scripts/build-and-start.sh --daemon` (L118) | **記載なし** | 極低（初回は空振り、2回目以降は恩恵） |
| `scripts/setup-env.sh` | ログメッセージで案内のみ (L356) | **記載なし** | なし（呼び出しではなく表示のみ） |

### Non-Affected Files (設計方針書に記載済み)

| ファイル | 設計方針書の理由 | 検証結果 |
|---------|----------------|---------|
| `scripts/stop-server.sh` | ログファイル名変更なし | 正確。server.log を直接参照しない |
| `scripts/restart.sh` | build-and-start.sh を呼び出さない | 正確。PM2 or stop.sh + start.sh 経路 |
| `scripts/logs.sh` | PM2/systemd 専用 | 正確。ただしローテーション済みファイルへのアクセス手段の不在は認知事項 |
| `src/cli/utils/daemon.ts` | `stdio: 'ignore'` で server.log 未使用 | 正確 |
| `src/config/log-config.ts` | `data/logs/` 管理、server.log と無関係 | 正確 |
| `src/lib/log-manager.ts` | 会話ログ管理、server.log と無関係 | 正確 |
| `.gitignore` | `logs/` 既に除外済み | 正確。L52 で `logs/` が除外されており、ローテーション済みファイルもカバー |

### Non-Affected Files (設計方針書に未記載だが確認済み)

| ファイル | 確認結果 | リスク |
|---------|---------|-------|
| `docs/DEPLOYMENT.md` | build-and-start.sh を参照するがインターフェース不変 | なし |
| `docs/en/DEPLOYMENT.md` | 同上 | なし |
| `.github/workflows/ci-pr.yml` | build-and-start.sh を呼び出さない | なし |
| `.github/workflows/publish.yml` | build-and-start.sh を呼び出さない | なし |
| `tests/` 配下全ファイル | build-and-start.sh/server.log への参照なし | なし |
| `docs/user-guide/cli-setup-guide.md` | CLI 経由パスで別経路 | なし |

## Detailed Findings

### Should Fix (3件)

#### SF-1: rebuild SKILL への影響が未分析

**Location**: セクション2 影響を受けないファイル テーブル

`.claude/skills/rebuild/SKILL.md` は `./scripts/stop.sh && ./scripts/build-and-start.sh --daemon` を実行する。rebuild は開発中に頻繁に呼び出されるコマンドであり、build-and-start.sh への変更は rebuild の動作に直接影響する。

設計方針書のセクション2「影響を受けないファイル」テーブルに restart.sh 等は含まれているが、rebuild SKILL は含まれていない。rebuild 経由でのローテーション実行は正常動作するが、影響分析の網羅性として記載すべきである。

**Recommendation**: セクション2の影響を受けないファイルテーブルに以下を追加する。

```
| `.claude/skills/rebuild/SKILL.md` | `build-and-start.sh --daemon` を呼び出すが、ローテーション追加はインターフェース変更を伴わないため影響なし。rebuild実行時に閾値超過のserver.logがあればローテーションされる（正常動作） |
```

#### SF-2: logs.sh のローテーション後のユーザー体験

**Location**: セクション2 影響を受けないファイル - logs.sh 行、セクション10 拡張ポイント4

logs.sh は現状 PM2/systemd 以外で "No logs found" と表示する。build-and-start.sh --daemon で運用するユーザーにとって、ローテーション導入後に server.log.1, server.log.2, server.log.3 というファイルが生成されるが、これらにアクセスする手段が提供されていない。

設計方針書のセクション10 拡張ポイント4は「logs.sh対応」と簡潔に記載されているが、ローテーション導入に伴い具体化すべきである。

**Recommendation**: セクション10 拡張ポイント4を以下のように具体化する。

```
4. **`logs.sh`対応**: `server.log`および`server.log.1`〜`.3`のローテーション済みファイルの一覧・参照サポート
```

#### SF-3: ローテーション後の server.log 不在期間の明確化

**Location**: セクション4-4 ローテーション動作フロー

セクション4-4 の結果部分には「server.log は nohup により新規作成される」と記載されているが、ローテーション実行（mv server.log server.log.1）から nohup 実行（>> server.log）までの間、server.log が存在しない期間があることが明示されていない。

この期間は、ローテーション -> db:init -> build:all -> nohup 実行の一連のステップであり、ビルド時間を含めると数十秒から数分にわたる可能性がある。フォアグラウンドモードではこの期間の後も server.log は作成されない。

**Recommendation**: セクション4-4 の結果に以下の注記を追加する。

```
注: ローテーション後からnohup実行までの間（db:init、build:all実行中）、server.logは存在しない。
デーモンモードではnohupの >> リダイレクトにより自動作成される。
フォアグラウンドモードでは server.log は作成されない（stdoutに出力されるため）。
```

### Nice to Have (6件)

#### NH-1: DEPLOYMENT.md の影響分析への追加

docs/DEPLOYMENT.md と docs/en/DEPLOYMENT.md は build-and-start.sh を参照している（setup.sh の自動実行ステップとして）。呼び出しインターフェースに変更がないため影響はないが、影響を受けないファイルリストへの追加で網羅性が向上する。

#### NH-2: setup.sh / setup-env.sh の影響分析への追加

scripts/setup.sh は build-and-start.sh を直接呼び出す。setup-env.sh はログメッセージで案内する。いずれも影響を受けないファイルリストへの追加が望ましい。

#### NH-3: CI/CD への影響なしの明記

ci-pr.yml, publish.yml は build-and-start.sh を呼び出さないため影響なし。セクション8 テスト方針にCI/CDへの影響なしを明記すると完全性が高まる。

#### NH-4: 既存テストへの影響なしの明記

Vitest 単体テスト・結合テスト、Playwright E2E テストのいずれも build-and-start.sh および server.log を参照していないことを確認した。セクション8 に明記すると明確になる。

#### NH-5: .gitignore 分析の正確性確認

設計方針書の記載は正確。logs/ ディレクトリ除外により server.log.1 等もカバーされる。対応不要。

#### NH-6: restart.sh 分析の正確性確認

Stage 1 で修正済みの restart.sh 分析を再確認。PM2 存在時は pm2 restart、非存在時は stop.sh + start.sh（start.sh は pm2 start or npm start 直接）。いずれも build-and-start.sh を呼び出さない。設計方針書の記載は正確。対応不要。

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | ローテーション機能の追加による build-and-start.sh の動作変更 | Low | Low | P3 |
| セキュリティリスク | ファイル操作（mv/rm）は既存パスに対する POSIX コマンドのみ | Low | Low | - |
| 運用リスク | ローテーション後のログファイル参照手段の不在 | Low | Medium | P2 |
| 後方互換性リスク | build-and-start.sh の呼び出しインターフェース変更なし | Low | Low | - |
| CI/CD リスク | CI パイプラインは build-and-start.sh を呼び出さない | Low | Low | - |
| テストリスク | 既存テストに server.log/build-and-start.sh への依存なし | Low | Low | - |

## Back Compatibility Assessment

| 観点 | 評価 | 詳細 |
|------|------|------|
| build-and-start.sh 引数 | 互換 | 引数変更なし（--daemon, -d, -h, --help） |
| build-and-start.sh 終了コード | 互換 | rotate_logs の失敗は `\|\| echo WARNING` で吸収 |
| server.log ファイルパス | 互換 | 変更なし（logs/server.log） |
| ログ出力形式 | 互換 | server.log の内容は変更なし |
| 新規生成ファイル | 追加のみ | server.log.1, .2, .3 が新規生成される可能性 |
| 運用手順 | 互換 | 既存の起動・停止・監視手順に変更なし |

## Conclusion

設計方針書の影響分析は全体として良好（score 4/5）である。直接変更ファイルの特定と「影響を受けないファイル」の主要7項目の分析は正確であり、Stage 1/Stage 2 レビューの反映も適切に行われている。

主な改善点は、build-and-start.sh の間接的な呼び出し元（特に rebuild SKILL と setup.sh）の影響分析の追加と、ローテーション導入後のユーザー体験（過去ログへのアクセス手段）に関する認知的影響の記載である。これらは must_fix ではなく should_fix レベルであり、設計方針書の品質向上のための推奨事項である。

後方互換性は完全に維持されており、CI/CD パイプライン・既存テストへの影響はゼロであることを確認した。

---

*Review conducted: 2026-03-03*
*Reviewer: Architecture Review Agent (Stage 3 - Impact Analysis)*
*Design document: dev-reports/design/issue-403-server-log-rotation-design-policy.md*
