# Architecture Review: Issue #265 - 設計原則レビュー (Stage 1)

## Executive Summary

**Issue**: #265 - Claude CLIパスキャッシュの無効化と壊れたtmuxセッションの自動回復
**Focus**: 設計原則 (SOLID / KISS / YAGNI / DRY)
**Status**: Conditionally Approved
**Score**: 4/5
**Date**: 2026-02-14
**Reviewer**: Architecture Review Agent

Issue #265 の設計方針書は、3つの独立したバグに対して明確な設計パターンを適用しており、全体的に設計原則への準拠度は高い。特に YAGNI 原則への意識（TTLベースキャッシュの却下）と KISS 原則の適用（最小限の変更アプローチ）は評価できる。ただし、Must Fix 2件と Should Fix 4件の改善事項がある。主な懸念は、isSessionHealthy() のエラーパターンハードコードによる DRY/SRP 違反リスクと、startClaudeSession() の責務肥大化である。

---

## Detailed Findings

### Must Fix (2件)

#### MF-001: isSessionHealthy() のエラーパターン判定がハードコードされている

**原則**: SRP (Single Responsibility Principle) / DRY
**重要度**: Medium

設計方針書の `isSessionHealthy()` 実装案では、以下のエラーメッセージ文字列が直接ハードコードされている。

```typescript
// 設計方針書より抜粋
if (cleanOutput.includes('Claude Code cannot be launched inside another Claude Code session')) {
  return false;
}
if (cleanOutput.includes('Error:') && cleanOutput.includes('Claude')) {
  return false;
}
```

現在のコードベースでは、CLIツール関連のパターンは全て `src/lib/cli-patterns.ts` に集約されている（`CLAUDE_PROMPT_PATTERN`, `CLAUDE_THINKING_PATTERN`, `CLAUDE_TRUST_DIALOG_PATTERN` 等）。エラー検出パターンだけが `claude-session.ts` にハードコードされるのは、パターン管理の一元化方針と矛盾する。

**推奨対応**: `cli-patterns.ts` に `CLAUDE_SESSION_ERROR_PATTERNS` を定数として追加し、`isSessionHealthy()` から参照する。

```typescript
// src/lib/cli-patterns.ts に追加
export const CLAUDE_SESSION_ERROR_PATTERNS = [
  /Claude Code cannot be launched inside another Claude Code session/,
  /Error:.*Claude/,
] as const;
```

#### MF-002: isSessionHealthy() のシェルプロンプト検出が拡張に閉じていない

**原則**: OCP (Open/Closed Principle)
**重要度**: Medium

設計方針書の `isSessionHealthy()` では、シェルプロンプトの検出が `trimmed.endsWith('$')` にハードコードされている。

```typescript
// 設計方針書より抜粋
if (trimmed === '' || trimmed.endsWith('$')) {
  return false;
}
```

macOS のデフォルトシェルは zsh であり、zsh のプロンプトは通常 `%` で終わる。また、root ユーザーは `#` を使用する。現在のコードでは bash の `$` のみが対象であり、zsh 環境（macOS ユーザーの大半）では壊れたセッションの検出漏れが発生する。

**推奨対応**: シェルプロンプト終端文字を定数配列として定義する。

```typescript
const SHELL_PROMPT_ENDINGS = ['$', '%', '#'] as const;
// ...
if (trimmed === '' || SHELL_PROMPT_ENDINGS.some(ch => trimmed.endsWith(ch))) {
  return false;
}
```

---

### Should Fix (4件)

#### SF-001: capturePane + stripAnsi パターンの重複

**原則**: DRY
**重要度**: Low

`isSessionHealthy()` で追加される `capturePane(sessionName, { startLine: -50 })` + `stripAnsi(output)` のパターンは、`startClaudeSession()` の初期化ポーリングループ（L342-349）および `waitForPrompt()` (L270-274) と同一構造。

```typescript
// startClaudeSession() 内 (既存)
const output = await capturePane(sessionName, { startLine: -50 });
const cleanOutput = stripAnsi(output);

// isSessionHealthy() 内 (新規追加)
const output = await capturePane(sessionName, { startLine: -50 });
const cleanOutput = stripAnsi(output);
```

**推奨対応**: 共通ヘルパー関数を追加。

```typescript
async function getCleanPaneOutput(
  sessionName: string,
  lines: number = 50
): Promise<string> {
  const output = await capturePane(sessionName, { startLine: -lines });
  return stripAnsi(output);
}
```

#### SF-002: startClaudeSession() の責務肥大化リスク

**原則**: SRP
**重要度**: Medium

現在の `startClaudeSession()` は約80行（L297-381）で、以下の責務を持つ:
1. Claude CLI のインストール確認
2. 既存セッション確認
3. tmux セッション作成
4. Claude CLI パスの解決
5. Claude CLI の起動
6. 初期化待機（ポーリング）
7. 信頼ダイアログの自動応答

Bug 2 と Bug 3 の修正追加により:
8. 既存セッションのヘルスチェック + kill + 再作成 (Bug 2)
9. CLAUDECODE 環境変数の除去（2段階）(Bug 3)

計9つの責務を持つ関数になる。

**推奨対応**: Bug 3 の環境サニタイズ処理と Bug 2 のヘルスチェック + 再作成フローを独立関数に切り出す。

```typescript
async function sanitizeSessionEnvironment(sessionName: string): Promise<void> {
  await execAsync('tmux set-environment -g -u CLAUDECODE 2>/dev/null || true');
  await sendKeys(sessionName, 'unset CLAUDECODE', true);
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function ensureHealthySession(
  sessionName: string,
  options: ClaudeSessionOptions
): Promise<boolean> {
  const exists = await hasSession(sessionName);
  if (!exists) return false;

  if (await isSessionHealthy(sessionName)) {
    return true; // Healthy session exists, reuse it
  }

  await killSession(sessionName);
  return false; // Session killed, needs recreation
}
```

#### SF-003: daemon.ts での CLAUDECODE 除去が process.env 直接操作に依存

**原則**: DIP (Dependency Inversion Principle)
**重要度**: Low

`daemon.ts` の `start()` メソッドでは、既に `env` オブジェクトを構築するパターンが確立されている（L59-72）。

```typescript
// 既存のパターン (daemon.ts L59-62)
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(envResult.parsed || {}),
};
```

設計方針書のタスク7では、このオブジェクト構築後に `delete env.CLAUDECODE` とするのが既存パターンと一貫する。`process.env` への直接操作は他のモジュールに予期しない副作用を及ぼす可能性がある。

**推奨対応**: `env` オブジェクト構築直後に追加。

```typescript
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(envResult.parsed || {}),
};

// Issue #265: Remove CLAUDECODE to prevent Claude-in-Claude detection
delete env.CLAUDECODE;
```

#### SF-004: Bug 3 の2段階対策が過剰防御の可能性

**原則**: KISS
**重要度**: Low

対策 3-1（`tmux set-environment -g -u CLAUDECODE`）はtmuxのグローバル環境から変数を除去し、対策 3-2（`sendKeys(sessionName, 'unset CLAUDECODE', true)` + 100ms wait）はセッション内でシェル変数を除去する。

対策 3-1 が正常に動作すれば、新しいtmuxセッション内で CLAUDECODE は参照されない。対策 3-2 は「tmuxグローバル環境の除去が反映されるまでのタイミングウィンドウ」をカバーするが、Claude CLI の起動は対策 3-2 の後であるため、理論上は対策 3-1 だけで十分な可能性がある。

100ms の待機時間についても、`CLAUDE_POST_PROMPT_DELAY` (500ms) や `PASTED_TEXT_DETECT_DELAY` (500ms) のように設計根拠が明記されたDOCパターンと比べ、根拠記述が不足している。

**推奨対応**: 対策 3-1 単独での十分性を検証するテストケースを追加し、過剰であれば対策 3-2 を削除する。残す場合は、待機時間の根拠をコメントに明記する。

---

### Consider (3件)

#### C-001: ICLITool インターフェースへのヘルスチェック追加の検討

将来 codex や gemini でも壊れたセッション問題が発生した場合に備え、`ICLITool` にオプショナルな `isSessionHealthy?()` メソッドを追加する拡張ポイントとして認識しておく。現時点では YAGNI に従い内部関数のままで良い。

#### C-002: clearCachedClaudePath() の export 範囲

テスト可能性のための export は妥当だが、`@internal` タグを付けて意図を明確にすることを推奨。

#### C-003: startClaudeSession() の戻り値型

セッション再作成が発生したかどうかの情報は現時点では不要だが、将来的にログやメトリクスで必要になる可能性がある。

---

## Design Principles Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (単一責任) | Conditionally Pass | isSessionHealthy() の責務分離は良好。startClaudeSession() の責務肥大化リスクあり (SF-002)。エラーパターンのハードコード (MF-001)。 |
| OCP (開放閉鎖) | Conditionally Pass | 定数パターンの踏襲は良好。シェルプロンプト判定が拡張に閉じていない (MF-002)。 |
| LSP (リスコフ置換) | Pass | ICLITool インターフェースへの影響なし。 |
| ISP (インターフェース分離) | Pass | ヘルスチェックを ICLITool に含めない判断は YAGNI/ISP に合致。 |
| DIP (依存性逆転) | Pass | 既存の依存構造を踏襲。daemon.ts の改善余地あり (SF-003)。 |
| KISS (シンプル) | Pass | TTLキャッシュ却下の判断は良好。Bug 3 の2段階対策に検討余地 (SF-004)。 |
| YAGNI (必要十分) | Pass | 不要な機能追加を避けている。設計判断の根拠が明確。 |
| DRY (重複排除) | Conditionally Pass | 既存関数の活用は良好。capturePane+stripAnsi パターン重複 (SF-001)、エラーパターンのハードコード (MF-001)。 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | startClaudeSession() の責務肥大化によるメンテナンスコスト増 | Medium | High | P2 |
| 技術的リスク | isSessionHealthy() のシェルプロンプト検出漏れ（zsh環境） | Medium | Medium | P1 |
| 技術的リスク | エラーパターンのハードコードによる将来のバージョンアップ時の非互換 | Medium | Low | P2 |
| セキュリティリスク | CLAUDECODE 環境変数の残存（対策不足） | Low | Low | P3 |
| 運用リスク | Bug 3 の100ms待機が不十分な場合のレースコンディション | Low | Low | P3 |

---

## Approval Status

**Status: Conditionally Approved**

Must Fix 2件（MF-001, MF-002）を対応した上で実装に進むことを推奨する。特に MF-002（シェルプロンプト検出）はmacOSのデフォルトシェルがzshであることから、対応しないと実環境で壊れたセッション検出漏れが発生するリスクが高い。

Should Fix 4件は実装中または実装後のリファクタリングとして対応可能。Consider 3件は将来の拡張ポイントとして認識するに留める。

---

## Reviewed Files

| ファイル | 目的 |
|---------|------|
| `dev-reports/design/issue-265-claude-session-recovery-design-policy.md` | レビュー対象の設計方針書 |
| `src/lib/claude-session.ts` | メイン修正対象ファイル（現在の実装確認） |
| `src/cli/utils/daemon.ts` | Bug 3 補助対策の対象ファイル |
| `src/lib/tmux.ts` | tmux操作層の既存API確認 |
| `src/lib/cli-patterns.ts` | パターン定数管理の既存方針確認 |
| `src/lib/cli-tools/types.ts` | ICLITool インターフェース確認 |
| `src/lib/cli-tools/claude.ts` | ClaudeTool の claude-session 依存確認 |
| `src/lib/status-detector.ts` | セッションステータス検出の既存パターン確認 |
| `src/lib/session-cleanup.ts` | セッションクリーンアップの既存パターン確認 |
| `tests/unit/lib/claude-session.test.ts` | 既存テストの構造確認 |
