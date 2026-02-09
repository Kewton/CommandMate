# Issue #188 レビューレポート（Stage 1）

**レビュー日**: 2026-02-09
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 2 |

### 総合所見

Issue #188は応答完了後もスピナーが表示され続ける問題を的確に特定しており、原因分析の方向性は正しい。しかし、**Issueのコードスニペットと現在のコードベースとの間に重大な乖離**が3箇所存在する。特に `worktrees/route.ts` は Issue #180 で既に `status-detector.ts` に統合済みであり、Issueが示すインラインロジックは現在のコードに存在しない。また、仮説検証レポートが `claude-poller.ts` の存在を誤って否定しているが、実際にはファイルが存在し、IssueのP2指摘（緩いthinkingPattern）は正しい。

---

## Must Fix（必須対応）

### MF-1: 問題箇所1のコードスニペットが現在のworktrees/route.tsと一致しない

**カテゴリ**: 正確性
**場所**: ### 問題箇所1: サイドバーステータス検出 セクション

**問題**:
Issueの「問題箇所1」で引用されている `worktrees/route.ts` L66-83 のコードスニペットは、`nonEmptyLines` フィルタリングと `detectThinking()` 呼び出しを含むインラインロジックを示している。しかし、実際の `worktrees/route.ts` にはこのコードは存在しない。

**証拠**:

Issueの記載（存在しないコード）:
```typescript
// 空行を除いた最後の15行を検出ウィンドウとして使用
const nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '');
const lastLines = nonEmptyLines.slice(-15).join('\n');

// thinking検出が無条件で優先
if (detectThinking(cliToolId, lastLines)) {
    isProcessing = true;
```

実際のコード（`src/app/api/worktrees/route.ts` L57-60）:
```typescript
const output = await captureSessionOutput(worktree.id, cliToolId, 100);
const statusResult = detectSessionStatus(output, cliToolId);
isWaitingForResponse = statusResult.status === 'waiting';
isProcessing = statusResult.status === 'running';
```

Issue #180 で `route.ts` x2 のインラインロジックは `detectSessionStatus()` 呼び出しに統合済み。

**推奨対応**:
問題の所在を `status-detector.ts` に正しく帰属させるようコードスニペットと説明を修正する。なお、`status-detector.ts` ではプロンプト検出がthinking検出より優先されており（L85-96）、「thinking検出が無条件で上書き」という表現は `status-detector.ts` には当てはまらない。

---

### MF-2: 仮説検証レポートがclaude-poller.tsの存在を誤って否定している

**カテゴリ**: 正確性
**場所**: 仮説検証レポート 仮説5

**問題**:
仮説検証レポート（`hypothesis-verification.md`）の仮説5は「`claude-poller.ts` は存在せず（グローバル検索でヒットせず）」と判定し、**Rejected** としている。しかし、`src/lib/claude-poller.ts` は実際に存在する。

**証拠**:

`src/lib/claude-poller.ts` L76:
```typescript
const thinkingPattern = /[✻✽⏺·∴✢✳]/m;
```

このパターンはスピナー文字の**存在のみ**でマッチし、`…` や `to interrupt)` を必須としない。これは `cli-patterns.ts` の `CLAUDE_THINKING_PATTERN`（`.+…` を必須とする）と比較して著しく緩い。

また以下のファイルから `claude-poller.ts` がインポートされている:
- `src/lib/session-cleanup.ts` L11: `import { stopPolling as stopClaudePolling } from './claude-poller';`
- `src/lib/cli-tools/manager.ts` L11: `import { stopPolling as stopClaudePolling } from '../claude-poller';`

ただし `startPolling()` は外部から呼ばれておらず、`extractClaudeResponse()` 内の `thinkingPattern` による誤検出は到達不能コードパス上にある。

**推奨対応**:
仮説検証レポートの仮説5の判定を **Rejected** から **Confirmed（到達不能コードパス上）** に修正する。IssueのP2指摘は技術的に正しいが、実影響は限定的であることを注記する。

---

### MF-3: ウィンドウ方式の不整合テーブルがstatus-detector.tsの方式を誤記している

**カテゴリ**: 正確性
**場所**: ### レスポンスポーラーとの検出ウィンドウの不整合 テーブル

**問題**:
不整合テーブルで `worktrees/route.ts サイドバー` が「最後15行（非空行のみ）」と記載されているが、実際には `status-detector.ts` 経由で「最後15行（全行、stripAnsi後）」が使用されている。非空行フィルタリングを行うのは `current-output/route.ts` のみ。

**証拠**:

`status-detector.ts` L81-83:
```typescript
const cleanOutput = stripAnsi(output);
const lines = cleanOutput.split('\n');
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
```
ここでは `.filter()` は使用されておらず、空行を含む全行の末尾15行が検査対象。

`current-output/route.ts` L73:
```typescript
const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
```
ここでのみ非空行フィルタリングが行われている。

**推奨対応**:
不整合テーブルを以下のように修正する:

| 検出箇所 | ウィンドウ | 方式 |
|----------|-----------|------|
| `response-poller.ts` | 最後20行（raw行、空行含む） | 応答完了を正しく検出 |
| `status-detector.ts`（サイドバー経由） | 最後15行（全行、stripAnsi後） | thinkingを誤検出する可能性あり |
| `current-output/route.ts` | 最後15行（非空行のみ） | thinkingを誤検出 |

---

## Should Fix（推奨対応）

### SF-1: 受け入れ条件が明示的に記載されていない

**カテゴリ**: 明確性
**場所**: Issue本文全体

**問題**:
Issueには「概要」「再現手順」「原因分析」「問題点の一覧」「改善案」が記載されているが、明示的な**受け入れ条件（Acceptance Criteria）セクション**が存在しない。改善案の実装が成功したことを検証するための基準が不明確。

**推奨対応**:
以下の受け入れ条件を追記する:

1. Claude CLIが応答完了してプロンプト（`>` / `❯`）を表示している場合、サイドバーステータスが `ready`（緑）に遷移すること
2. Claude CLIがthinking中（スピナー表示中）は `running`（スピナー）が表示されること
3. `current-output` API の `isGenerating` フラグが、応答完了後に `false` を返すこと
4. Issue #161 の Auto-Yes 誤検出防止が維持されること（回帰テスト）
5. thinking インジケータ（`Churned for 41s` 等）が完了済み応答に含まれていても、プロンプトが検出されれば `ready` と判定されること

---

### SF-2: P0問題の表現がstatus-detector.tsの実際の優先順位と矛盾

**カテゴリ**: 整合性
**場所**: ## 問題点の一覧 P0行

**問題**:
P0問題の1行目「thinking検出がプロンプト検出を無条件で上書き（プロンプトが見えていてもthinkingが優先）」は、`status-detector.ts` の実装と矛盾する。`status-detector.ts` ではプロンプト検出が最優先（L85-96）であり、thinkingが上書きすることはない。

この問題が該当するのは `current-output/route.ts` L90 のみ:
```typescript
const promptDetection = thinking
    ? { isPrompt: false, cleanContent: cleanOutput }
    : detectPrompt(cleanOutput, promptOptions);
```

**推奨対応**:
P0問題の表現を以下のように修正する:
- 「thinking検出がプロンプト検出を無条件で上書き」 --> 「`current-output/route.ts` でthinking検出時にプロンプト検出が完全にスキップされる」
- ファイル列を `worktrees/route.ts L69-83` --> `current-output/route.ts L83-90` に修正

---

### SF-3: ウィンドウ方式の不整合が3箇所であることの強調不足

**カテゴリ**: 完全性
**場所**: ### レスポンスポーラーとの検出ウィンドウの不整合

**問題**:
不整合テーブルは2箇所（response-poller.ts と worktrees/route.ts + current-output/route.ts）の対比で記述されているが、実際には3箇所（response-poller.ts、status-detector.ts、current-output/route.ts）でウィンドウ方式が異なっている。この3方式の不整合が根本的な問題であり、統一が最優先課題であることが強調されていない。

**推奨対応**:
- テーブルを3行に拡張（MF-3の修正と連動）
- 根本原因分析に「3箇所のウィンドウ方式の統一が本Issueの根本的な解決策である」旨を追記

---

### SF-4: 改善案P2のclaude-poller.ts記述を実態に合わせて修正すべき

**カテゴリ**: 技術的妥当性
**場所**: ## 改善案 P2行

**問題**:
改善案P2は「レガシー `claude-poller.ts` のthinkingパターンを `CLAUDE_THINKING_PATTERN` に統一」としているが、`claude-poller.ts` の `startPolling()` は外部から呼ばれておらず到達不能コードである。パターンを統一するよりも、ファイル全体のlegacy/deprecated化を検討すべき。

**証拠**:
- Issue #180 設計書 DR-008: 「到達不能コードの削除または同様の修正適用を検討すべき」
- Issue #180 設計書 IS-005: 「legacy/deprecated マークのコードコメントを追加し、意図しない有効化を防止することを推奨」
- `claude-poller.ts` 内のTODOコメント: `// TODO [Issue #193]: This code path is unreachable (claude-poller.ts is superseded by response-poller.ts).`

**推奨対応**:
改善案P2を「`claude-poller.ts` を deprecated 化し、`stopPolling()` のみを `response-poller.ts` に移行後、ファイルを削除する」に変更する。

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issueセクションに#180への言及がない

**カテゴリ**: 完全性
**場所**: ## 関連 セクション

**問題**:
関連セクションにIssue #180（ステータス表示の不整合修正）が含まれていない。Issue #180は `worktrees/route.ts` のインラインロジックを `status-detector.ts` に統合した直接の前提であり、本Issueのコードスニペットとの乖離の原因でもある。

**推奨対応**:
関連セクションに以下を追加:
```
- Issue #180（ステータス表示の不整合修正）- worktrees/route.tsのstatus-detector.ts統合
```

---

### NTH-2: auto-yes-manager.tsのthinking検出ウィンドウ（50行）への言及がない

**カテゴリ**: 完全性
**場所**: ## 原因分析 セクション

**問題**:
`auto-yes-manager.ts` の `THINKING_CHECK_LINE_COUNT = 50` もthinking検出に影響する箇所だが、Issueの原因分析では言及されていない。Issue #191で修正済みだが、本Issueの修正（ウィンドウ縮小等）との整合性確認が必要。

**推奨対応**:
影響範囲として `auto-yes-manager.ts` のthinking検出ウィンドウにも言及し、Issue #191との整合性を注記する。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/status-detector.ts` | セッションステータス検出の共通関数。worktrees/route.tsから呼ばれる。L82-83で全行15行ウィンドウ使用 |
| `src/app/api/worktrees/route.ts` | サイドバーステータス検出。L57-60で `detectSessionStatus()` を使用（Issueのコードスニペットと不一致） |
| `src/app/api/worktrees/[id]/route.ts` | 個別worktreeステータス検出。L57-60で `detectSessionStatus()` を使用 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | current-output API。L73で非空行フィルタリング、L83-90でthinking優先ロジック |
| `src/lib/response-poller.ts` | レスポンスポーラー。L235-236でraw行20行ウィンドウ使用 |
| `src/lib/claude-poller.ts` | レガシーポーラー（到達不能コード）。L76で緩いthinkingPattern使用 |
| `src/lib/cli-patterns.ts` | `CLAUDE_THINKING_PATTERN` 定義（L27-30）、`detectThinking()`、`buildDetectPromptOptions()` |
| `src/lib/auto-yes-manager.ts` | Auto-Yesポーリング。`THINKING_CHECK_LINE_COUNT=50` でthinking検出ウィンドウを制御 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | Issue #180のstatus-detector.ts統合、Issue #191のウィンドウイング修正、Issue #161のthinking優先ロジック導入経緯の記載 |
| `dev-reports/design/issue-180-status-display-inconsistency-design-policy.md` | route.ts統合の設計方針、claude-poller.ts到達不能性の分析（DR-008、IS-005） |

---

## 仮説検証レポートへの修正要請

仮説検証レポート（`hypothesis-verification.md`）の以下の修正が必要:

| 仮説 | 現在の判定 | 修正後の判定 | 理由 |
|------|-----------|-------------|------|
| 仮説5 | Rejected | **Confirmed（到達不能コードパス上）** | `claude-poller.ts` は実在する。L76の `thinkingPattern` はスピナー文字のみでマッチする緩いパターン。ただし `startPolling()` は外部から呼ばれておらず実影響は限定的 |
