# Architecture Review: Issue #405 - Stage 4 Security Review

| 項目 | 内容 |
|------|------|
| Issue | #405 |
| レビュー種別 | セキュリティレビュー (Stage 4) |
| 対象文書 | `dev-reports/design/issue-405-tmux-capture-optimization-design-policy.md` |
| 日付 | 2026-03-04 |
| 判定 | 条件付き承認 (conditionally_approved) |
| スコア | 4/5 |

---

## 1. エグゼクティブサマリー

Issue #405のtmux capture最適化設計方針書について、OWASP Top 10の全10カテゴリの観点でセキュリティレビューを実施した。

全体として、設計は既存のセキュリティ機構（execFile()によるシェルインジェクション防止、validateSessionName()によるセッション名バリデーション、middleware.tsによる認証）を適切に活用しており、キャッシュ導入に伴う新規のセキュリティリスクは限定的である。

Must Fix 2件、Should Fix 5件、Consider 5件の指摘事項を検出した。Must Fixはいずれも設計文書への追記・明確化レベルであり、アーキテクチャの根本的な変更を要するものではない。主要な懸念事項は、(1) キャッシュキーのバリデーション信頼チェーンの明文化、(2) lazy evictionによる機密データ残留リスクの分析補強の2点である。

---

## 2. OWASP Top 10 チェックリスト

### A01: Broken Access Control (アクセス制御の欠陥)

**判定: 注意付き合格**

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| キャッシュデータへのアクセス制御 | OK | middleware.ts認証が前段に存在 |
| globalThisアクセスのプロセス内分離 | 注意 | SEC4-003: 技術的に直接参照可能だが、リスクは受容可能 |
| API層からのキャッシュ操作権限 | OK | export関数経由のみ |

globalThis.__tmuxCaptureCacheは同一プロセス内の任意モジュールから直接参照可能である。しかし、以下の理由によりリスクは受容可能と判断する:

1. 同一プロセス内のコードは全てファーストパーティコード（プロジェクト内モジュール）
2. サードパーティモジュールからの直接アクセスはnpmサプライチェーン攻撃に限定
3. 既存のglobalThisパターン（`__autoYesStates`、`__scheduleManagerStates`等）と同等のリスクレベル

**[SEC4-003]** 設計書セクション6にリスク受容の根拠を明記すること。

### A02: Cryptographic Failures (暗号化の失敗)

**判定: 合格**

キャッシュデータは平文でメモリ上に保持されるが、tmux scrollbackバッファ自体が平文であり、キャッシュがリスクを増加させない。プロセスのヒープダンプを取得できる攻撃者はプロセス内の全データにアクセス可能であるため、キャッシュの暗号化は実効的な防御にならない。追加対策は不要。

### A03: Injection (インジェクション)

**判定: 条件付き合格**

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| sessionName → tmuxコマンド | OK | tmux.tsがexecFile()使用（Issue #393） |
| sessionName → キャッシュキー | 要対応 | SEC4-001: バリデーション信頼チェーンの明文化必要 |
| キャプチャ出力 → キャッシュ値 | OK | Map.set()で保持、外部出力時はstripAnsi()適用 |

キャッシュキーとして使用されるsessionNameのバリデーションは以下の信頼チェーンに依存している:

```
API route → CLIToolManager.getTool() → BaseCLITool.getSessionName()
                                            ↓
                                    validateSessionName()
                                            ↓
                                    SESSION_NAME_PATTERN: /^[a-zA-Z0-9_-]+$/
```

`src/lib/cli-tools/validation.ts`（L20-39）の`validateSessionName()`は英数字、アンダースコア、ハイフンのみを許可しており、Mapキーとしての使用は安全である。しかし、`tmux-capture-cache.ts`自体にはこの前提条件の記載がない。

**[SEC4-001]** tmux-capture-cache.tsのモジュールJSDocに信頼前提条件を明記すること。defense-in-depthとしてsetCachedCapture()内にSESSION_NAME_PATTERNチェックの追加を検討すること。

### A04: Insecure Design (安全でない設計)

**判定: 条件付き合格**

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| 機密データの保持期間 | 要対応 | SEC4-002: lazy evictionの制約明記必要 |
| singleflightエラー共有 | 注意 | SEC4-005: エラー情報の外部露出経路の確認 |
| キャッシュポイズニング | 注意 | SEC4-007: captureSessionOutputFresh()の書き戻し |
| TTLの妥当性 | OK | 2秒は最小限の保持期間 |

**機密データ保持（SEC4-002）の詳細分析:**

設計書セクション6.1ではTTL=2秒によるセンシティブデータ対策を記載している。しかし、TTL失効はlazy eviction（`getCachedCapture()`呼び出し時のtimestampチェック）であり、能動的なエントリ削除は行われない。

```typescript
// 設計書3.1.1のインターフェース:
// getCachedCapture() - TTL切れエントリは呼び出し時に自動削除される（lazy eviction）
```

以下のシナリオでは期限切れデータが残留する:

1. worktreeの全CLIセッションが停止した後、当該worktreeに対するポーリングが停止
2. キャッシュエントリのTTL（2秒）が切れる
3. `getCachedCapture()`が呼ばれないため、Mapエントリはメモリ上に残留
4. `clearAllCache()`（graceful shutdown）まで、またはCACHE_MAX_ENTRIES到達時のevictionまで残存

設計書セクション7.3のeviction戦略にサイズベースの最古エントリ削除が記載されているが、CACHE_MAX_ENTRIESに達しない限り発動しない。

**対策推奨:** `setCachedCapture()`呼び出し時に、全エントリのTTLチェックを実行するfull sweep処理を追加する。CACHE_MAX_ENTRIES=100程度のMap走査コストは無視可能（O(n)、n<=100）である。

**キャッシュポイズニング（SEC4-007）の分析:**

`captureSessionOutputFresh()`は以下のフローでキャッシュに書き戻す:

```typescript
// 設計書3.4.3より:
const output = await capturePane(sessionName, { startLine: -CACHE_MAX_CAPTURE_LINES });
setCachedCapture(sessionName, output, CACHE_MAX_CAPTURE_LINES);  // 書き戻し
return sliceOutput(output, lines);
```

capturePane()がtmuxバグ等により空文字列や不完全なデータを返した場合、setCachedCapture()により他の呼び出し元に破損データが伝播する。DA3-005のTOCTOU対策（失敗時のinvalidateCache）は記載されているが、「成功したが品質が低いデータ」のケースがカバーされていない。

### A05: Security Misconfiguration (セキュリティの設定ミス)

**判定: 注意付き合格**

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| CACHE_MAX_ENTRIES上限値 | 注意 | SEC4-004: 理論上限100MBの妥当性根拠 |
| CACHE_MAX_CAPTURE_LINES上限値 | OK | 10000行は合理的 |
| CACHE_TTL_MS値 | OK | 2秒は最小限 |

**メモリ上限の分析（SEC4-004）:**

| 項目 | 通常想定 | 理論上限 |
|------|---------|---------|
| 同時エントリ数 | 20 (10WT x 2CLI) | 100 (CACHE_MAX_ENTRIES) |
| エントリサイズ | ~1MB | ~1MB |
| 合計メモリ | ~20MB | ~100MB |
| V8ヒープ比率 | ~1.2% | ~6% |

CACHE_MAX_ENTRIES=100は、MAX_WORKTREES(=10) x CLI_TOOL_IDS.length(=5) = 50の2倍であり、安全係数として合理的。V8デフォルトヒープ（約1.7GB）に対して6%であり、DoS耐性として十分。

### A06: Vulnerable Components (脆弱なコンポーネント)

**判定: 合格**

tmux-capture-cache.tsは標準ライブラリのMap/Date.now()のみを使用し、新規npm依存を一切追加しない。脆弱なコンポーネントのリスクは存在しない。

### A07: Authentication and Session Management (認証・セッション管理の失敗)

**判定: 合格**

キャッシュモジュールは認証チェック後のAPI層から呼ばれるため、`middleware.ts`の認証（CM_AUTH_TOKEN_HASH + IP制限）が前段で機能する。キャッシュ導入により認証バイパスの新規経路は生じない。

認証フロー:

```
Client Request
    ↓
middleware.ts (IP制限 + Token認証)
    ↓
API Route (worktrees/route.ts等)
    ↓
captureSessionOutput() / captureSessionOutputFresh()
    ↓
tmux-capture-cache.ts (キャッシュ層)
```

### A08: Data Integrity Failures (データとソフトウェアの整合性の失敗)

**判定: 合格**

TTL=2秒のキャッシュにより最大2秒のstale data可能性があるが、prompt-response APIではcaptureSessionOutputFresh()でバイパスする設計は適切である。キャッシュの書き戻し（setCachedCapture）によりstale dataが他の呼び出し元にも伝播する設計は、パフォーマンスとデータ鮮度のバランスとして妥当。

### A09: Insufficient Logging and Monitoring (ロギングとモニタリングの失敗)

**判定: 注意付き合格**

| ログポイント | 設計書記載 | 評価 |
|------------|-----------|------|
| キャッシュヒット | あり (debug) | OK |
| キャッシュミス | あり (debug) | OK |
| singleflightヒット | あり (debug) | OK |
| キャッシュ無効化 | **なし** | SEC4-006 |
| clearAllCache() | なし | 検討対象 |

**[SEC4-006]** invalidateCache()呼び出し時のdebugログが未規定。B案の分散無効化方式（8箇所）では、無効化漏れのトラブルシューティングにログが不可欠。

### A10: Server-Side Request Forgery (SSRF)

**判定: 合格**

tmux-capture-cache.tsは外部ネットワーク通信を一切行わない。ローカルのtmuxプロセスとのプロセス間通信（execFile）のみ。SSRFリスクは存在しない。

---

## 3. 重点観点の詳細分析

### 3.1 tmuxキャプチャデータの機密性

tmuxセッション出力には以下の機密情報が含まれる可能性がある:

| 情報種別 | 出現可能性 | リスク |
|---------|-----------|--------|
| APIキー/トークン | 中 | CLIツールがAPI応答にトークンを含む場合 |
| 環境変数 | 低 | `env`コマンド実行時 |
| ファイルパス | 高 | 通常の開発操作で頻出 |
| ソースコード | 高 | CLIツールが表示するコード片 |
| 認証情報 | 低 | CLI認証プロセス中のみ |

**現行の防御策:**
- TTL=2秒による短時間保持
- CACHE_MAX_ENTRIES=100によるメモリ上限
- clearAllCache()によるshutdown時全削除
- middleware.tsによるアクセス制御

**評価:** 機密データがキャッシュに含まれるリスクは存在するが、TTL=2秒という短い保持期間と、tmux scrollbackバッファ自体が同等以上のデータを保持している点を考慮すると、キャッシュ導入によるリスク増加は限定的である。SEC4-002で指摘したlazy evictionの制約を設計書に明記することで十分。

### 3.2 globalThisキャッシュへのアクセス制御

既存のglobalThisパターンとの比較:

| globalThisプロパティ | モジュール | データ種別 | 機密性 |
|--------------------|-----------|-----------|--------|
| `__autoYesStates` | auto-yes-manager.ts | ポーリング状態 | 低 |
| `__autoYesPollerStates` | auto-yes-manager.ts | ポーリング状態 | 低 |
| `__scheduleManagerStates` | schedule-manager.ts | スケジュール状態 | 中 |
| `__scheduleActiveProcesses` | claude-executor.ts | プロセス情報 | 中 |
| `__versionCheckCache` | version-checker.ts | バージョン情報 | 低 |
| **`__tmuxCaptureCache`** | **tmux-capture-cache.ts** | **tmux出力** | **中-高** |

`__tmuxCaptureCache`は既存のglobalThisプロパティの中で最もデータの機密性が高い。しかし、全てのglobalThisプロパティは同一Node.jsプロセス内でのみ共有され、プロセス境界を越えない。

### 3.3 キャッシュ汚染・Poisoning攻撃の可能性

**攻撃ベクトル分析:**

1. **sessionNameインジェクションによるキャッシュキー操作**: validateSessionName()により`/^[a-zA-Z0-9_-]+$/`パターンでバリデーションされるため、キャッシュキーの操作は不可能。
2. **tmux出力の改竄によるキャッシュ値操作**: tmux captureの出力はtmuxプロセスのscrollbackバッファから取得され、ネットワーク経路を経由しない。CLIツールの出力自体に悪意あるデータが含まれる可能性はあるが、これはキャッシュ有無に関わらず同じリスク。
3. **TTL操作によるstale data攻撃**: TTL値はモジュール内定数（`CACHE_TTL_MS = 2000`）であり、外部から変更不可能。
4. **captureSessionOutputFresh()を介したキャッシュ書き戻し**: SEC4-007で指摘。capturePane()の出力品質チェックを推奨。

**結論:** キャッシュ汚染の実効的な攻撃経路は存在しない。

### 3.4 セッション名やキャッシュキーのインジェクションリスク

セッション名の生成パス:

```
BaseCLITool.getSessionName(worktreeId)
    → sessionName = `mcbd-${this.id}-${worktreeId}`
    → validateSessionName(sessionName)  // /^[a-zA-Z0-9_-]+$/
    → return sessionName
```

- `this.id`はCLI_TOOL_IDS定数配列からの固定値（`'claude'|'codex'|'gemini'|'vibe-local'|'opencode'`）
- `worktreeId`はDBから取得される値で、`isValidWorktreeId()` (`/^[a-zA-Z0-9_-]+$/`) でAPI層バリデーション済み
- `validateSessionName()`が最終防衛線として機能

**結論:** インジェクションリスクは適切に緩和されている。SEC4-001の信頼チェーン明文化を推奨。

### 3.5 DoS攻撃対策

| 対策 | 定数 | 効果 |
|------|------|------|
| エントリ上限 | CACHE_MAX_ENTRIES=100 | Mapサイズ上限 |
| キャプチャ行数上限 | CACHE_MAX_CAPTURE_LINES=10000 | エントリサイズ上限 |
| TTL | CACHE_TTL_MS=2000 | 自動失効 |
| inflight集約 | singleflightパターン | stampede防止 |
| capturePane maxBuffer | 10MB | tmux.ts既存設定 |

**評価:** DoS対策は十分。CACHE_MAX_ENTRIES超過時の最古エントリ削除ポリシーにより、メモリ枯渇攻撃は緩和される。singleflightパターンにより同一セッションへの重複captureが防止され、tmuxプロセス生成のDoSも緩和される。

### 3.6 キャッシュデータの適切なクリーンアップとTTL管理

| クリーンアップ契機 | 方式 | 網羅性 |
|------------------|------|--------|
| TTL失効 | lazy eviction (getCachedCapture時) | 呼び出しがない間は残留 |
| サイズ超過 | setCachedCapture時に最古削除 | 能動的だがMAX_ENTRIES到達時のみ |
| 明示的無効化 | invalidateCache(sessionName) | 8箇所の分散呼び出し |
| graceful shutdown | clearAllCache() | session-cleanup.ts経由 |
| テスト | resetCacheForTesting() | beforeEach()で使用 |

**懸念:** lazy evictionのみでは、アイドル状態のworktreeのキャッシュが長期間残留する。SEC4-002で推奨したsetCachedCapture()時のfull sweepにより、能動的なTTLベース削除を追加すること。

---

## 4. リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | キャッシュ内機密データの残留（lazy eviction） | Medium | Low | P2 |
| セキュリティ | バリデーション信頼チェーンの暗黙的依存 | Medium | Low | P2 |
| セキュリティ | captureSessionOutputFresh()書き戻しによる破損データ伝播 | Low | Low | P3 |
| セキュリティ | singleflightエラー共有による情報漏洩 | Low | Low | P3 |
| 運用 | キャッシュ無効化漏れのトラブルシューティング困難 | Low | Medium | P3 |
| 技術的 | globalThisキャッシュの直接参照リスク | Low | Low | P4 |

---

## 5. 改善推奨事項

### 5.1 必須改善項目 (Must Fix)

#### [SEC4-001] キャッシュキーのバリデーション信頼チェーンの明文化

**対象:** 設計書セクション3.1.2、セクション6

tmux-capture-cache.tsの各export関数（getCachedCapture、setCachedCapture、invalidateCache、getOrFetchCapture）は、sessionNameがvalidateSessionName()によりバリデーション済みであることを前提としている。この前提条件をモジュールJSDocに明記する。

実装例:
```typescript
/**
 * tmux capture output cache module.
 *
 * SECURITY: This module assumes sessionName parameters are pre-validated
 * by BaseCLITool.getSessionName() -> validateSessionName().
 * Session names must match /^[a-zA-Z0-9_-]+$/.
 * Do not pass unsanitized user input as sessionName.
 */
```

加えて、defense-in-depthとしてsetCachedCapture()にランタイムチェックの追加を検討する:
```typescript
import { SESSION_NAME_PATTERN } from './cli-tools/validation';

export function setCachedCapture(sessionName: string, output: string, capturedLines: number): void {
  // Defense-in-depth: validate sessionName even though callers should pre-validate
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    console.warn(`[tmux-capture-cache] Invalid sessionName rejected: ${sessionName.substring(0, 50)}`);
    return;
  }
  // ... existing logic
}
```

#### [SEC4-002] lazy evictionの制約とsweep処理の設計追記

**対象:** 設計書セクション6.1、セクション7.3

設計書に以下を追記する:

1. lazy evictionの制約: `getCachedCapture()`が呼ばれない間はTTL切れエントリがメモリ上に残留すること
2. 緩和策: `setCachedCapture()`呼び出し時に全エントリのTTLチェックを実行するsweep処理を追加すること
3. sweepのコスト: Map走査O(n)、n<=100のため無視可能

```typescript
export function setCachedCapture(sessionName: string, output: string, capturedLines: number): void {
  // Proactive TTL sweep: remove all expired entries
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  // ... existing size-based eviction and set logic
}
```

### 5.2 推奨改善項目 (Should Fix)

#### [SEC4-003] globalThisアクセスのリスク受容根拠の明記

設計書セクション6に「プロセス内コード信頼前提」を追記する。

#### [SEC4-004] メモリ上限の理論値と算出根拠の明記

設計書セクション4.2に通常想定値と理論上限値の2段階記載を追加する。

#### [SEC4-005] singleflightエラー共有時の情報漏洩経路の確認

captureSessionOutput()のcatchブロックで固定文字列エラーパターン（D1-007準拠）が一貫適用されていることを確認し、設計書に明記する。

#### [SEC4-006] invalidateCache()の監査ログ追加

invalidateCache()関数内にdebugレベルのログ出力を追加する設計を記載する。

#### [SEC4-007] captureSessionOutputFresh()の書き戻し前品質チェック

capturePane()出力が空文字列でないことを確認してからsetCachedCapture()を呼ぶガードを追加する。

### 5.3 検討事項 (Consider)

- [SEC4-008] キャッシュデータの暗号化は不要（現行設計で妥当）
- [SEC4-009] SSRFリスクは不在（現行設計で妥当）
- [SEC4-010] 新規サードパーティ依存なし（現行設計で妥当）
- [SEC4-011] 認証機構がキャッシュアクセス制御として機能（現行設計で妥当）
- [SEC4-012] キャッシュデータ整合性の設計は適切（現行設計で妥当）

---

## 6. 承認状態

**条件付き承認 (conditionally_approved)**

Must Fix 2件（SEC4-001、SEC4-002）の設計書への反映を条件として承認する。これらはいずれも実装レベルのコード変更ではなく、設計書への追記・明確化であり、Phase 1実装時に併せて対応可能である。

既存のセキュリティ機構（execFile()、validateSessionName()、middleware.ts認証、IP制限）がキャッシュ層の前段で適切に機能しており、キャッシュ導入に伴う新規の重大なセキュリティリスクは検出されなかった。

---

*Generated by architecture-review-agent*
*Date: 2026-03-04*
*Reviewer: Stage 4 Security Review*
