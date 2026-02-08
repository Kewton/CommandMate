# Issue #193 レビューレポート（Stage 5: 通常レビュー 2回目）

**レビュー日**: 2026-02-08
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 2回目（Stage 1指摘事項のStage 2/4反映後）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

**総合評価**: Stage 1で指摘した3件のMust Fix（MF-1: CLAUDE_CHOICE_INDICATOR_PATTERN参照誤り、MF-2: Layer 4欠落、MF-3: response-poller.tsデータフロー不正確）は全て適切に修正されている。Stage 3で指摘された影響範囲の追加（間接影響テーブル、テスト影響範囲テーブル、ドキュメント影響範囲テーブル、既存テスト修正方針）も反映済み。Issueの品質は大幅に向上しており、残りの指摘は軽微な行番号不一致と説明の精度改善のみ。

---

## 前回指摘事項の反映確認

### Stage 1 Must Fix（3件 -> 全て解決）

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| MF-1 | CLAUDE_CHOICE_INDICATOR_PATTERNはコードベースに存在しない | **解決済み** - 全参照を削除し、DEFAULT_OPTION_PATTERN/NORMAL_OPTION_PATTERNへの正確な参照に置換。注記も追加 |
| MF-2 | Layer 4 (hasDefaultIndicator) が根本原因分析から欠落 | **解決済み** - 処理フローにLayer 4を明記。Pass 1とLayer 4の独立ゲート構造を説明。ケースBのDetectPromptOptionsにrequireDefaultIndicatorの両方への適用をJSDocで明記 |
| MF-3 | response-poller.tsのANSI未ストリップ問題の記述が不正確 | **解決済み** - L248のClaude専用ガード（stripAnsi適用済み）、L442到達条件の正確なデータフロー分析を記載。コードベースと照合し一致を確認 |

### Stage 1 Should Fix（4件 -> 全て解決）

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| SF-1 | DetectPromptOptionsの設計でrequireDefaultIndicatorの責務が曖昧 | **解決済み** - TypeScript interface定義にJSDocコメントを追加。Pass 1とLayer 4の両方に適用されることを明記 |
| SF-2 | claude-poller.ts L164/L232を本Issue対象にすべき | **解決済み** - 変更対象ファイルテーブルに昇格。到達不能コードであること、Issue #180との整合性、将来的な廃止検討を明記 |
| SF-3 | 受入条件にリグレッションテスト要件が不足 | **解決済み** - 受入条件に「全multiple_choiceテストケースのパス確認」「新規リグレッションテスト追加」を追加 |
| SF-4 | current-output/route.tsのthinkingガード内でのoptions伝搬方法が未記載 | **解決済み** - cliToolIdの取得元を記載（ただし行番号に軽微な不一致あり、SF-NEW-1で指摘） |

### Stage 1 Nice to Have（3件 -> 全て解決）

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| NTH-1 | respond/route.tsの動作確認目的が不明確 | **解決済み** - detectPrompt()への直接依存がない間接フローの確認であることを明記 |
| NTH-2 | スクリーンショットのテキスト形式がIssue本文に未記載 | **解決済み** - Phase 1の調査項目にテキスト形式の正確な記録を追加 |
| NTH-3 | ケースBでのIssue #161多層防御との整合性説明が薄い | **解決済み** - Layer 1/Layer 3の維持、thinking状態チェックと連番検証による区別戦略を明記 |

### Stage 3指摘事項の反映確認

| ID | 指摘内容 | 反映状況 |
|----|---------|---------|
| MF-1 | status-detector.ts経由の間接依存が影響範囲に未記載 | **解決済み** - 間接影響テーブルにworktrees/route.ts L58、worktrees/[id]/route.ts L58を追加。L58はコードベースと一致を確認 |
| MF-2 | 既存テストの修正方針が不明確 | **解決済み** - 既存テストファイル更新テーブルに具体的な修正方針カラムを追加 |
| SF-1 | claude-poller.tsの到達不能コード記載がない | **解決済み** - 呼び出し箇所リストと変更対象ファイルテーブルに到達不能コードの旨を明記 |
| SF-2 | auto-yes-resolver.test.tsのテスト影響範囲への追加 | **解決済み** - テスト影響範囲テーブルと既存テストファイル更新テーブルに追加 |
| SF-3 | integration testファイルのテスト影響範囲への追加 | **部分的に解決** - テーブルに追加されたが、detectPromptモック使用の記述が不正確（SF-NEW-2で指摘） |
| SF-4 | CLAUDE.mdをドキュメント影響範囲に追加 | **解決済み** - 変更対象ファイルテーブルとドキュメント影響範囲テーブルの両方に追加 |
| NTH-1 | UIコンポーネントの間接影響 | **解決済み** - PromptPanel/MobilePromptSheet/PromptMessageを間接影響テーブルに追加 |
| NTH-2 | Codex/Geminiへの影響分析 | **解決済み** - response-poller.ts L442の全CLIツール共通パスでのcliToolIdベースoptions構築を明記 |
| NTH-3 | PROMPT_HANDLING_IMPLEMENTATION_PLAN.mdのフォローアップ | **解決済み** - ドキュメント影響範囲テーブルにフォローアップ対象として記載 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### SF-NEW-1: current-output/route.tsのcliToolId取得行番号の不一致

**カテゴリ**: 正確性
**場所**: 対策案 > Phase 3 > current-output/route.ts / 影響範囲 > 変更対象ファイル

**問題**:
Issueでは「cliToolIdはL66付近でworktree.cliToolIdから取得済み」と記載しているが、実際のコードではL40で決定されている。

**証拠**:
```typescript
// src/app/api/worktrees/[id]/current-output/route.ts L40
const cliToolId: CLIToolType = isCliTool(cliToolParam) ? cliToolParam : (worktree.cliToolId || 'claude');
```

**推奨対応**:
「L66付近で」を「L40で」に修正する。または行番号を削除して「cliToolIdはクエリパラメータまたはworktree.cliToolIdから取得済み」のように動的な行番号に依存しない記述に変更する。

---

#### SF-NEW-2: integration testファイルのdetectPromptモック使用記述の不正確

**カテゴリ**: 完全性
**場所**: 影響範囲 > テスト影響範囲

**問題**:
テスト影響範囲テーブルに`tests/integration/api-prompt-handling.test.ts`と`tests/integration/auto-yes-persistence.test.ts`が含まれ、「detectPromptのモック使用状況を確認する必要あり。シグネチャ変更の影響を受ける可能性がある」と記載されている。しかし、これらのファイルにはdetectPromptのモックやインポートが存在しない（grepで確認済み）。

**証拠**:
```
grep 'detectPrompt' tests/integration/api-prompt-handling.test.ts -> 該当なし
grep 'detectPrompt' tests/integration/auto-yes-persistence.test.ts -> 該当なし
```

**推奨対応**:
影響内容カラムを「detectPromptのモック使用状況を確認する必要あり」から「auto-yes-manager.tsまたはprompt-response/route.tsの結合テストとして、シグネチャ変更後の統合動作確認が必要」に修正し、変更要否を「要確認」から「パス確認のみ」に変更する。

---

### Nice to Have（あれば良い）

#### NTH-NEW-1: detectPrompt()呼び出し箇所の構造的理解

**カテゴリ**: 完全性
**場所**: 根本原因の仮説 > 具体的な問題箇所 > 3

**問題**:
「計9箇所」のリストにstatus-detector.ts L87が含まれているが、これは直接呼び出しであり、worktrees/route.tsとworktrees/[id]/route.tsは間接呼び出しである。この構造が一目で理解しにくい。

**推奨対応**:
「計9箇所」の記載に続けて「うちstatus-detector.ts経由の間接呼び出し2箇所を含む」と補足する。

---

#### NTH-NEW-2: auto-yes-manager.test.tsの修正方針の精度

**カテゴリ**: 明確性
**場所**: 対策案 > Phase 4 / 影響範囲 > 既存テストファイルの更新

**問題**:
auto-yes-manager.test.tsの具体的な修正方針として`toHaveBeenCalledWith()`アサーションの更新例が記載されているが、実際のテストコード（L451-459）ではsendKeysの呼び出し有無で検証しており、detectPromptのtoHaveBeenCalledWithアサーションは使用されていない。

**証拠**:
```typescript
// tests/unit/lib/auto-yes-manager.test.ts L451-459
expect(captureSessionOutput).toHaveBeenCalled();
expect(sendKeys).not.toHaveBeenCalled();
```

**推奨対応**:
修正方針を「sendKeys呼び出し有無での検証方式は変更不要。新パターンでのpollAutoYes動作テストを追加する場合はdetectPromptのモック戻り値をisDefault: falseの選択肢パターンに設定し、sendKeysが正しく呼ばれることを検証する」に修正する。

---

#### NTH-NEW-3: response-poller.ts L556のextractResponse()データフロー説明の精度

**カテゴリ**: 完全性
**場所**: 対策案 > Phase 3 > response-poller.ts > L556

**問題**:
L556の説明で「内部で一部の行はstripAnsi()されるパスもあるが」という曖昧な記述がある。extractResponse()内部（L309-310）ではstripAnsi()はパターンマッチ判定用にのみ使用され、responseLines.push(line)ではstripAnsi前の生の行がpushされている。結論は正しいが、データフローの説明が不正確。

**証拠**:
```typescript
// src/lib/response-poller.ts L309-310, L330
const cleanLine = stripAnsi(line);    // パターンマッチ判定用
// ...
responseLines.push(line);              // 生の行をpush
```

**推奨対応**:
「extractResponse()内部ではstripAnsi()をパターンマッチ判定にのみ使用し、result.responseに含まれる行はstripAnsi前の生の行であるため、detectPrompt()に渡す前にstripAnsi()を適用する」のようにより正確に記述する。

---

## コードベースとの整合性確認結果

以下の項目について、Issueの記述とコードベースの実態を照合した。

| 確認項目 | Issueの記述 | 実際のコード | 結果 |
|---------|------------|-------------|------|
| DEFAULT_OPTION_PATTERN L182 | L182にハードコード | L182: `const DEFAULT_OPTION_PATTERN = /^\s*\u276F\s*(\d+)\.\s*(.+)$/;` | 一致 |
| NORMAL_OPTION_PATTERN L189 | L189にハードコード | L189: `const NORMAL_OPTION_PATTERN = /^\s*(\d+)\.\s*(.+)$/;` | 一致 |
| Pass 1 L274-288 | DEFAULT_OPTION_PATTERN存在チェック | L274-288: hasDefaultLineチェック | 一致 |
| Layer 4 L344-350 | hasDefaultIndicatorチェック | L344-350: `options.some(opt => opt.isDefault)` | 一致 |
| response-poller.ts L248 | Claude専用ガード内、stripAnsi適用済み | L244-258: `if (cliToolId === 'claude')` + L247: `stripAnsi(fullOutput)` | 一致 |
| response-poller.ts L442 | ANSI未ストリップ | L442: `detectPrompt(fullOutput)` -- fullOutputはlines.join, ANSIストリップなし | 一致 |
| response-poller.ts L556 | extractResponse()経由 | L556: `detectPrompt(result.response)` | 一致 |
| claude-poller.ts L164 | ANSI未ストリップ | L163-164: `lines.join('\n')` + `detectPrompt(fullOutput)` | 一致 |
| claude-poller.ts L232 | ANSI未ストリップ | L232: `detectPrompt(result.response)` | 一致 |
| claude-poller startPolling未使用 | 到達不能コード | grep確認: importなし | 一致 |
| status-detector.ts L87 | detectPrompt(lastLines) | L87: `detectPrompt(lastLines)` | 一致 |
| status-detector.ts cliToolId引数 | L77でcliToolIdを受け取り | L76: `cliToolId: CLIToolType` | 一致 |
| worktrees/route.ts L58 | detectSessionStatus経由 | L58: `detectSessionStatus(output, cliToolId)` | 一致 |
| worktrees/[id]/route.ts L58 | detectSessionStatus経由 | L58: `detectSessionStatus(output, cliToolId)` | 一致 |
| current-output/route.ts L88 | thinkingガード付きdetectPrompt | L88: `detectPrompt(cleanOutput)` | 一致 |
| current-output/route.ts cliToolId | **L66付近で取得** | **L40で決定** | **不一致（SF-NEW-1）** |
| auto-yes-manager.ts L262 | pollAutoYes関数定義 | L262: `async function pollAutoYes` | 一致 |
| auto-yes-manager.ts L290 | detectPrompt呼び出し | L290: `detectPrompt(cleanOutput)` | 一致 |
| auto-yes-resolver.ts L23-36 | isDefault/options[0]フォールバック | L23-36: `defaultOpt ?? promptData.options[0]` | 一致 |
| respond/route.ts L12 | getAnswerInputのみインポート | L12: `import { getAnswerInput } from '@/lib/prompt-detector';` | 一致 |
| prompt-response/route.ts L50 | cliToolId取得 | L50: `const cliToolId` | 一致 |
| prompt-response/route.ts L75 | detectPrompt呼び出し | L75: `detectPrompt(cleanOutput)` | 一致 |
| auto-yes-resolver.test.ts isDefault:false テスト | 既存テストの確認 | L47-58: 「should return first option number when no default」テスト存在 | 一致 |

---

## 受入条件の完全性

受入条件は以下の観点で十分に網羅されている:

1. **機能要件**: UI送信、Auto-Yes自動応答の両方をカバー
2. **リグレッション**: 既存テストのパス確認、新規リグレッションテスト追加
3. **品質要件**: ANSI未ストリップ問題の全箇所修正、既存テストのモック対応
4. **サイドバーステータス**: waiting（黄色）表示の確認

受入条件に不足はない。

---

## 対策案の実現可能性

| フェーズ | 実現可能性 | 評価 |
|---------|-----------|------|
| Phase 1（前提条件確認） | 高い | tmux capture-pane出力の取得は標準的な操作 |
| Phase 2（パターン修正） | 高い | ケースA/B/Cの条件分岐が明確で、各ケースの修正方針が具体的 |
| Phase 3（呼び出し元修正） | 高い | 全9箇所の呼び出し元が特定済みで、各箇所の修正内容が明確 |
| Phase 4（テスト追加） | 高い | 既存テストの修正方針が具体的。auto-yes-resolver.test.tsのisDefault:falseテストは既存 |
| Phase 5（動作検証） | 高い | UI手動送信とAuto-Yesの両方の検証手順が明確 |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/prompt-detector.ts`: 選択肢検出ロジック（DEFAULT_OPTION_PATTERN L182, NORMAL_OPTION_PATTERN L189, Pass 1 L274-288, Layer 4 L344-350）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/response-poller.ts`: detectPrompt()呼び出し箇所（L248, L442, L556）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/claude-poller.ts`: 到達不能コード（L164, L232）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/status-detector.ts`: detectSessionStatus()とdetectPrompt()の呼び出し（L87）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/current-output/route.ts`: thinkingガード付きdetectPrompt()呼び出し（L88）、cliToolId取得（L40）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts`: detectPrompt()呼び出し（L75）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-manager.ts`: pollAutoYes()でのdetectPrompt()呼び出し（L290）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-resolver.ts`: isDefault/options[0]フォールバック（L23-36）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/route.ts`: detectSessionStatus()経由の間接呼び出し（L58）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/route.ts`: detectSessionStatus()経由の間接呼び出し（L58）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/respond/route.ts`: getAnswerInputのみインポート（L12）

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/tests/unit/prompt-detector.test.ts`: multiple_choiceリグレッションテスト基盤
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/tests/unit/lib/auto-yes-manager.test.ts`: thinking stateスキップテスト（L427-459）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/tests/unit/api/prompt-response-verification.test.ts`: detectPromptモック（L49-51）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/tests/unit/lib/auto-yes-resolver.test.ts`: isDefault:falseフォールバックテスト（L47-58）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/CLAUDE.md`: Issue #161の設計原則記載
