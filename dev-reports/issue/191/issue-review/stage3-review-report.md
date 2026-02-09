# Issue #191 影響範囲レビューレポート

**レビュー日**: 2026-02-08
**フォーカス**: 影響範囲レビュー (Impact Scope)
**イテレーション**: 1回目 (Stage 3)
**前提**: Stage 1 (通常レビュー) + Stage 2 (適用) 完了済み

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## detectThinking() 呼び出し元の完全マップ

Issue #191は`detectThinking()`の検索範囲をバッファ全体から末尾N行に限定する修正を提案している。影響範囲を正確に把握するため、`detectThinking()`の全呼び出し元を特定した。

| # | ファイル | 行 | 入力の範囲 | ウィンドウイング状態 |
|---|---------|-----|-----------|-------------------|
| 1 | `src/lib/auto-yes-manager.ts` | L284 | 5000行バッファ全体 | **未適用 (本Issueの修正対象)** |
| 2 | `src/lib/status-detector.ts` | L99 | 末尾15行 (`STATUS_CHECK_LINE_COUNT`) | 適用済み |
| 3 | `src/app/api/worktrees/[id]/current-output/route.ts` | L83 | 末尾15行 (非空行フィルタ済み) | 適用済み |

**重要な発見**: Issueの影響ファイルテーブルには呼び出し元 #3 (`current-output/route.ts`) が記載されていない。

---

## Must Fix（必須対応）

### MF-1: current-output/route.ts が影響ファイルテーブルに未記載

**カテゴリ**: 影響ファイル
**場所**: Issue本文 > ## 影響ファイル テーブル

**問題**:
`src/app/api/worktrees/[id]/current-output/route.ts` (L83) が `detectThinking()` の3番目の呼び出し元であるにもかかわらず、Issueの影響ファイルテーブルに記載されていない。このルートは以下の重要な役割を果たしている:

1. クライアント側Auto-Yesパスの入口 -- `isPromptWaiting` と `thinking` フラグを `useAutoYes.ts` に提供
2. `detectThinking()` を15行ウィンドウで呼び出し、結果で `detectPrompt()` をゲーティング (L88)
3. サーバー側Auto-Yes (`auto-yes-manager.ts`) とクライアント側Auto-Yes (`useAutoYes.ts`) の両パスが存在する

**証拠**:
```typescript
// current-output/route.ts L73-74, L83, L88
const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
const lastSection = nonEmptyLines.slice(-15).join('\n');
const thinking = detectThinkingState(cliToolId, lastSection);
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPrompt(cleanOutput);
```

このルートは既に15行ウィンドウを適用しているため、Issue #191の修正による直接的な変更は不要だが、修正者が全体像を把握するために記載が必須である。

**推奨対応**:
影響ファイルテーブルに以下の行を追加:

| ファイル | 行 | 変更内容 |
|---------|-----|---------|
| `src/app/api/worktrees/[id]/current-output/route.ts` | L83 | 参照（既にウィンドウイング済み、整合性確認） |

---

## Should Fix（推奨対応）

### SF-1: テストが実際のバグシナリオをカバーしていない

**カテゴリ**: テスト範囲
**場所**: `tests/unit/lib/auto-yes-manager.test.ts` L427-499

**問題**:
Issue #161で追加されたthinking state skipテスト (`L427-499`) は3行の短い文字列を使用している:

```typescript
// L443-444
const thinkingOutput = '\u2733 Analyzing\u2026\n1. Step one\n2. Step two';
```

この入力は3行しかないため、50行ウィンドウイングの適用有無にかかわらず同じ結果になる。Issue #191の実際のバグシナリオ（5000行バッファの先頭にthinkingサマリー行があり、末尾にプロンプトがある）をテストできていない。

**推奨対応**:
以下の回帰テストを受け入れ条件に追加:

1. **バグ再現テスト**: 5000行バッファの先頭100行に `'\u00B7 Simmering\u2026 (4m 16s)'` を配置し、末尾に `'Do you want to proceed? (y/n)'` を配置。修正後は `sendKeys` が呼ばれることを検証
2. **正常動作テスト**: 末尾50行以内にthinkingパターンがある場合、`sendKeys` が呼ばれないことを検証

---

### SF-2: サーバー側とクライアント側のウィンドウサイズ不一致

**カテゴリ**: 依存関係
**場所**: ## 修正方針の候補 > 案1

**問題**:
修正後、Auto-Yesの2つのパスで `detectThinking()` に渡すウィンドウサイズが異なる:

| パス | ファイル | ウィンドウサイズ | 空行フィルタ |
|------|---------|---------------|------------|
| サーバー側ポーリング | `auto-yes-manager.ts` | **50行** (修正後) | なし |
| クライアント側ポーリング | `current-output/route.ts` | 15行 | あり (非空行のみ) |
| ステータス表示 | `status-detector.ts` | 15行 | なし |

通常はサーバー側が先に応答し、クライアント側は `lastServerResponseTimestamp` による重複防止 (`DUPLICATE_PREVENTION_WINDOW_MS = 3000`) で抑制されるため、実運用上の問題は発生しにくい。しかし、Issueにこの差異の存在と意図を記載すべきである。

**推奨対応**:
Issueの修正方針に以下の注記を追加:
- `auto-yes-manager.ts` は50行ウィンドウ（`detectPrompt()` の `multiple_choice` 検出ウィンドウと整合）
- `current-output/route.ts` は15行ウィンドウ（ステータス表示用、Issue #180で導入済み）
- 両パスのウィンドウサイズ差異はサーバー側優先メカニズム (Issue #138) により実運用上の影響なし

---

### SF-3: Codex CLI のthinkingパターンへの影響の記載

**カテゴリ**: 破壊的変更
**場所**: Issue本文、影響ファイルテーブル

**問題**:
`detectThinking()` は `cliToolId` に基づいてClaude/Codex/Geminiのパターンを分岐する。Issue本文はClaude CLIのパターンのみに言及しているが、Codexの `CODEX_THINKING_PATTERN` (L36) も同じ `detectThinking()` を経由する。

Codexの `'\u2022 Ran'` パターンはコマンド実行完了ログにもマッチする（Claude CLIのスピナー+ellipsisとは異なり、Codexの `Ran` は完了した操作も示す）。50行ウィンドウ適用後も、直近50行以内の `'\u2022 Ran ls -la'` にマッチする可能性があるが、これはIssue #191以前から存在する挙動であり、ウィンドウ縮小は偽陽性の表面を5000行から50行に削減する純改善である。

**推奨対応**:
Issueに以下の注記を追加:
- Codex CLIの `CODEX_THINKING_PATTERN` も `detectThinking()` 経由で50行ウィンドウの恩恵を受ける
- `'\u2022 Ran'` パターンの偽陽性リスクは既存問題であり、Issue #191のスコープ外
- 必要であれば別Issueで `CODEX_THINKING_PATTERN` の精度改善を検討

---

## Nice to Have（あれば良い）

### NTH-1: claude-poller.ts のローカル thinkingPattern との関係

**カテゴリ**: テスト範囲
**場所**: Issue本文 > ## 関連

**問題**:
`claude-poller.ts` (L76) には独自のローカル `thinkingPattern` (`/[\u2733\u273D\u23FA\u00B7\u2234\u2722\u2733]/m`) が定義されており、`detectThinking()` 関数を使用していない。このパターンはスピナー文字の存在のみをチェックし（ellipsis不要）、`cli-patterns.ts` の `CLAUDE_THINKING_PATTERN` より粗いマッチングを行う。

Issue #191の修正はこのコードパスに影響しないが、thinking検出の全体像を把握するために関連セクションに記載があると有益である。Issue #161の設計レビュー (S1-008, S3-011) で統一が提案されており、別Issueとして追跡されている。

**推奨対応**:
関連セクションに以下を追加:
- `Note: claude-poller.ts (L76) は detectThinking() を使用しないローカル thinkingPattern を持つ（既知のパターン重複、Issue #161 S1-008で追跡中）。本修正の影響外。`

---

### NTH-2: CLAUDE.md の更新

**カテゴリ**: ドキュメント更新
**場所**: CLAUDE.md Issue #161 セクション

**問題**:
CLAUDE.mdのIssue #161セクションには「`auto-yes-manager.ts`の`pollAutoYes()`で`detectThinking()`による事前チェック」と記載されている。Issue #191実装後、この事前チェックがウィンドウ化された検索に変更されることを反映すべきである。

**推奨対応**:
実装完了後にCLAUDE.mdを更新: 「Layer 1 (thinking状態スキップ) は末尾50行ウィンドウで検索（Issue #191でバッファ全体検索から修正）」

---

## 影響範囲分析

### Auto-Yesフロー全体図

```
[サーバー側パス - auto-yes-manager.ts]
  startAutoYesPolling()
    -> pollAutoYes() (2秒間隔)
      -> captureSessionOutput(5000行)
      -> stripAnsi()
      -> detectThinking(cliToolId, cleanOutput)  <-- FIX: slice(-50)
      -> detectPrompt(cleanOutput)               <-- prompt-detector内部で10/50行ウィンドウ
      -> resolveAutoAnswer(promptData)
      -> sendKeys()

[クライアント側パス - current-output/route.ts + useAutoYes.ts]
  GET /api/worktrees/:id/current-output
    -> captureSessionOutput(10000行)
    -> nonEmptyLines.slice(-15) = lastSection
    -> detectThinking(cliToolId, lastSection)     <-- 既にウィンドウ済み
    -> detectPrompt(cleanOutput)                  <-- thinkingでなければ実行
    -> response: { isPromptWaiting, thinking, lastServerResponseTimestamp }
  useAutoYes.ts
    -> isPromptWaiting && autoYesEnabled
    -> lastServerResponseTimestamp check (3秒以内なら抑制)
    -> resolveAutoAnswer()
    -> fetch prompt-response API

[ステータス表示パス - status-detector.ts]
  detectSessionStatus(output, cliToolId)
    -> stripAnsi()
    -> lines.slice(-15) = lastLines
    -> detectPrompt(lastLines)                    <-- 15行ウィンドウ
    -> detectThinking(cliToolId, lastLines)        <-- 15行ウィンドウ
    -> return { status, hasActivePrompt }
```

### 多層防御への影響

| 防御層 | 場所 | 影響 |
|--------|------|------|
| Layer 1: thinking状態スキップ | auto-yes-manager.ts L281-287 | **修正対象**: 入力が50行ウィンドウに変更。防御は維持されるがスコープ限定 |
| Layer 2: 2パス検出 | prompt-detector.ts L264-288 | 影響なし: 独自の50行ウィンドウで動作 |
| Layer 3: 連番検証 | prompt-detector.ts L334-341 | 影響なし: Layer 2内部で動作 |
| Layer 4: 最小2選択肢 | prompt-detector.ts L343-350 | 影響なし: Layer 2内部で動作 |

### 回帰リスク評価

| リスク | 可能性 | 根拠 |
|--------|--------|------|
| 正当なthinking状態の検出漏れ | 極低 | Claude CLIのthinkingインジケーターは最終可視行に継続的に書き換えられるため、50行ウィンドウ外にスクロールアウトしない |
| Codex `Ran` パターンの偽陽性 | 低 | 既存問題。5000行から50行への縮小は純改善 |
| サーバー/クライアント間の不整合 | 極低 | 重複防止メカニズム (Issue #138) が存在 |

### 破壊的変更

**なし**。本修正はAPIインターフェース、設定、型定義に変更を加えない。`detectThinking()` 関数のシグネチャも変更されない。変更は `pollAutoYes()` 内のローカルな入力加工のみ。

---

## 参照ファイル

### コード (直接影響)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/auto-yes-manager.ts` (L276-287): 修正対象。detectThinking()にバッファ全体を渡している
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/cli-patterns.ts` (L26-29, L36, L73-95): detectThinking()関数定義、CLAUDE/CODEX_THINKING_PATTERN

### コード (間接影響/参照)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/status-detector.ts` (L50, L99): 参照実装。15行ウィンドウイング
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/app/api/worktrees/[id]/current-output/route.ts` (L73-88): 3番目のdetectThinking()呼び出し元（未記載 MF-1）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/prompt-detector.ts` (L48, L268): detectPrompt()のウィンドウサイズ参照
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/auto-yes-resolver.ts` (L1-39): 影響なし。PromptDataを受け取る
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/session-cleanup.ts` (L110-118): 影響なし。ポーラー停止のみ
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/hooks/useAutoYes.ts` (L46-96): 影響なし。クライアント側Auto-Yes
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/claude-poller.ts` (L76): 影響なし。ローカルthinkingPattern使用

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/tests/unit/lib/auto-yes-manager.test.ts` (L427-499): thinking stateスキップテスト（テスト不足 SF-1）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/tests/unit/lib/cli-patterns.test.ts` (L142-163): detectThinking()ユニットテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/__tests__/cli-patterns.test.ts` (L131-146): detectThinking()テスト（重複テストファイル）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/__tests__/status-detector.test.ts` (L1-389): ウィンドウイング動作のテスト参照

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/CLAUDE.md`: Issue #161セクションの更新候補 (NTH-2)
