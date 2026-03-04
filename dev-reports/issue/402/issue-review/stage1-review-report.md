# Issue #402 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**対象Issue**: perf: detectPromptの重複ログ出力を抑制してI/O負荷を軽減

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 2 |
| **合計** | **9** |

**総合評価**: fair -- Issueの課題認識と方向性は妥当だが、事実誤認が2箇所あり、実装方針の具体性と影響範囲の網羅性に改善が必要。

---

## Must Fix（必須対応）

### MF-001: 100ms間隔の記述が事実と異なる

**カテゴリ**: 事実誤り
**場所**: 背景・課題セクション

**問題**:
Issue内に「同一プロンプトに対して100ms間隔で繰り返しログ出力されている」とあるが、実際のポーリング間隔は2000ms（2秒）。コードベース内に100msのポーリング間隔は存在しない。

**証拠**:
- `src/lib/response-poller.ts:54` -- `const POLLING_INTERVAL = 2000;`
- `src/lib/auto-yes-manager.ts:69` -- `export const POLLING_INTERVAL_MS = 2000;`
- `src/components/worktree/WorktreeDetailRefactored.tsx` -- `ACTIVE_POLLING_INTERVAL_MS = 2000; IDLE_POLLING_INTERVAL_MS = 5000;`

**推奨対応**:
「同一プロンプトに対して100ms間隔で繰り返しログ出力されている」を「同一プロンプトに対して2秒間隔（POLLING_INTERVAL = 2000ms）で繰り返しログ出力されている」に修正する。

---

### MF-002: 「1秒間に30回以上」の数値根拠が不明確

**カテゴリ**: 正確性・完全性
**場所**: 概要セクション

**問題**:
「1秒間に30回以上同一内容で出力」は誇張または前提条件が未記載。コード分析に基づく1ワークツリーあたりの最大detectPrompt呼び出し回数は以下の通り：

| 呼び出し元 | 頻度 | 1サイクル当たり最大回数 |
|-----------|------|----------------------|
| response-poller.ts (extractResponse) | 2秒毎 | 2回 (L779 + L953) |
| response-poller.ts (checkForResponse) | 2秒毎 | 1回 (L1088 フォールバック) |
| auto-yes-manager.ts | 2秒毎 | 1回 (L585) |
| status-detector.ts (via current-output API) | 2-5秒毎 | 1回 (L145) |
| current-output/route.ts (直接呼び出し) | 2-5秒毎 | 1回 (L101) |
| **1ワークツリー合計** | | **最大6回/2秒** |

30回/秒に到達するには10以上のActiveワークツリーが同時稼働している必要があり、この前提条件が記載されていない。

**推奨対応**:
概要セクションの「1秒間に30回以上」を、具体的な呼び出しパターンに基づく記述に変更する。例：「1ワークツリーあたり1ポーリングサイクル（2秒間隔）で最大6回のdetectPrompt呼び出しが発生し、複数ワークツリーの並列稼働時にログが急増する」。

---

## Should Fix（推奨対応）

### SF-001: 重複抑制の実装場所が曖昧

**カテゴリ**: 実装方針の曖昧さ
**場所**: 提案する解決策セクション

**問題**:
「`prompt-detector.ts`または`response-poller.ts`に前回検出プロンプトのキャッシュを追加」と記載されているが、どちらが適切か方針が定まっていない。

- **prompt-detector.ts内で実装する場合**: 全呼び出し元（response-poller、auto-yes-manager、status-detector、current-output API、prompt-response API）に一括で効果がある。
- **response-poller.ts側で実装する場合**: response-pollerの重複呼び出し（L779+L953）のみ解消できるが他の呼び出し元には効果がない。

**推奨対応**:
prompt-detector.ts内のdetectPrompt()関数にモジュールスコープの前回検出キャッシュを持たせる方式を推奨する。ただし、detectPromptは同一プロセス内の複数ワークツリーから呼ばれるため、キャッシュキーの設計（SF-005参照）もあわせて検討すべき。

---

### SF-002: ログレベル別挙動の考慮が不足

**カテゴリ**: 実装タスクの不足
**場所**: 実装タスクセクション

**問題**:
detectPromptのログは2種類のレベルで出力されている：

```typescript
// src/lib/prompt-detector.ts
logger.debug('detectPrompt:start', { outputLength: output.length });   // L171 - debugレベル
logger.info('detectPrompt:multipleChoice', {...});                     // L185 - infoレベル
logger.debug('detectPrompt:complete', { isPrompt: false });            // L216 - debugレベル
```

デフォルトログレベル設定（`src/lib/env.ts:160`）：
- 開発環境: `debug` -- 全ログ出力
- 本番環境: `info` -- debugログはスキップ

本番環境ではdebugログが出力されないため、重複抑制の効果はログレベル設定に依存する。

**推奨対応**:
実装タスクに「重複抑制がlogger.debug/logger.infoの両方のログレベルで正しく動作することを確認するテストケースの追加」を追加する。

---

### SF-003: 受入条件の75%削減が検証困難

**カテゴリ**: 受入条件の曖昧さ
**場所**: 受入条件セクション

**問題**:
「ログ出力量が大幅に削減されること（目標: 75%以上削減）」の測定方法が定義されていない。75%という数値はIssue本文内の「サーバーログの75%がdetectPromptログ」から逆算した値と思われるが、これは検証不可能な実行時データに基づいている（仮説検証結果: Unverifiable）。

**推奨対応**:
受入条件を以下のように具体化する：
- 「同一プロンプト出力に対して連続してdetectPromptが呼び出された場合、2回目以降のログ出力がスキップされること」
- 「新しいプロンプト（前回と異なるoutput内容）が検出された場合は通常通りログ出力されること」
- 75%削減は参考目標値として残しつつ、テスト可能な条件を主体にする。

---

### SF-004: 影響範囲テーブルが不完全

**カテゴリ**: 影響範囲の不足
**場所**: 影響範囲セクション

**問題**:
影響範囲テーブルに `prompt-detector.ts` と `response-poller.ts` のみ記載されているが、detectPromptを直接呼び出すファイルが他に4つ存在する。

**推奨対応**:
影響範囲テーブルを以下のように拡張する：

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/prompt-detector.ts` | 重複検出抑制ロジック追加 |
| `src/lib/response-poller.ts` | ログ出力の呼び出し箇所修正（必要に応じて） |
| `src/lib/auto-yes-manager.ts` | detectPrompt呼び出し元（影響確認） |
| `src/lib/status-detector.ts` | detectPrompt呼び出し元（影響確認） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | detectPrompt呼び出し元（影響確認） |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | detectPrompt呼び出し元（影響確認） |

---

### SF-005: キャッシュの粒度設計が未考慮

**カテゴリ**: 技術的考慮の不足
**場所**: 提案する解決策セクション

**問題**:
detectPrompt()の関数シグネチャは以下の通りで、worktreeIdパラメータを受け取らない：

```typescript
export function detectPrompt(output: string, options?: DetectPromptOptions): PromptDetectionResult
```

モジュールスコープでキャッシュする場合、異なるワークツリーのログが相互に抑制される可能性がある。

**推奨対応**:
キャッシュ設計として以下のいずれかの方針を明記する：
1. output文字列のハッシュのみでキャッシュ（ワークツリー間で同一出力は抑制。実害は少ない）
2. detectPrompt()にworktreeIdパラメータを追加してワークツリー単位でキャッシュ（正確だがAPI変更が必要）
3. 呼び出し元でキャッシュを管理（API変更不要だが各呼び出し元で対応が必要）

---

## Nice to Have（あれば良い）

### NTH-001: SF-001設計トレードオフの背景情報

**カテゴリ**: 完全性
**場所**: 背景・課題セクション

`status-detector.ts` のモジュールJSDoc（L15-20）には、detectPrompt()の重複呼び出しがSF-001として意図的な設計トレードオフであることが明記されている。この重複呼び出し自体がログ肥大化の一因であることを背景情報として記載すると、将来のメンテナーにとって有用。

---

### NTH-002: 完全スキップ vs 集約ログの判断基準

**カテゴリ**: 完全性
**場所**: 提案する解決策セクション

「同一プロンプト検出時はログ出力をスキップ（または集約ログとして「N回検出」形式で出力）」と括弧書きで2つの選択肢が記載されているが、判断基準が示されていない。

- **完全スキップ**: ログ削減効果最大だがデバッグ時に情報不足の可能性
- **集約ログ**: 定期的にカウントを出力するためデバッグ容易だが削減効果は限定的

推奨：開発環境ではdebugレベルで集約ログ、本番環境では完全スキップなど、ログレベルと連動した戦略も検討に値する。

---

## 参照ファイル

### コード
| ファイル | 関連度 |
|---------|--------|
| `src/lib/prompt-detector.ts` | 主要変更対象。L171, L185, L216のログ出力箇所 |
| `src/lib/response-poller.ts` | detectPromptの最多呼び出し元。L54, L779, L953, L1088 |
| `src/lib/auto-yes-manager.ts` | 独立呼び出し元。L69, L585 |
| `src/lib/status-detector.ts` | 間接呼び出し元。L145 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 直接呼び出し元。L101 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 直接呼び出し元。L99 |
| `src/lib/logger.ts` | ログ出力基盤。L198, L206 |
| `src/lib/env.ts` | ログレベルデフォルト設定。L160 |

### ドキュメント
| ファイル | 関連度 |
|---------|--------|
| `CLAUDE.md` | prompt-detector.ts、response-poller.ts等のモジュール説明 |
