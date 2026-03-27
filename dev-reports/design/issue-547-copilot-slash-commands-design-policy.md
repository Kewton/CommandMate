# 設計方針書: Issue #547 Copilot CLIのデフォルトスラッシュコマンドと選択ウィンドウ対応

## 1. 概要

### 課題
Copilot CLIタブにおいて、デフォルトスラッシュコマンド（`/model`等）が表示されず、`/model`実行時の選択ウィンドウも検出されない。Issue #545で追加されたCopilotパターンはplaceholder状態のままである。

### ゴール
1. Copilot CLIのビルトインスラッシュコマンドをUI上で表示・選択可能にする
2. `/model`等の選択ウィンドウをstatus-detectorで検出し、NavigationButtonsで操作可能にする

---

## 2. アーキテクチャ設計

### 変更対象レイヤー

```
プレゼンテーション層（変更なし）
  └── WorktreeDetailRefactored.tsx  ... NavigationButtons表示（既存ロジックで自動対応）

ビジネスロジック層（主要変更）
  ├── slash-commands.ts            ... ビルトインコマンド定義追加
  ├── command-merger.ts            ... (変更不要: filterCommandsByCliTool既存)
  ├── detection/cli-patterns.ts    ... 選択ウィンドウパターン定義
  ├── detection/status-detector.ts ... Copilot選択リスト検出分岐
  └── response-cleaner.ts          ... COPILOT_SKIP_PATTERNS更新（必要に応じて）

API層（軽微変更）
  └── current-output/route.ts      ... isSelectionListActive条件追加
```

### データフロー

```
[Copilot CLI TUI]
  → tmux capture-pane
  → status-detector.ts (COPILOT_SELECTION_LIST_PATTERN検出)
  → current-output/route.ts (isSelectionListActive=true)
  → WorktreeDetailRefactored.tsx (NavigationButtons表示)
  → special-keys/route.ts (Up/Down/Enter送信)
  → tmux sendKeys
```

---

## 3. 設計判断

### 3-1. デフォルトスラッシュコマンドの定義方法

**採用: アプローチ1 - CLIツール別ビルトインコマンドのハードコード定義**

| アプローチ | メリット | デメリット | 判定 |
|-----------|---------|-----------|------|
| 1. ハードコード定義 | シンプル、即時実装可能、外部ファイル不要 | ツール更新時にコード変更必要 | ✅ 採用 |
| 2. Copilot用ディレクトリ | 拡張性高い | ディレクトリ管理が必要、YAGNI | ❌ |
| 3. 汎用デフォルトコマンド機構 | 将来性 | 過剰設計、YAGNI | ❌ |

**理由**:
- Copilotのビルトインコマンドは少数（`/model`等）で安定しており、頻繁な変更は想定されない
- 他CLIツール（Claude, Codex）も同様の仕組みがないため、汎用機構は不要（YAGNI）
- ファイルベースのロード機構を変更する必要がなく、既存コードへの影響が最小

**実装方針**:
- `slash-commands.ts` に `getCopilotBuiltinCommands(): SlashCommand[]` 関数を追加
- 各コマンドに `cliTools: ['copilot']` を明示的に設定
- `getSlashCommandGroups()` 内の `deduplicateByName()` 呼び出し時にビルトインコマンドを含める
- キャッシュ機構（`commandsCache` / `skillsCache`）に影響を与えない設計
- **[DR2-007]** `command-merger.ts` の `filterCommandsByCliTool()` は既存の `includes()` チェックにより `cliTools: ['copilot']` を正しく処理する。command-merger.tsへの変更は不要

```typescript
// slash-commands.ts に追加
function getCopilotBuiltinCommands(): SlashCommand[] {
  return [
    {
      name: 'model',
      description: 'Switch AI model',
      // category は コマンドの性質に応じて設定する。
      // /model は設定変更系のため standard-config を使用。
      category: 'standard-config',
      cliTools: ['copilot'],
      filePath: '', // ビルトイン（ファイルなし）- [DR2-005] 下記注記参照
      source: 'builtin', // [IA3-003] source counts計算で正しく集計されるよう設定
    },
    // 他のCopilotコマンドがあれば追加
  ];
}
// [DR2-005] filePath空文字列の注意: ビルトインコマンドは filePath: '' を使用する。
// 下流のコード（UIリンク生成等）が空文字列を適切に処理することを実装時に確認すること。
// 問題がある場合は isBuiltin フラグの追加またはセンチネル値 '(builtin)' の使用を検討する。
```

**挿入ポイント**: `getSlashCommandGroups()` の `deduplicateByName()` にビルトインコマンドを skills と同列（第1引数）で渡す。ユーザーコマンドが同名の場合はコマンド優先（既存のdeduplicateByName仕様通り）。

> **[DR2-001] 両分岐でのCopilotビルトイン統合（must_fix）**: `getSlashCommandGroups()` には2つの分岐が存在する: (1) `basePath` あり（ファイルロード分岐）と (2) `basePath` なし（キャッシュ分岐）。**Copilotビルトインコマンドは両方の分岐に含めなければならない。** キャッシュ分岐にのみ含めない場合、デフォルトのMCBDコマンド取得時にCopilotビルトインが欠落する。

```typescript
// basePath分岐（ファイルロード）
const skills = deduplicateByName(
  [...loadedSkills, ...codexLocalSkills, ...codexLocalPrompts, ...getCopilotBuiltinCommands()],
  commands
);

// キャッシュ分岐（basePath なし）
const skills = deduplicateByName(
  [...skillsCache, ...getCopilotBuiltinCommands()],
  commandsCache
);
```

> **[DR2-001] 既知の非対称性**: キャッシュ分岐にはCodex skills/promptsが含まれていない既存の非対称性がある。これは本Issueのスコープ外であるが、将来的に[DR1-006]の集約関数導入時に統一を検討する。

> **[DR2-002] deduplicateByName()のパラメータ位置と優先度**: `deduplicateByName(skills, commands)` は第1引数（skills）が低優先、第2引数（commands）が高優先（同名時に上書き）。Copilotビルトインは第1引数（skills配列）に含めることで、ユーザー定義コマンドが同名の場合に自動的にオーバーライドされる。上記コード例の通り、`getCopilotBuiltinCommands()` は常に第1引数側の配列に展開すること。

> **[DR1-006] 将来の分離検討**: `getSlashCommandGroups()` のソース数が増加している（commandsCache / skillsCache / Codex skills / Codex prompts / Copilotビルトインの5ソース）。将来的に `getAllCommandSources(): SlashCommand[][]` のような集約関数への分離を検討する。現時点では5ソース以内のため、即時のリファクタリングは不要（YAGNI）。

### 3-2. 選択ウィンドウ検出アプローチ

**採用: Claude方式（フッターパターンマッチ）を基本とし、調査結果に応じて判断**

Copilot CLI（`gh copilot`）はGitHub Copilotの拡張であり、TUIレイアウトは以下の特性を持つと推定：
- OpenCodeのような複雑なTUI構造（パディング150行等）ではない
- Claudeに近いシンプルなターミナルベースの入出力

**検出パターン定義**:

```typescript
// cli-patterns.ts に追加
export const COPILOT_SELECTION_LIST_PATTERN = /..../m;  // 調査結果に基づき定義
```

**判定**:
- Copilot CLIの実際のTUI出力を `tmux capture-pane` で確認後、パターンを確定
- OpenCode方式（TUIレイアウト解析 + ヘッダーマッチ）が必要な場合は、status-detector.ts にCopilot専用ブランチを追加

### 3-3. status-detector.ts での検出位置

**採用: Claude選択リスト検出（Step 1.5）の直後に配置**

```
Priority order:
1.  Interactive prompt (y/n) → waiting
1.5 Claude selection list → waiting
1.6 Copilot selection list → waiting  ← NEW (cliToolId === 'copilot' guard required)
2.  Thinking indicator → running
...
```

**理由**:
- Copilot CLIはOpenCodeのような複雑なTUIレイアウトを持たない想定
- Claudeと同様のシンプルなパターンマッチで十分
- 2.5（OpenCode特殊処理）のような全行スキャンは不要と想定

> **[DR2-004] cliToolIdガード条件の必須化**: Step 1.6では、Step 1.5（Claude）と同様に `cliToolId === 'copilot'` ガード条件を必ず含めること。ガードなしの場合、`COPILOT_SELECTION_LIST_PATTERN` が他CLIツールの出力に誤マッチする可能性がある（特にパターンがplaceholder段階では広範にマッチするリスクが高い）。

```typescript
// Step 1.6: Copilot selection list detection
if (cliToolId === 'copilot' && COPILOT_SELECTION_LIST_PATTERN.test(lastLines)) {
  return { status: 'waiting', reason: STATUS_REASON.COPILOT_SELECTION_LIST };
}
```

> **[DR1-001] DRYに関するトレードオフ**: Step 1.5（Claude）と Step 1.6（Copilot）は同一構造のif文が並ぶ形となる。現時点では2ツール（Claude + Copilot）のみであり、YAGNI観点から許容する。**3ツール目の選択リスト検出追加時には、`cli-patterns.ts` に `getSelectionListPattern(cliToolId): RegExp | undefined` 関数を導入し、パターンマッピング方式（`Record<CLIToolType, RegExp | undefined>`）へ移行することを検討する。**

> **[DR1-007] 既存依存の明記**: `status-detector.ts` の `promptInput` 条件分岐には `cliToolId === 'copilot'` が Issue #545 で追加済みであり、本Issueでの変更は不要。

### 3-4. STATUS_REASON定数追加

```typescript
// status-detector.ts の STATUS_REASON に追加
COPILOT_SELECTION_LIST: 'copilot_selection_list',
```

### 3-5. current-output/route.ts の更新

> **[DR1-004] SELECTION_LIST_REASONS Set定数の導入（must_fix）**: OR条件の増殖を防ぐため、`Set` 型の定数を導入する。新ツール追加時はSet定義に1行追加するだけで済む。

```typescript
// status-detector.ts に定義（STATUS_REASONと同一ファイルに配置し、凝集度を維持する）
export const SELECTION_LIST_REASONS = new Set<string>([
  STATUS_REASON.OPENCODE_SELECTION_LIST,
  STATUS_REASON.CLAUDE_SELECTION_LIST,
  STATUS_REASON.COPILOT_SELECTION_LIST,
]);

// current-output/route.ts での使用
const isSelectionListActive = statusResult.status === 'waiting'
  && SELECTION_LIST_REASONS.has(statusResult.reason);
```

**従来のOR条件チェーン方式は採用しない。** 将来のツール追加時にOR条件が増殖するリスクを排除するため、Set定数で管理する。

> **[IA3-001] アトミック実装の要求（must_fix）**: `SELECTION_LIST_REASONS` Set定数の定義（上記）と `current-output/route.ts` の既存OR条件（`statusResult.reason === 'opencode_selection_list' || statusResult.reason === 'claude_selection_list'`）の `SELECTION_LIST_REASONS.has()` への置換は、**必ず同一コミットで実施すること**。Set定数のみ追加してOR条件が残る中間状態は許容しない。

> **[DR2-003] Set型の明示**: `SELECTION_LIST_REASONS` は `Set<string>` として型注釈する。`StatusDetectionResult.reason` が `string` 型であるため、リテラル型のSetにすると `Set.has()` 呼び出し時に型の不一致が生じる。`as const` アサーションはSet constructorの引数には不要であり、混乱を避けるため使用しない。

> **[DR2-006] 配置場所の確定**: `SELECTION_LIST_REASONS` は `status-detector.ts` に配置する。`STATUS_REASON` と同一ファイルに配置することで凝集度を維持し、循環依存を回避する。

---

## 4. パターン設計（placeholder → 実パターン）

### 更新対象パターン

| パターン定数 | 現状（placeholder） | 更新方針 |
|-------------|-------------------|---------|
| `COPILOT_PROMPT_PATTERN` | `/^[>❯]\s*$\|^\?\s+/m` | 調査結果に基づき確認・更新 |
| `COPILOT_THINKING_PATTERN` | `/[\u2800-\u28FF]\|Thinking\|Generating\|Processing/` | 調査結果に基づき確認・更新 |
| `COPILOT_SEPARATOR_PATTERN` | `/^─{10,}$/m` | 調査結果に基づき確認・更新 |
| `COPILOT_SKIP_PATTERNS` | `[PASTED_TEXT_PATTERN]` | 選択リスト関連パターン追加（必要に応じて） |
| `COPILOT_SELECTION_LIST_PATTERN` | **未定義** | **新規追加** |

### 新規パターン

```typescript
// 調査結果に基づき定義（以下は想定例）
export const COPILOT_SELECTION_LIST_PATTERN = /..../m;
```

---

## 5. テスト設計

### 新規テストファイル・ケース

| テストファイル | テストケース |
|-------------|------------|
| `tests/unit/cli-patterns-selection.test.ts` | Copilot選択リストパターンのマッチング（正例・負例） |
| `tests/unit/status-detector-selection.test.ts` | Copilot選択リスト検出 → `waiting` + `COPILOT_SELECTION_LIST` |
| `tests/unit/status-detector-selection.test.ts` | **[IA3-004]** `cliToolId='claude'` でCopilotパターン入力時に `copilot_selection_list` にならない負例テスト |
| `tests/unit/status-detector-selection.test.ts` | **[IA3-004]** `STATUS_REASON.COPILOT_SELECTION_LIST` 定数の存在確認テスト |
| `tests/unit/lib/slash-commands.test.ts` | `getCopilotBuiltinCommands()` の返却値検証 |
| `tests/unit/lib/slash-commands.test.ts` | Copilotビルトインコマンドの `cliTools: ['copilot']` 検証 |
| `tests/unit/lib/slash-commands.test.ts` | `getSlashCommandGroups()` にCopilotビルトインが含まれる |

### 既存テストへの影響確認

| テストファイル | 確認事項 |
|-------------|---------|
| `tests/unit/cli-patterns-selection.test.ts` | 既存OpenCode/Claudeテストが影響を受けないこと |
| `tests/unit/status-detector-selection.test.ts` | 既存OpenCode/Claudeテストが影響を受けないこと |
| `tests/unit/lib/command-merger.test.ts` | `filterCommandsByCliTool()` でCopilotコマンドが正しくフィルタされること |

---

## 6. セキュリティ設計

### 入力バリデーション
- ビルトインコマンド定義はハードコードであり、外部入力を受け付けない（XSS/インジェクションリスクなし）
- 正規表現パターンはグローバルフラグ（`/g`）を使用しない（`test()`のステートフル問題回避、S4-5原則準拠）

### パターン安全性
- 新規パターンはReDoS脆弱性がないことを確認（ネストした量指定子を避ける）
- `stripAnsi()` 処理済みの文字列に対してパターンマッチを行う（既存パターンと同一の前処理チェーン）

### [SEC4-001] COPILOT_THINKING_PATTERN のReDoS安全性検証要件
- 現状の placeholder パターン `/[\u2800-\u28FF]|Thinking|Generating|Processing/` はネストした量指定子がなくReDoSリスクは低い
- **パターンを placeholder から実パターンに更新する際、以下を必ず確認すること**:
  1. ネストした量指定子（例: `(a+)+`, `(a|b)*c*`）を使用していないこと
  2. 交代パターンのブランチが互いに重複しないこと
  3. 可能であれば safe-regex または redos-detector 等のツールで検証すること

### [SEC4-002] COPILOT_PROMPT_PATTERN のアンカー保持要件
- 現状の `/^[>❯]\s*$|^\?\s+/m` は行頭アンカー `^` があるためバックトラッキングが制限され安全
- **パターン更新時に `^` アンカーが維持されていることを必ず確認すること**
- アンカーなしで `\s+` を使用する場合はReDoSリスクが上昇する

### [SEC4-008] cliToolIdガード条件の信頼境界としての重要性
- [DR2-004] の `cliToolId === 'copilot'` ガード条件は、単なるフィルタリングではなくクロスツール安全性のための**信頼境界**である
- ガードなしでは `COPILOT_SELECTION_LIST_PATTERN` が placeholder 段階で他ツールの出力に広範にマッチし、以下のリスクがある:
  - ユーザーの意図しない NavigationButtons 表示
  - wait コマンドの早期終了
- **実装時に必ず確認すべき事項**:
  1. `cliToolId === 'copilot'` ガードが Step 1.6 の条件に含まれていること
  2. [IA3-004] の負例テスト（`cliToolId='claude'` で Copilot パターン入力時に誤検出しないこと）が実装されていること

### [SEC4-003] 新規パターン定義時のセキュリティチェックリスト
- `COPILOT_SELECTION_LIST_PATTERN` 等の新規パターン確定時に以下を確認すること:
  - [ ] `/g` フラグ未使用（S4-5原則）
  - [ ] ネストした量指定子なし
  - [ ] `stripAnsi()` 前処理確認
  - [ ] `cliToolId` ガード条件付き

### [SEC4-004] コマンド送信経路の安全性（確認済み）
- `CopilotTool.startSession()` の `sendKeys(sessionName, 'gh copilot', true)` はハードコード文字列であり安全
- 将来的にコマンドオプションを動的に構築する場合は、ホワイトリスト方式でオプションを制限すること

### [SEC4-006] ビルトインコマンド定義の外部化時の注意
- 現状のハードコード定義は XSS リスクなし
- 将来ビルトインコマンドの定義を外部ファイルに移行する場合は、`safeParseFrontmatter()` と同等の保護を適用すること

---

## 7. 実装順序

1. **TUI調査**: Copilot CLIの実際のTUI出力を `tmux capture-pane` で確認
   > **[DR1-003] TUI調査の完了基準**:
   > - (a) `tmux capture-pane` で少なくとも3つの状態（アイドル、処理中、選択ウィンドウ表示中）のスナップショットを取得すること
   > - (b) 各パターンが正例に一致し負例に一致しないことをテストで確認すること
   > - (c) パターンが確定できない場合は placeholder のまま残し、Issue本文にその旨を記録すること
2. **cli-patterns.ts**: パターン定義（placeholder更新 + COPILOT_SELECTION_LIST_PATTERN新規追加）
3. **slash-commands.ts**: `getCopilotBuiltinCommands()` 追加、`getSlashCommandGroups()` 統合
4. **status-detector.ts**: STATUS_REASON追加、検出分岐追加
5. **current-output/route.ts**: isSelectionListActive条件追加
6. **response-cleaner.ts**: COPILOT_SKIP_PATTERNS更新（必要に応じて）
7. **テスト**: 全新規パターン・ロジックのテスト追加
8. **既存テスト確認**: 回帰テスト実行

---

## 8. 設計上のトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| ビルトインコマンドのハードコード | YAGNI、最小影響 | Copilot更新時にコード変更が必要 |
| Claude方式の検出アプローチ | シンプル、Copilot CLIの特性に合致 | 複雑なTUIの場合はOpenCode方式への変更が必要 |
| Step 1.6への配置 | 既存優先順序に最小影響で挿入 | Copilot固有の複雑な検出が必要な場合はステップ追加 |
| placeholderパターンの段階的更新 | 調査結果に基づく確実な更新 | 調査フェーズが必要 |

---

## 9. 制約条件

- CLAUDE.mdの原則に準拠（SOLID, KISS, YAGNI, DRY）
- 既存6ツール（Claude, Codex, Gemini, OpenCode, Vibe-Local, Copilot）の動作に影響を与えない
- D1-003原則: 7ツール目追加時にレジストリパターンへの移行を検討（現状6ツールのため対象外）
- `/g` フラグ禁止（S4-5原則）

---

## 10. レビュー指摘事項サマリ（Stage 1: 通常レビュー）

以下はStage 1設計レビューの指摘事項と、本設計方針書への反映状況である。

| ID | 重要度 | 原則 | タイトル | 反映箇所 |
|----|--------|------|---------|---------|
| DR1-004 | must_fix | DRY | `isSelectionListActive` のOR条件増殖 → `SELECTION_LIST_REASONS` Set定数導入 | Section 3-5 |
| DR1-001 | should_fix | DRY | Claude/Copilot選択リスト検出のコピーペースト懸念 → 3ツール目でパターンマッピング移行 | Section 3-3 |
| DR1-003 | should_fix | KISS | TUI調査の完了判定基準なし → 3条件の完了基準を追加 | Section 7 Step 1 |
| DR1-006 | should_fix | SOLID | `getSlashCommandGroups()` のソース数増加 → 将来の分離検討を記載 | Section 3-1 |
| DR1-002 | nice_to_have | SOLID | switch文拡張とOCP → D1-003原則で既にカバー（追加対応なし） | - |
| DR1-005 | nice_to_have | YAGNI | category設定の判断根拠 → コード例にコメント追記 | Section 3-1 |
| DR1-007 | nice_to_have | DRY | promptInput既存条件の設計書記載漏れ → 依存関係を明記 | Section 3-3 |

### 実装チェックリスト（レビュー指摘に基づく追加事項）

- [ ] **[DR1-004]** `SELECTION_LIST_REASONS` Set定数を定義し、`isSelectionListActive` の判定に使用する
- [ ] **[DR1-004]** 既存のOpenCode/Claudeの選択リスト判定もSet定数経由に統一する
- [ ] **[DR1-001]** 3ツール目の選択リスト検出追加時にパターンマッピング方式への移行を検討する（本Issue時点では不要）
- [ ] **[DR1-003]** TUI調査時に3状態（アイドル/処理中/選択ウィンドウ）のスナップショットを取得する
- [ ] **[DR1-003]** パターン確定できない場合はplaceholderのままIssue本文に記録する
- [ ] **[DR1-006]** `getSlashCommandGroups()` のソース数が6以上になる場合は集約関数への分離を実施する

---

## 11. レビュー指摘事項サマリ（Stage 2: 整合性レビュー）

以下はStage 2整合性レビューの指摘事項と、本設計方針書への反映状況である。

| ID | 重要度 | タイトル | 反映箇所 |
|----|--------|---------|---------|
| DR2-001 | must_fix | `getSlashCommandGroups()` の両分岐でCopilotビルトインを含める必要 | Section 3-1 |
| DR2-002 | should_fix | `deduplicateByName()` のパラメータ位置と優先度の明示 | Section 3-1 |
| DR2-003 | should_fix | `SELECTION_LIST_REASONS` は `Set<string>` 型、`as const` 不要 | Section 3-5 |
| DR2-004 | should_fix | Step 1.6に `cliToolId === 'copilot'` ガード条件を明記 | Section 3-3 |
| DR2-005 | nice_to_have | `filePath: ''` の下流コード影響確認 | Section 3-1 |
| DR2-006 | nice_to_have | `SELECTION_LIST_REASONS` の配置場所を `status-detector.ts` に確定 | Section 3-5 |
| DR2-007 | nice_to_have | `filterCommandsByCliTool()` の既存動作確認（変更不要） | Section 3-1 |

### 実装チェックリスト（Stage 2 レビュー指摘に基づく追加事項）

- [ ] **[DR2-001]** `getSlashCommandGroups()` のbasePath分岐とキャッシュ分岐の両方に `getCopilotBuiltinCommands()` を含める
- [ ] **[DR2-002]** `deduplicateByName()` の第1引数（skills側）に `getCopilotBuiltinCommands()` を展開する
- [ ] **[DR2-003]** `SELECTION_LIST_REASONS` を `new Set<string>([...])` で定義する（`as const` を使用しない）
- [ ] **[DR2-004]** Step 1.6のCopilot選択リスト検出に `cliToolId === 'copilot'` ガード条件を含める
- [ ] **[DR2-005]** ビルトインコマンドの `filePath: ''` が下流コード（UI表示等）で問題ないことを確認する
- [ ] **[DR2-006]** `SELECTION_LIST_REASONS` を `status-detector.ts` に配置する
- [ ] **[DR2-007]** `filterCommandsByCliTool()` が `cliTools: ['copilot']` を正しくフィルタすることをテストで確認する

---

## 12. レビュー指摘事項サマリ（Stage 3: 影響分析レビュー）

以下はStage 3影響分析レビューの指摘事項と、本設計方針書への反映状況である。

| ID | 重要度 | カテゴリ | タイトル | 反映箇所 |
|----|--------|---------|---------|---------|
| IA3-001 | must_fix | 影響範囲 | SELECTION_LIST_REASONS Set導入とOR条件置換を同一コミットで実施する必要性 | Section 3-5, 実装チェックリスト |
| IA3-002 | should_fix | 影響範囲 | CLI waitコマンドが `copilot_selection_list` reason での `waiting` ステータスを想定していない | Section 12 注記, 実装チェックリスト |
| IA3-003 | should_fix | 影響範囲 | `getCopilotBuiltinCommands()` の返却値に `source` フィールドが未設定 | Section 3-1, 実装チェックリスト |
| IA3-004 | should_fix | テストカバレッジ | cliToolIdガード条件の負例テストが未記載 | Section 5, 実装チェックリスト |
| IA3-005 | nice_to_have | 影響範囲 | response-poller.ts のCopilot完了判定への波及（パターン更新時に同時確認） | - |
| IA3-006 | nice_to_have | 影響範囲 | COPILOT_THINKING_PATTERN の広範マッチリスク（cliToolIdガードで緩和済み） | - |
| IA3-007 | nice_to_have | 影響範囲 | WorktreeDetailRefactored.tsx のフロントエンド変更不要の確認 | - |

### IA3-001: SELECTION_LIST_REASONS Set導入とOR条件置換のアトミック実装

> **[IA3-001] 実装順序の厳格化（must_fix）**: Section 3-5 の `SELECTION_LIST_REASONS` Set定数の導入と、`current-output/route.ts` における既存OR条件チェーン（L108-110）の `Set.has()` への置換は、**必ず同一コミットで実施すること**。Set定数を定義したのにroute.tsで旧OR条件が残る不整合を防ぐため、以下の2ステップを1コミットに含める:
>
> 1. `status-detector.ts` に `SELECTION_LIST_REASONS` Set定数を追加（`COPILOT_SELECTION_LIST` を含む）
> 2. `current-output/route.ts` のL108-110のOR条件を `SELECTION_LIST_REASONS.has(statusResult.reason)` に置換（旧OR条件は完全に削除）

### IA3-002: CLI waitコマンドのcopilot_selection_list対応

> **[IA3-002] CLI waitコマンドの挙動確認（should_fix）**: `src/cli/commands/wait.ts` は `sessionStatus === 'waiting'` で待機完了判定を行う。新たに `copilot_selection_list` reason で `waiting` が返される場合、CLI waitがプロンプト待ちとして検出する可能性がある。`--on-prompt` オプションの挙動を確認し、selection_list系reasonでの `waiting` ステータスが適切にハンドリングされているか検証すること。必要に応じてドキュメントまたはテストを追加する。

### IA3-003: ビルトインコマンドのsourceフィールド設定

> **[IA3-003] sourceフィールドの追加（should_fix）**: `getCopilotBuiltinCommands()` が返す `SlashCommand` には `source` フィールドが設定されていない。slash-commands APIルートの source counts 計算（`/api/worktrees/[id]/slash-commands/route.ts` L120-128）で、ビルトインコマンドがどのカウントにも含まれなくなる。ビルトインコマンドに `source: 'builtin'` を設定し、source counts計算にbuiltinカテゴリを追加するか、既存の `'standard'` に含めるかを判断すること。

### IA3-004: cliToolIdガード条件の負例テスト追加

> **[IA3-004] テスト設計の補強（should_fix）**: Section 5のテスト設計に以下の負例テストを追加する:
>
> - `cliToolId='claude'` で `COPILOT_SELECTION_LIST_PATTERN` にマッチする出力を与えた場合に `copilot_selection_list` にならないことの確認（ガード条件テスト）
> - `STATUS_REASON` constants テストに `COPILOT_SELECTION_LIST` を追加

### 実装チェックリスト（Stage 3 レビュー指摘に基づく追加事項）

- [ ] **[IA3-001]** `SELECTION_LIST_REASONS` Set定数の追加と `current-output/route.ts` のOR条件置換を**同一コミット**で実施する
- [ ] **[IA3-001]** 置換後、旧OR条件（`statusResult.reason === 'opencode_selection_list' || statusResult.reason === 'claude_selection_list'`）が完全に削除されていることを確認する
- [ ] **[IA3-002]** CLI waitコマンドの `--on-prompt` オプションが `copilot_selection_list` reason での `waiting` ステータスを適切に処理するか検証する
- [ ] **[IA3-002]** 必要に応じて wait コマンドのドキュメントまたはテストを追加する
- [ ] **[IA3-003]** `getCopilotBuiltinCommands()` の返却値に `source` フィールド（`'builtin'` 等）を設定する
- [ ] **[IA3-003]** slash-commands APIルートの source counts にビルトインカテゴリを追加するか判断する
- [ ] **[IA3-004]** `tests/unit/status-detector-selection.test.ts` に `cliToolId !== 'copilot'` の負例テストを追加する
- [ ] **[IA3-004]** `STATUS_REASON` constants テストに `COPILOT_SELECTION_LIST` の存在確認テストを追加する
- [ ] **[IA3-005]** パターン更新（placeholder→実パターン）時に `response-poller.ts` の完了判定テストも同時に確認する（nice_to_have）

---

## 13. レビュー指摘事項サマリ（Stage 4: セキュリティレビュー）

以下はStage 4セキュリティレビューの指摘事項と、本設計方針書への反映状況である。

| ID | 重要度 | カテゴリ | タイトル | 反映箇所 |
|----|--------|---------|---------|---------|
| SEC4-001 | should_fix | ReDoS | COPILOT_THINKING_PATTERN のブレイルレンジ + 交代パターンのReDoS安全性検証要件 | Section 6 |
| SEC4-002 | should_fix | ReDoS | COPILOT_PROMPT_PATTERN のアンカー保持要件 | Section 6 |
| SEC4-003 | nice_to_have | パターン安全性 | COPILOT_SELECTION_LIST_PATTERN 未定義パターンのセキュリティチェックリスト | Section 6 |
| SEC4-004 | nice_to_have | コマンドインジェクション | CopilotTool.startSession の `gh copilot` コマンド送信経路の安全性確認（安全） | Section 6 |
| SEC4-005 | nice_to_have | コマンドインジェクション | sendMessage() の tmux send-keys 経由メッセージ送信の安全性確認（既存パターンと同一、対応不要） | - |
| SEC4-006 | nice_to_have | XSS | ビルトインコマンドのハードコード定義によるXSSリスク排除確認（安全、外部化時の注意を追記） | Section 6 |
| SEC4-007 | nice_to_have | パターン安全性 | ANSI_PATTERN の /g フラグは replace() 専用であり S4-5 に抵触しない（対応不要） | - |
| SEC4-008 | should_fix | 信頼境界 | cliToolIdガード条件がクロスツール安全性の信頼境界として重要 | Section 6 |
| SEC4-009 | nice_to_have | stripAnsi前処理 | Copilotパターンマッチ前のstripAnsi()適用の一貫性確認（対応不要） | - |

### 実装チェックリスト（Stage 4 レビュー指摘に基づく追加事項）

- [ ] **[SEC4-001]** COPILOT_THINKING_PATTERN を placeholder から実パターンに更新する際、ネストした量指定子がないこと・交代ブランチが重複しないことを確認する
- [ ] **[SEC4-001]** 可能であれば safe-regex または redos-detector でパターンのReDoS安全性を検証する
- [ ] **[SEC4-002]** COPILOT_PROMPT_PATTERN を更新する際、行頭アンカー `^` が維持されていることを確認する
- [ ] **[SEC4-008]** Step 1.6 の Copilot 選択リスト検出に `cliToolId === 'copilot'` ガード条件が含まれていることを実装時に確認する（[DR2-004] と連動）
- [ ] **[SEC4-008]** [IA3-004] の負例テスト（`cliToolId='claude'` で Copilot パターン入力時に誤検出しないこと）が実装されていることを確認する
- [ ] **[SEC4-003]** 新規パターン確定時にセキュリティチェックリスト（/g未使用、ネスト量指定子なし、stripAnsi前処理、cliToolIdガード）を実施する

---

*Generated by /design-policy command for Issue #547*
*Date: 2026-03-27*
*Stage 1 review applied: 2026-03-27*
*Stage 2 review applied: 2026-03-27*
*Stage 3 review applied: 2026-03-27*
*Stage 4 review applied: 2026-03-27*
