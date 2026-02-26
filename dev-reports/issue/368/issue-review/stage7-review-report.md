# Issue #368 レビューレポート - Stage 7

**レビュー日**: 2026-02-25
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7/8（影響範囲最終チェック）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

## Stage 3 指摘事項の反映状況

Stage 3で指摘した12件の影響範囲指摘について、全件が適切にIssue本文に反映されていることを確認した。

| 指摘ID | 重要度 | ステータス | 反映内容 |
|--------|--------|-----------|---------|
| F301 | must_fix | 反映済み | switch文対応セクション追加、5箇所の変更内容を表形式で記載 |
| F302 | must_fix | 反映済み | sidebar.ts型変更方針を具体化、Partial<Record>方式を採用 |
| F303 | must_fix | 反映済み | JSONバリデーション関数の実装例と6つの検証観点を追加 |
| F304 | should_fix | 反映済み | 4テストファイルを変更対象に追加 |
| F305 | should_fix | 反映済み | PATCH API統合、トランザクション処理方針を明記 |
| F306 | should_fix | 反映済み | セッション管理の副作用を定義 |
| F307 | should_fix | 反映済み | ALLOWED_CLI_TOOLSの考慮事項4項目を追記 |
| F308 | should_fix | 反映済み | スコープ外として明示、将来リファクタリング候補 |
| F309 | should_fix | 反映済み | ハイフン付きキーのアクセス方法を技術的考慮事項に追記 |
| F310 | nice_to_have | 反映済み | cli_tool_id連動の動的デフォルト値SQL例を追加 |
| F311 | nice_to_have | 反映済み | CLAUDE.md更新をドキュメントカテゴリに追加 |
| F312 | nice_to_have | 反映済み | MessageList.tsx変更対象にDRY共通化検討の注記追加 |

---

## Should Fix（推奨対応）

### F701: db.tsのgetLastMessagesByCliBatch()内SQLクエリにcli_tool_id IN句がハードコード

**カテゴリ**: 影響ファイル
**場所**: `src/lib/db.ts` L143

**問題**:
Issue本文ではF503として`getLastMessagesByCliBatch()`の戻り値型の変更を変更対象に含めているが、同関数内のSQLクエリにハードコードされたIN句が存在する:

```sql
AND cli_tool_id IN ('claude', 'codex', 'gemini')
```

戻り値型を`Record<CLIToolType, string | undefined>`に変更しても、このSQLクエリが更新されなければ、vibe-localのメッセージはクエリ結果から暗黙的に除外される。サイドバーの`lastMessagesByCli`表示にvibe-localの最新メッセージが反映されず、ユーザーにとって「vibe-localでメッセージを送ったのにサイドバーに表示されない」という不具合として顕在化する。

**証拠**:
- `src/lib/db.ts` L143: `AND cli_tool_id IN ('claude', 'codex', 'gemini')` (ハードコード)
- Issue本文の変更対象: 「`src/lib/db.ts` - `getLastMessagesByCliBatch()` 戻り値型を `Record<CLIToolType, string | undefined>` に更新」（型のみ言及、SQL未言及）

**推奨対応**:
変更対象のdb.tsの説明を拡張し、SQL IN句のハードコード解消を明記する。CLI_TOOL_IDSベースの動的プレースホルダ生成が推奨:

```typescript
const toolPlaceholders = CLI_TOOL_IDS.map(() => '?').join(',');
// SQL: AND cli_tool_id IN (${toolPlaceholders})
// パラメータ: [...worktreeIds, ...CLI_TOOL_IDS]
```

---

### F702: api-client.tsの型定義が'claude' | 'codex' | 'gemini'にハードコード

**カテゴリ**: 影響ファイル
**場所**: `src/lib/api-client.ts` L149, L169, L184, L224

**問題**:
api-client.tsの以下4箇所でCLIToolTypeではなくリテラル型ユニオンがハードコードされている:

| 行 | メソッド | 現在の型 |
|----|---------|---------|
| L149 | `updateCliTool()` | `cliToolId: 'claude' \| 'codex' \| 'gemini'` |
| L169 | `getMessages()` | `cliTool?: 'claude' \| 'codex' \| 'gemini'` |
| L184 | `sendMessage()` | `cliToolId?: 'claude' \| 'codex' \| 'gemini'` |
| L224 | `killSession()` | `cliToolId?: 'claude' \| 'codex' \| 'gemini'` |

このファイルはIssueの変更対象ファイル一覧に含まれていない。CLIToolTypeをimportして使用すべきである。

**推奨対応**:
変更対象ファイル一覧の「CLI_TOOL_IDS ハードコード統一」テーブルに追加:

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/api-client.ts` | 4箇所の `'claude' \| 'codex' \| 'gemini'` リテラル型を `CLIToolType` 参照に変更 |

---

### F703: capitalizeFirst()とformatCliToolName()がvibe-localを不正な表示名に変換

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/WorktreeDetailRefactored.tsx` L127, `src/components/worktree/AutoYesToggle.tsx` L42

**問題**:
IssueではMessageList.tsxの`getToolName()`のvibe-local対応（F301, F312）は記載されているが、以下の2つの表示名変換関数は変更対象に含まれていない:

1. **`capitalizeFirst()`** (WorktreeDetailRefactored.tsx L127): ターミナルヘッダーのタブ表示名（L1822, L2106）およびセッション終了確認ダイアログ（L1999, L2226）で使用。`capitalizeFirst('vibe-local')` は `'Vibe-local'` を返す。

2. **`formatCliToolName()`** (AutoYesToggle.tsx L42): Auto-Yes有効時の表示名（L131）およびAutoYesConfirmDialogのツール名表示（L153）で使用。`formatCliToolName('vibe-local')` は `'Vibe-local'` を返す。

期待される表示名は `'Vibe Local'` であるが、両関数とも先頭文字の大文字化のみを行うため、ハイフン後の文字列は変換されない。

**推奨対応**:
CLIToolType -> 表示名の共通マッピング関数を導入する（F312のDRY共通化と連動）:

```typescript
// src/lib/cli-tools/types.ts に追加
const CLI_TOOL_DISPLAY_NAMES: Record<CLIToolType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  'vibe-local': 'Vibe Local',
};
export function getCliToolDisplayName(id: CLIToolType): string {
  return CLI_TOOL_DISPLAY_NAMES[id] ?? id;
}
```

これにより、`getToolName()`、`capitalizeFirst(tool)`、`formatCliToolName(name)` の3箇所を統一でき、DRY原則にも準拠する。

---

## Nice to Have（あれば良い）

### F704: LogViewer.tsxのcliToolFilterがハードコード

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/LogViewer.tsx` L36

**問題**:
LogViewerのcliToolFilterのuseState型が `'all' | 'claude' | 'codex' | 'gemini'` にハードコードされている。vibe-localのログファイルをフィルタリングする選択肢がUIに表示されない。

**推奨対応**:
変更対象ファイル一覧に追加を検討。型を `'all' | CLIToolType` に変更し、フィルタドロップダウンの選択肢をCLI_TOOL_IDSベースで動的生成する。

---

### F705: standard-commands.tsの型アサーションがハードコード

**カテゴリ**: 影響ファイル
**場所**: `src/lib/standard-commands.ts` L304

**問題**:
cliToolsフィルタリングの型アサーション `toolId as 'claude' | 'codex' | 'gemini'` がCLIToolTypeを参照していない。ランタイム動作には影響しないが、型の一貫性が損なわれる。

**推奨対応**:
セクション0のリファクタリング作業で解消するか、grepによるリテラル型の全件洗い出し手順を追記する。

---

## セキュリティ最終チェック

前回のF303（selected_agentsのJSONバリデーション）で指摘したセキュリティリスクは適切に対処されており、パース+バリデーション関数の実装例がIssueに含まれている。今回の最終チェックで新たなセキュリティ上の懸念は特定されなかった。

| 確認項目 | 結果 |
|---------|------|
| selected_agentsのXSSリスク | CLI_TOOL_IDS.includes()によるホワイトリスト検証で対処済み |
| ALLOWED_CLI_TOOLSのバイパスリスク | セキュリティホワイトリスト（Set）による制限が維持される |
| DB INジェクション | プレースホルダ使用で防止（既存パターン踏襲） |
| TOCTOU / Race Condition | selected_agents更新のトランザクション処理方針が明記済み |
| CLIコマンドインジェクション | execFile使用（exec不使用）、ALLOWED_CLI_TOOLSホワイトリストで防止 |

---

## 未発見の波及影響チェック

以下のカテゴリで追加の波及影響を探索した結果:

| チェックカテゴリ | 結果 | 詳細 |
|----------------|------|------|
| grepによるリテラル型洗い出し | 2件新規発見 | api-client.ts (F702), standard-commands.ts (F705) |
| SQL文内のハードコード | 1件新規発見 | db.ts getLastMessagesByCliBatch() IN句 (F701) |
| 表示名変換関数 | 1件新規発見 | capitalizeFirst/formatCliToolName (F703) |
| UIフィルタコンポーネント | 1件新規発見 | LogViewer.tsx cliToolFilter (F704) |
| CLIToolType参照ファイル | 41ファイル確認済み | 変更対象一覧で未カバーの重要ファイルなし（F702, F704除く） |
| テスト破損リスク | 追加なし | F304で特定済みの4ファイルで網羅 |
| i18n影響 | 追加なし | F007で特定済み |
| ドキュメント影響 | 追加なし | F311で特定済み |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/db.ts`: L143 SQL IN句ハードコード（F701）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/api-client.ts`: L149, L169, L184, L224 リテラル型ハードコード（F702）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/components/worktree/WorktreeDetailRefactored.tsx`: L127 capitalizeFirst()（F703）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/components/worktree/AutoYesToggle.tsx`: L42 formatCliToolName()（F703）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/components/worktree/LogViewer.tsx`: L36 cliToolFilter（F704）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/standard-commands.ts`: L304 型アサーション（F705）

### 前回レビュー
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/dev-reports/issue/368/issue-review/stage3-review-result.json`: 影響範囲レビュー1回目
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/dev-reports/issue/368/issue-review/stage5-review-result.json`: 通常レビュー2回目

---

## 総合評価

Issue #368は6回のレビューステージを経て非常に成熟した状態にある。Stage 3の影響範囲指摘12件は全て適切に反映されている。今回の最終影響範囲チェックで特定した5件の新規指摘はいずれもmust_fixレベルではなく、セクション0のリファクタリング作業中にgrep等で自然に発見される可能性が高い。ただし、F701（SQL IN句）は戻り値型変更だけでは解消されない別種の問題であり、変更対象に明記しておくことで実装漏れを確実に防げる。F703（表示名変換）はCLI_TOOL_DISPLAY_NAMESマッピングの導入により、MessageList.tsxのDRY共通化（F312）と併せて統一的に解決できる。

本Issueは実装着手可能な状態にあると評価する。
