# Issue #188 影響範囲レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 影響範囲レビュー (Impact Scope)
**ステージ**: 3 (影響範囲レビュー 1回目)
**前提**: Stage 1 (通常レビュー) の指摘事項は Stage 2 で Issue に反映済み

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

## 影響範囲の全体像

Issue #188 の修正は主に `current-output/route.ts` と `status-detector.ts` のthinking/prompt優先順位ロジックに影響するが、下流のフロントエンドコンポーネントや並行するAuto-Yesポーリングにも波及する。以下に依存関係の流れを示す。

```
detectThinking() [cli-patterns.ts]
    |
    +---> status-detector.ts (prompt最優先: 正しい)
    |         |
    |         +---> worktrees/route.ts  --> sidebar.ts deriveCliStatus()
    |         +---> worktrees/[id]/route.ts --> sidebar.ts deriveCliStatus()
    |
    +---> current-output/route.ts (thinking無条件優先: バグの所在)
    |         |
    |         +---> WorktreeDetail.tsx (isGenerating -> スピナー表示)
    |         +---> useAutoYes.ts (isPromptWaiting -> auto-response)
    |
    +---> auto-yes-manager.ts (thinking -> promptスキップ: Issue #161 Layer 1)
    |
    +---> response-poller.ts (thinkingPattern -> isComplete判定)
    |
    +---> claude-poller.ts (到達不能だが緩いパターン)
```

---

## Must Fix（必須対応）

### MF-1: フロントエンド下流影響の欠落

**カテゴリ**: 影響ファイル
**場所**: ## 改善案 P0行 / ## 受け入れ条件

**問題**:
Issue の改善案は `current-output/route.ts` の修正のみを対象としているが、この API の応答値 (`isGenerating`, `isPromptWaiting`) を消費するフロントエンドコンポーネントへの影響が記載されていない。

P0修正（thinking検出がプロンプト検出を無条件でスキップする問題の解消）により、`current-output` API の以下の応答フィールドの値が変わる:

- `isGenerating` (L116): `thinking` フラグが変わる
- `isPromptWaiting` (L120): thinking中でもpromptが検出されるようになる

**影響を受けるフロントエンド**:

1. **`src/components/worktree/WorktreeDetail.tsx` L180**:
   ```typescript
   if (data.isRunning && data.isGenerating) {
     setWaitingForResponse(true);  // スピナー表示
   } else if (data.isRunning && !data.isGenerating) {
     setWaitingForResponse(false); // スピナー非表示
   }
   ```
   `isGenerating` が `false` になるケースが増えるため、スピナーが正しく非表示になる（期待される修正効果）。

2. **`src/hooks/useAutoYes.ts` L49**:
   ```typescript
   isPromptWaiting,  // current-output APIから伝播
   ```
   thinking中でもプロンプトが検出されるようになった場合、Auto-Yesが発火するタイミングが変わる可能性がある。

**推奨対応**:
改善案セクションに `current-output` API の応答スキーマ変更の下流影響として `WorktreeDetail.tsx` と `useAutoYes.ts` を明記すべき。

---

## Should Fix（推奨対応）

### SF-1: Issue #161 Auto-Yes誤検出防止との整合性設計が不明確

**カテゴリ**: 破壊的変更
**場所**: ## 改善案 P1行

**問題**:
Issue #161 の意図は「thinking中に番号付きリストを multiple_choice プロンプトと誤検出しない」こと。現在の `current-output/route.ts` L89-90 は:

```typescript
const promptDetection = thinking
    ? { isPrompt: false, cleanContent: cleanOutput }
    : detectPrompt(cleanOutput, promptOptions);
```

この `thinking ? skip : detect` の条件分岐を変更する際、**どの条件下で `detectPrompt` をスキップし続けるべきか**の設計判断が Issue に記載されていない。

**推奨対応**:
`status-detector.ts` の L85-107 の優先順位（prompt最優先）を `current-output/route.ts` にも適用すべきことを明示する:

1. thinkingかつプロンプト+セパレータ共存時 --> 「プロンプト優先」(status-detector.ts と同じ)
2. thinkingのみでプロンプトなしの場合 --> 「thinking優先」(Issue #161 維持)

具体的には、`status-detector.ts` の優先順位ロジックを `current-output/route.ts` にも適用し、thinking状態でも先にprompt検出を行い、promptが検出された場合のみ `isGenerating=false, isPromptWaiting=true` とする方式が妥当。

---

### SF-2: テスト計画の具体化不足

**カテゴリ**: テスト範囲
**場所**: ## 受け入れ条件

**問題**:
受け入れ条件に「既存の単体テスト・統合テストが全てパスすること」と記載されているが、**新規に追加すべきテスト**の具体的なファイル名やシナリオが不明。

**推奨対応**:
以下のテストを計画に追加すべき:

| テストファイル | シナリオ | 理由 |
|--------------|---------|------|
| `tests/unit/lib/status-detector.test.ts` (新規) | thinking+prompt共存時にprompt優先 | 現在テストファイルが存在しない |
| `tests/unit/lib/cli-patterns.test.ts` (追加) | detectThinking()のウィンドウ境界テスト(5行未満のバッファ) | 修正でウィンドウサイズを変更する場合の境界値テスト |
| `tests/unit/prompt-detector.test.ts` (追加) | Issue #161回帰テスト: thinking中にnumbered listがmultiple_choiceとして検出されないこと | 既存テストにthinking連携テストなし |
| `tests/integration/current-output-thinking.test.ts` (新規) | thinking/prompt優先順位統合テスト | P0修正の核心テスト |

---

### SF-3: response-poller.ts の影響が Issue の分析から完全に欠落

**カテゴリ**: 依存関係
**場所**: ## 原因分析 / ## 問題点の一覧

**問題**:
`response-poller.ts` の `extractResponse()` は raw行20行ウィンドウ (L236) で `thinkingPattern.test(cleanOutputToCheck)` を実行 (L282)。さらに L353 で応答全体に `thinkingPattern` が含まれていないかチェックする。

```typescript
// L282: ウィンドウ内チェック
const isThinking = thinkingPattern.test(cleanOutputToCheck);

// L289: thinking中は応答完了と判定しない
const isClaudeComplete = ... && !isThinking;

// L353: 応答全文チェック
if (thinkingPattern.test(response)) {
    return { response: '', isComplete: false, lineCount: totalLines };
}
```

**L353 の全文チェック**は、完了済みthinkingサマリー行（例: `Churned for 41s`）が応答テキストに含まれている場合に応答保存を誤ってブロックするリスクがある。これは本 Issue で報告されている「応答完了後もスピナーが表示され続ける」問題と同根の可能性がある。

**推奨対応**:
P1 改善案「ウィンドウ方式の統一」の対象ファイルとして `response-poller.ts` を明示的に追加すべき。特に L353 の全文 `thinkingPattern.test(response)` は、ウィンドウイング済みの最終N行に限定するか、skip pattern として処理すべき。

---

### SF-4: ウィンドウサイズ統一の判断基準が不明確

**カテゴリ**: 移行考慮
**場所**: ## 改善案 P1行

**問題**:
現在5箇所でウィンドウサイズが異なる:

| 箇所 | ウィンドウ | 空行処理 | 対象 |
|------|-----------|---------|------|
| `response-poller.ts` L236 | raw 20行 | 空行含む(末尾トリム済み) | prompt+separator+thinking検出 |
| `status-detector.ts` L50 | 全行 15行 | stripAnsi後、空行含む | prompt+thinking+input prompt検出 |
| `current-output/route.ts` L73-74 | 非空行 15行 | 非空行のみ | thinking検出 |
| `auto-yes-manager.ts` L79 | 全行 50行 | stripAnsi後、空行含む | thinking検出のみ |
| `prompt-detector.ts` L297 | 全行 50行 | 空行含む | multiple_choice検出 |

P1 改善案「ウィンドウ方式の統一」を実行する場合、以下の判断が必要:

1. thinking 検出ウィンドウの統一値は何行か?
2. `auto-yes-manager.ts` の `THINKING_CHECK_LINE_COUNT=50` は Issue #191 で `prompt-detector.ts` の50行スキャン範囲と一致させた設計根拠がある。これを変更するか?
3. `status-detector.ts` の `STATUS_CHECK_LINE_COUNT=15` はprompt検出にも使用されており、thinking検出のみを独立して変更できるか?

**推奨対応**:
P1 改善案に以下の設計判断を追記すべき:
- thinking 検出ウィンドウは **raw行で末尾5行程度** に縮小（Issue の改善案 P0 と一致）
- prompt 検出ウィンドウは **50行を維持**（multiple_choice の検出範囲が必要）
- `status-detector.ts` は prompt/thinking を同一ウィンドウで検出しているため、thinking のみ小ウィンドウにしたい場合はウィンドウを分離する必要がある

---

## Nice to Have（あれば良い）

### NTH-1: CLAUDE.md 更新の必要性

**カテゴリ**: ドキュメント更新
**場所**: Issue 本文全体

**問題**:
CLAUDE.md は各 Issue の主要な変更点を記録しており、thinking/prompt 優先順位の変更は重要な設計変更に該当する。修正完了後に CLAUDE.md への追記が必要だが、Issue に記載がない。

**推奨対応**:
修正完了後、以下を CLAUDE.md に追加:
- Issue #188 の独立セクション
- Issue #180, #191 セクションとの相互参照

---

### NTH-2: sidebar.ts deriveCliStatus() への間接影響の可視化

**カテゴリ**: 影響ファイル
**場所**: ## 改善案

**問題**:
`worktrees/route.ts` と `worktrees/[id]/route.ts` は `detectSessionStatus()` を経由して `isProcessing` / `isWaitingForResponse` を返す。これを `sidebar.ts` の `deriveCliStatus()` が消費してサイドバーのステータスドット表示を決定する。

```typescript
// sidebar.ts L34-36
if (toolStatus.isProcessing) return 'running';
if (toolStatus.isRunning) return 'ready';
```

`status-detector.ts` は既に prompt 最優先の正しい優先順位を持っているため、`worktrees/route.ts` 経由のサイドバー表示は本 Issue のP0修正の影響を**直接は受けない**。ただし、P1 修正でウィンドウサイズを変更する場合は影響する可能性がある。

**推奨対応**:
Issue の影響範囲分析に、この間接パスを依存関係図として記載すると実装者にとって有用。

---

## 影響範囲まとめ

### 直接変更が必要なファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/current-output/route.ts` | P0: thinking/prompt優先順位の修正、thinking検出ウィンドウの縮小 |
| `src/lib/status-detector.ts` | P1(optional): ウィンドウサイズ調整 |

### 間接影響を受けるファイル

| ファイル | 影響内容 |
|---------|---------|
| `src/components/worktree/WorktreeDetail.tsx` | isGenerating値変更によるスピナー表示の変化 |
| `src/hooks/useAutoYes.ts` | isPromptWaiting伝播タイミングの変化 |
| `src/lib/response-poller.ts` | P1ウィンドウ統一対象、L353の全文thinkingチェック |
| `src/lib/auto-yes-manager.ts` | P1ウィンドウ統一時の整合性確認 |
| `src/types/sidebar.ts` | deriveCliStatus()経由の間接影響 |
| `src/app/api/worktrees/route.ts` | detectSessionStatus()経由（既に正しい優先順位） |
| `src/app/api/worktrees/[id]/route.ts` | detectSessionStatus()経由（既に正しい優先順位） |
| `src/lib/claude-poller.ts` | P2: 到達不能コードの整理 |

### 破壊的変更

なし。APIレスポンスフィールド名に変更はなく、値の意味も「正しい状態を反映する」方向への修正のみ。フロントエンドは同一リポジトリ内のため後方互換性の問題はない。

### Issue #161 との整合性

本修正は Issue #161 の Layer 1 防御（thinking中のprompt検出スキップ）を**完全に無効化するのではなく、条件付きで緩和する**必要がある。`status-detector.ts` の既存実装がこの正しいパターンを示している（prompt検出を最優先し、promptが検出されなかった場合のみthinking検出を評価）。この戦略を `current-output/route.ts` にも適用することで、Issue #161 の誤検出防止を維持しつつ本Issue のバグを修正できる。

### Issue #191 との整合性

`auto-yes-manager.ts` の `THINKING_CHECK_LINE_COUNT=50` は、`prompt-detector.ts` の multiple_choice スキャン範囲（50行）と一致させた設計（Issue #191 SF-001）。本 Issue の修正で thinking 検出ウィンドウを縮小する場合、`auto-yes-manager.ts` のウィンドウも同時に調整する必要があるかを検討すべき。ただし `auto-yes-manager.ts` では prompt 検出前の Layer 1 防御として使用しているため、thinking ウィンドウを小さくしても Layer 2（2パス検出方式）と Layer 3（連番検証）が防御するため、安全に縮小可能。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/current-output/route.ts`: P0修正の主要対象
- `src/lib/status-detector.ts`: prompt最優先の参照実装
- `src/lib/auto-yes-manager.ts`: Issue #161 Layer 1防御、Issue #191ウィンドウイング
- `src/lib/response-poller.ts`: Issueに未記載の影響範囲
- `src/components/worktree/WorktreeDetail.tsx`: Issueに未記載のフロントエンド下流影響
- `src/hooks/useAutoYes.ts`: Issueに未記載のフロントエンド下流影響
- `src/lib/cli-patterns.ts`: CLAUDE_THINKING_PATTERN定義、detectThinking()
- `src/lib/claude-poller.ts`: P2対象（到達不能コード）
- `src/types/sidebar.ts`: deriveCliStatus()経由の間接影響

### ドキュメント
- `CLAUDE.md`: Issue #180, #191, #161の設計経緯
- `dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md`: Layer 1防御の設計背景
- `dev-reports/design/issue-191-auto-yes-thinking-windowing-design-policy.md`: THINKING_CHECK_LINE_COUNT=50の設計根拠
- `dev-reports/design/issue-180-status-display-inconsistency-design-policy.md`: status-detector.ts統合の設計方針
