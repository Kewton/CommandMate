# Architecture Review: Issue #193 - Stage 2 整合性レビュー

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue | #193 - Claude Code複数選択肢プロンプト検出 |
| ステージ | Stage 2: 整合性レビュー |
| レビュー日 | 2026-02-09 |
| 対象 | 設計方針書 vs 実コードベースの整合性 |
| 総合評価 | 条件付き承認（conditionally_approved） |
| スコア | 4/5 |

---

## Executive Summary

Issue #193の設計方針書に記載された行番号、関数名、パターン名、シグネチャ、データフロー、依存関係を実コードと照合した結果、大部分が正確に一致していることを確認した。17項目の整合性マトリクスのうち16項目が一致、1項目（変更対象呼び出し元数の記載）に不一致が検出された。

設計方針書は全体として実コードベースに対する高い整合性を持っており、実装ガイドとして十分に機能する品質である。ただし、変更対象数の記載不整合が1件あり、実装者が対象範囲を誤認する可能性があるため、修正が必要である。

---

## 詳細検証結果

### 1. 行番号・関数名・パターン名の検証

#### 1.1 prompt-detector.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| Pass 1 (L274-288): DEFAULT_OPTION_PATTERN存在チェック | L274-288: hasDefaultLineループとearly return | 一致 |
| Layer 4 (L344-350): hasDefaultIndicatorチェック | L343-350: hasDefaultIndicator代入(L344)とifチェック(L345-350) | 一致（1行のズレは範囲内） |
| `detectPrompt(output: string): PromptDetectionResult` | L44: 同一シグネチャ | 一致 |
| `detectMultipleChoicePrompt(output: string): PromptDetectionResult` | L264: 同一シグネチャ | 一致 |
| `DEFAULT_OPTION_PATTERN` (U+276F) | L182: `/^\s*\u276F\s*(\d+)\.\s*(.+)$/` | 一致 |
| `NORMAL_OPTION_PATTERN` | L189: `/^\s*(\d+)\.\s*(.+)$/` | 一致 |
| `isConsecutiveFromOne()` | L204-211 | 一致 |

#### 1.2 cli-patterns.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| CLIToolTypeのimportが既に存在 | L6: `import type { CLIToolType } from './cli-tools/types';` | 一致 |
| buildDetectPromptOptions()の配置先として適切 | detectThinking(), getCliToolPatterns()など既存のCLIツール別関数が存在 | 一致 |
| stripAnsi()がexportされている | L169: `export function stripAnsi(str: string): string` | 一致 |

#### 1.3 status-detector.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| detectPrompt(lastLines) -- L87 | L87: `const promptDetection = detectPrompt(lastLines);` | 一致 |
| stripAnsi()はL81で適用済み | L81: `const cleanOutput = stripAnsi(output);` | 一致 |
| STATUS_CHECK_LINE_COUNT = 15（15行ウィンドウイング） | L50: `const STATUS_CHECK_LINE_COUNT: number = 15;` | 一致 |
| detectSessionStatus()がcliToolIdを引数に持つ | L75-78: `detectSessionStatus(output, cliToolId, lastOutputTimestamp?)` | 一致 |

#### 1.4 response-poller.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| L248: detectPrompt(cleanFullOutput) -- stripAnsi()適用済み | L247-248: `const cleanFullOutput = stripAnsi(fullOutput);` + `detectPrompt(cleanFullOutput)` | 一致 |
| L442: detectPrompt(fullOutput) -- stripAnsi()未適用 | L442: `const promptDetection = detectPrompt(fullOutput);` -- fullOutputは生データ | 一致 |
| L556: detectPrompt(result.response) -- stripAnsi()未適用 | L556: `const promptDetection = detectPrompt(result.response);` -- result.responseは生データ | 一致 |
| 3箇所のdetectPrompt()呼び出し | L248, L442, L556の3箇所 | 一致 |

**L442のデータフロー詳細**:
```
L441: const fullOutput = lines.join('\n');
L442: const promptDetection = detectPrompt(fullOutput);
```
`lines`はL202で`rawLines.slice(0, trimmedLength)`から取得。rawLinesは生のoutputからsplit。stripAnsi()は適用されていない。設計書の「stripAnsi()未適用」の指摘は正確。

**L556のデータフロー詳細**:
```
L525: const result = extractResponse(output, lastCapturedLine, cliToolId);
L556: const promptDetection = detectPrompt(result.response);
```
`extractResponse()`内部ではL310で`const cleanLine = stripAnsi(line);`をパターンマッチ用に使用するが、L330で`responseLines.push(line)`と生の行をpushしている。よってresult.responseにはANSIコードが残存する可能性がある。設計書の指摘は正確。

#### 1.5 auto-yes-manager.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| detectPrompt(cleanOutput) -- L290 | L290: `const promptDetection = detectPrompt(cleanOutput);` | 一致 |
| stripAnsi()はL279で適用 | L279: `const cleanOutput = stripAnsi(output);` | 一致 |
| thinking状態スキップ（Layer 1） | L284-287: `if (detectThinking(cliToolId, cleanOutput)) { scheduleNextPoll(); return; }` | 一致 |
| resolveAutoAnswer()呼び出し | L299: `const answer = resolveAutoAnswer(promptDetection.promptData);` | 一致 |

#### 1.6 auto-yes-resolver.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| isDefault=falseフォールバック: options[0]を使用 | L24-25: `const defaultOpt = promptData.options.find(o => o.isDefault);` + `const target = defaultOpt ?? promptData.options[0];` | 一致 |
| requiresTextInput時はnull返却 | L31-33: `if (target.requiresTextInput) { return null; }` | 一致 |

**フォールバック動作の検証**:
`requireDefaultIndicator: false`の場合、detectMultipleChoicePrompt()が返す選択肢は全てisDefault=falseとなる。auto-yes-resolver.tsではdefaultOpt=undefinedとなり、`promptData.options[0]`にフォールバックする。これは設計書の記載「multiple_choice without default -> first option number」と一致する。

#### 1.7 claude-poller.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| L164: detectPrompt(fullOutput) -- 到達不能 | L164: `const promptDetection = detectPrompt(fullOutput);` -- stripAnsi()未適用 | 一致 |
| L232: detectPrompt(result.response) -- 到達不能 | L232: `const promptDetection = detectPrompt(result.response);` -- stripAnsi()未適用 | 一致 |
| 到達不能コードである | startPolling()がどこからもimportされていない（stopPollingのみがsession-cleanup.tsとmanager.tsでimport） | 一致 |

#### 1.8 prompt-response/route.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| detectPrompt(cleanOutput) | L75: `const promptCheck = detectPrompt(cleanOutput);` | 一致 |
| cliToolIdが取得可能 | L50: `const cliToolId: CLIToolType = cliToolParam \|\| worktree.cliToolId \|\| 'claude';` | 一致 |
| stripAnsi()適用済み | L74: `const cleanOutput = stripAnsi(currentOutput);` | 一致 |

#### 1.9 current-output/route.ts

| 設計書記載 | 実コード | 一致 |
|-----------|---------|------|
| detectPrompt(cleanOutput) -- L88 | L88: `detectPrompt(cleanOutput)` (三項演算子内) | 一致 |
| cliToolIdはL40で取得済み | L40: `const cliToolId: CLIToolType = isCliTool(cliToolParam) ? cliToolParam : (worktree.cliToolId \|\| 'claude');` | 一致 |

### 2. mermaid図と実際の依存関係の検証

| mermaid図の矢印 | 実コードでの依存 | 一致 |
|----------------|-----------------|------|
| PR -> detectPrompt | prompt-response/route.ts L14: `import { detectPrompt }` | 一致 |
| CO -> detectPrompt | current-output/route.ts L9: `import { detectPrompt }` | 一致 |
| AY -> detectPrompt | auto-yes-manager.ts L13: `import { detectPrompt }` | 一致 |
| SD -> detectPrompt | status-detector.ts L13: `import { detectPrompt }` | 一致 |
| RP -> detectPrompt | response-poller.ts L17: `import { detectPrompt }` | 一致 |
| CP -> detectPrompt (到達不能) | claude-poller.ts L10: `import { detectPrompt }` -- startPolling未使用 | 一致 |
| WR -> detectSessionStatus | worktrees/route.ts L16: `import { detectSessionStatus }` | 一致 |
| WD -> detectSessionStatus | worktrees/[id]/route.ts L13: `import { detectSessionStatus }` | 一致 |
| AY -> resolveAutoAnswer | auto-yes-manager.ts L14: `import { resolveAutoAnswer }` | 一致 |
| PR -> buildDetectPromptOptions -> CLP (設計) | 未実装（設計段階） | N/A |
| CO -> buildDetectPromptOptions -> CLP (設計) | 未実装（設計段階） | N/A |

### 3. detectPrompt()呼び出し箇所の総数検証

| # | ファイル | 行番号 | stripAnsi適用 | 優先度 |
|---|---------|-------|-------------|--------|
| 1 | prompt-response/route.ts | L75 | 適用済み(L74) | P0 |
| 2 | current-output/route.ts | L88 | 適用済み(L77) | P1 |
| 3 | auto-yes-manager.ts | L290 | 適用済み(L279) | P0 |
| 4 | status-detector.ts | L87 | 適用済み(L81) | P0 |
| 5 | response-poller.ts | L248 | 適用済み(L247) | P1 |
| 6 | response-poller.ts | L442 | **未適用** | P1 |
| 7 | response-poller.ts | L556 | **未適用** | P1 |
| 8 | claude-poller.ts | L164 | **未適用** | P2 |
| 9 | claude-poller.ts | L232 | **未適用** | P2 |

**合計: 9箇所** -- 設計書の記載と一致。

---

## 指摘事項

### Must Fix (必須改善項目)

#### IC-001: 変更対象呼び出し元数の記載不整合

**重要度**: medium

**箇所**: セクション3 代替案比較表

**内容**: セクション3では「呼び出し元9箇所のうち6箇所を更新」と記載しているが、セクション5の変更対象ファイル一覧を数えると:

- P0: prompt-response/route.ts(1) + auto-yes-manager.ts(1) + status-detector.ts(1) = 3呼び出し箇所
- P1: response-poller.ts(3) + current-output/route.ts(1) = 4呼び出し箇所
- P0+P1合計: **7呼び出し箇所**（5ファイル）
- P2: claude-poller.ts(2) = 2呼び出し箇所
- 全合計: **9呼び出し箇所**（7ファイル）

セクション11のMF-001チェックリストでは全9箇所（claude-poller含む）を列挙しており、セクション3の「6」はいずれの集計とも一致しない。

**推奨対応**: セクション3の「6箇所」を「7箇所（P0: 3 + P1: 4）、P2の2箇所を含めると全9箇所」に修正する。

---

### Should Fix (推奨改善項目)

#### IC-002: response-poller.ts L556のデータフロー補足

**重要度**: low

**箇所**: セクション6.3 ANSI未ストリップ修正

**内容**: L556で`detectPrompt(result.response)`に渡される`result.response`が、なぜANSIストリップされていないのかのデータフロー説明が不足している。`extractResponse()`内部では`cleanLine = stripAnsi(line)`をパターンマッチ用に使用するが、`responseLines.push(line)`では生のlineをpushしている。実装者がstripAnsi()の必要性を正しく判断するためにはこの情報が有用である。

**推奨対応**: セクション6.3に「extractResponse()はパターンマッチ用にstripAnsi()を適用するが、応答本文には生のline（ANSIコード含む）を蓄積するため、L556の戻り値にはANSIコードが残存する」と補足する。

#### IC-003: status-detector.tsのcliToolId伝搬経路の明記

**重要度**: low

**箇所**: セクション5 変更対象ファイル一覧

**内容**: status-detector.tsの変更説明で「buildDetectPromptOptions() + detectPrompt(lastLines, promptOptions)」と記載しているが、`buildDetectPromptOptions(cliToolId)`のcliToolIdがdetectSessionStatus()の既存引数から取得されることが明示されていない。

**推奨対応**: 「detectSessionStatus()の既存引数cliToolIdをbuildDetectPromptOptions()に渡す」と明記する。

---

### Consider (検討事項)

#### IC-004: current-output/route.tsのthinking分岐との統合

**重要度**: info

**内容**: L88の三項演算子`thinking ? { isPrompt: false, cleanContent: cleanOutput } : detectPrompt(cleanOutput)`で、thinking時はdetectPrompt()自体がスキップされる。buildDetectPromptOptions()追加後もこの分岐構造が維持されることを明記すると、実装者の理解を助ける。

#### IC-005: auto-yes-resolver.tsのisDefaultフォールバックのトレーサビリティ

**重要度**: info

**内容**: requireDefaultIndicator=false時にdetectPrompt()が返す選択肢は全てisDefault=falseとなる。auto-yes-resolver.tsではoptions[0]にフォールバックする動作は実コードで確認済みだが、設計書のセクション4.6（Issue #161多層防御との整合性）テーブルにこの連鎖が記載されていない。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 変更対象数の記載不整合による実装漏れ | Low | Low | P2 |
| セキュリティ | ANSI未ストリップ箇所の特定は正確 | Low | Low | P3 |
| 運用リスク | 設計書通りの実装で既存動作に影響なし | Low | Low | P3 |

---

## 総合判定

**ステータス: conditionally_approved（条件付き承認）**

**条件**: IC-001（変更対象数の記載不整合）を修正すること。

### 承認理由

1. 17項目の整合性マトリクスのうち16項目（94%）が実コードと完全に一致
2. 行番号の参照が全て正確（prompt-detector.ts, response-poller.ts, auto-yes-manager.ts, status-detector.ts, claude-poller.ts）
3. mermaid図の依存関係が全て実コードのimport文と一致
4. ANSI未ストリップ箇所の特定（response-poller.ts L442/L556, claude-poller.ts L164/L232）が正確
5. auto-yes-resolver.tsのフォールバック動作の記載が実コードと一致
6. claude-poller.tsの到達不能コード判定が正確（startPollingがどこからもimportされていない）
7. CLIToolTypeのimportがcli-patterns.tsに既に存在することの確認が正確

### 条件付きの理由

セクション3の「呼び出し元9箇所のうち6箇所を更新」という記載が実際の対象数（P0+P1で7箇所）と不一致。これはセクション5/11の記載とも矛盾しており、実装者が対象範囲を誤認するリスクがある。

---

## レビュー対象ファイル

| ファイル | 絶対パス |
|---------|---------|
| prompt-detector.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/prompt-detector.ts` |
| cli-patterns.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/cli-patterns.ts` |
| status-detector.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/status-detector.ts` |
| response-poller.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/response-poller.ts` |
| auto-yes-manager.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-manager.ts` |
| auto-yes-resolver.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-resolver.ts` |
| claude-poller.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/claude-poller.ts` |
| prompt-response/route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts` |
| current-output/route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/current-output/route.ts` |
| worktrees/route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/route.ts` |
| worktrees/[id]/route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/route.ts` |
| cli-tools/types.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/cli-tools/types.ts` |
