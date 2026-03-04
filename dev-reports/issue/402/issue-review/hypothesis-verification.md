# Issue #402 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | detectPromptログが1秒間に30回以上同一内容で出力されている | Partially Confirmed | ポーリング頻度・複数呼び出しは確認。30回/秒は使用形態依存 |
| 2 | サーバーログ182,422行のうち137,645行（75%）がdetectPromptログ | Unverifiable | 実行時データのため、コードのみでは検証不可（可能性は高い） |
| 3 | 同一プロンプトに対して100ms間隔で繰り返しログ出力されている | Rejected | コードのポーリング間隔は2000ms（2秒）。100msは誤り |
| 4 | ポーリング頻度は2-5秒間隔だが、1回のポーリングで複数回検出が走る | Confirmed | extractResponse()内でdetectPromptが最大2回、さらに呼び出し元でも追加実行 |
| 5 | 変更対象は`prompt-detector.ts`または`response-poller.ts` | Confirmed | detectPromptの全ログ出力はprompt-detector.tsに集中している |

## 詳細検証

### 仮説 1: detectPromptログが1秒間に30回以上同一内容で出力

**Issue内の記述**: 「`prompt-detector`の`detectPromptログ`が1秒間に30回以上同一内容で出力されており」

**検証手順**:
1. `src/lib/prompt-detector.ts` のlogger呼び出し箇所を確認（L171, L185, L216）
2. detectPromptの各呼び出しサイトを調査（response-poller.ts, auto-yes-manager.ts, status-detector.ts, current-output/route.ts）
3. ポーリング間隔を調査（POLLING_INTERVAL = 2000ms）

**確認した呼び出しサイト**:
- `response-poller.ts:779` - claude/codex向けの早期プロンプト検出
- `response-poller.ts:953` - opencode以外全ツール向けの一般プロンプト検出
- `response-poller.ts:1088` - result.promptDetection未定義時のフォールバック検出
- `auto-yes-manager.ts:585` - 2秒毎ポーリング
- `status-detector.ts:145` - detectSessionStatus()経由
- `current-output/route.ts:101` - フロントエンドから2-5秒毎にpolling

**判定**: Partially Confirmed

**根拠**: ログが大量に出力される仕組みは確認できた（1ポーリングサイクル当たり最大3〜5回のdetectPrompt呼び出し）。ただし「1秒間に30回」という数値は、Active状態の複数Worktree・複数ブラウザタブが同時に稼働する使用形態に依存する。

---

### 仮説 2: サーバーログの75%がdetectPromptログ

**Issue内の記述**: 「サーバーログ182,422行のうち137,645行（75%）が`detectPrompt`ログ」

**判定**: Unverifiable

**根拠**: 実際のサーバーログファイルを参照しないと検証できない。ただし、仮説1で確認した複数呼び出しメカニズム（各detectPrompt呼び出しで最低2行のdebugログ）から、ログ肥大化が発生することは技術的に妥当。

---

### 仮説 3: 100ms間隔でのログ出力

**Issue内の記述**: 「同一プロンプトに対して100ms間隔で繰り返しログ出力されている」

**検証手順**:
1. `response-poller.ts:54` - `const POLLING_INTERVAL = 2000;`
2. `auto-yes-manager.ts:69` - `export const POLLING_INTERVAL_MS = 2000;`
3. `WorktreeDetailRefactored.tsx:99-102` - `ACTIVE_POLLING_INTERVAL_MS = 2000; IDLE_POLLING_INTERVAL_MS = 5000;`

**判定**: Rejected

**根拠**: コードの実際のポーリング間隔は2000ms（Active時）または5000ms（Idle時）。100msはコードベースに存在しない（100msはclaude-session.ts等での一時的なwait目的のsleepのみ）。Issue内の「100ms間隔」という記述は事実に反する。

**Issueへの影響**: Issue内の「100ms間隔」という記述を「2秒間隔（POLLING_INTERVAL = 2000ms）」に修正すべき。

---

### 仮説 4: 1回のポーリングで複数回検出が走る

**Issue内の記述**: 「ポーリング頻度は2-5秒間隔だが、1回のポーリングで複数回検出が走る」

**検証手順**:
1. `extractResponse()` の詳細確認（response-poller.ts:700+）
2. Line779: `if (cliToolId === 'claude' || cliToolId === 'codex')` → detectPromptWithOptions 1回目
3. Line953: `if (cliToolId !== 'opencode')` → detectPromptWithOptions 2回目（プロンプト未検出時のみ到達）
4. Line1088: `result.promptDetection ?? detectPromptWithOptions(...)` → 3回目の可能性
5. `auto-yes-manager.ts:585` と `current-output/route.ts:101` の独立呼び出し

**判定**: Confirmed

**根拠**: `extractResponse()`がclaude/codexの場合、同一出力に対して最大2回detectPromptを実行する。さらに`checkForResponse()`（response-pollerのメインループ）でも1回実行される可能性がある。auto-yes-manager（2秒毎）とcurrent-output API（フロントエンド polling）も独立してdetectPromptを呼び出す。1回のポーリングサイクル全体では複数回の検出が走ることは確認できた。

---

### 仮説 5: 変更対象ファイルの特定

**Issue内の記述**: `prompt-detector.ts`または`response-poller.ts`に前回検出プロンプトのキャッシュを追加

**検証手順**:
- `prompt-detector.ts:171` - `logger.debug('detectPrompt:start', { outputLength: output.length });`
- `prompt-detector.ts:185-190` - `logger.info('detectPrompt:multipleChoice', {...})`
- `prompt-detector.ts:216` - `logger.debug('detectPrompt:complete', { isPrompt: false });`

**判定**: Confirmed

**根拠**: detectPromptのログ出力はすべて`prompt-detector.ts`に集中。重複抑制機能をここに追加するのが最適。`response-poller.ts`での複数回呼び出しも検討対象として適切。

---

## Stage 1レビューへの申し送り事項

- **仮説3（Rejected）**: Issue内の「100ms間隔」という記述を「2秒間隔」に修正するよう指摘すること
- **仮説4（Confirmed）**: `extractResponse()` 内での複数回detectPrompt呼び出しのパターン（L779 + L953）もログ重複の原因であることを踏まえ、対応範囲として`response-poller.ts`も含めるかどうか検討すること
- **実装方針の明確化**: 重複抑制の実装場所として、`prompt-detector.ts`内部（関数レベルのキャッシュ）と`response-poller.ts`内部（呼び出し側での重複排除）のどちらが適切か、Issueで明示する必要がある
