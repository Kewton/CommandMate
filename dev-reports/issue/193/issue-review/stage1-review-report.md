# Issue #193 Stage 1 Review Report

## Review Summary

| Item | Value |
|------|-------|
| Issue | #193: claude Codexからの複数選択肢に対し、回答を送信出来ない |
| Stage | 1 - 通常レビュー（1回目） |
| Focus | Consistency, Correctness, Completeness, Clarity |
| Date | 2026-02-08 |
| Findings | 10 (must_fix: 2, should_fix: 5, nice_to_have: 3) |

---

## Overall Assessment

Issue #193の根本原因分析は正確であり、仮説検証でも全3仮説がConfirmedとなっている。`detectMultipleChoicePrompt()`が`❯`(U+276F)マーカーに依存している点、`cli-patterns.ts`にCodex選択肢パターンがない点、`prompt-response/route.ts`がcliToolIdを`detectPrompt()`に渡していない点は、いずれもコードベースの調査で確認できた。

しかし、以下の2つの重大な不足がある:

1. **影響範囲の把握不足**: `detectPrompt()`は11箇所から呼び出されており、Issueの変更対象テーブルに記載されていない複数のファイルが実質的な変更対象となる。
2. **Codex CLIの選択肢出力形式が未特定**: テキストベースの番号入力かTUI描画の矢印キー選択かによって、設計方針が根本的に変わる可能性がある。

---

## Findings Detail

### [S1-001] MUST FIX - detectPrompt()の全呼び出し箇所でcliToolId非対応の問題が影響範囲に含まれていない

**Category**: completeness

`detectPrompt()`は以下の11箇所から呼び出されている:

| File | Line | Context |
|------|------|---------|
| `src/lib/auto-yes-manager.ts` | L290 | `pollAutoYes()` - Auto-Yesポーリング |
| `src/lib/status-detector.ts` | L87 | `detectSessionStatus()` - サイドバーステータス |
| `src/lib/response-poller.ts` | L248, L442, L556 | `extractResponse()`, prompt検出 |
| `src/lib/claude-poller.ts` | L164, L232 | Claude専用ポーラー |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | L75 | プロンプト応答API |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L88 | リアルタイム出力API |
| `src/lib/prompt-detector.ts` | L56 | 内部呼び出し |

Issueでは変更対象として`prompt-detector.ts`と`cli-patterns.ts`のみが記載されているが、`detectPrompt()`のシグネチャを変更する場合（cliToolIdパラメータの追加）、上記の全呼び出し箇所に修正が必要。

**Recommendation**: 影響範囲テーブルを更新し、少なくとも`prompt-response/route.ts`、`current-output/route.ts`、`auto-yes-manager.ts`、`status-detector.ts`、`response-poller.ts`を変更対象に追加する。または、`detectPrompt()`のシグネチャを後方互換に保つ（`cliToolId?: CLIToolType`でデフォルト`'claude'`）方針を明記する。

---

### [S1-002] MUST FIX - Codex CLIの実際の選択肢出力形式が未特定のまま対策案が記述されている

**Category**: completeness

スクリーンショットには「1から4までの選択肢から該当のモノを選択して送信することを求められている」と記述されているが、以下が不明:

1. tmuxバッファの生テキスト（stripAnsi後）にどのような文字列が残るか
2. Codex CLIの選択肢がテキスト入力（番号を入力してEnter）かTUI選択（矢印キーでカーソル移動）か
3. デフォルト選択をどのように表示するか（マーカー文字、カラーハイライト等）

`codex.ts`のstartSession()（L86-96）では、Codex CLIの更新通知やモデル選択ダイアログに対してDown arrow keyとEnterを送信しており、CodexがTUIベースの選択UIを使用していることを示唆している。TUIベースの場合、stripAnsi後のテキストに選択肢情報が残らない可能性があり、テキストパターンマッチの方針自体が機能しない恐れがある。

**Recommendation**: 実装前にtmuxバッファの実データ取得を必須のゲートとし、その結果に基づいて設計方針を確定させるべき。Issueに以下の確認事項を追記:
- `tmux capture-pane -p`の出力に選択肢テキストが含まれるか
- 選択方式（テキスト入力 vs TUI矢印キー）の確認
- TUI方式の場合の代替アプローチ検討

---

### [S1-003] SHOULD FIX - prompt-response/route.tsがcliToolIdを取得済みなのにdetectPrompt()に渡していない問題が対策案に含まれていない

**Category**: consistency

`prompt-response/route.ts`のL50:
```typescript
const cliToolId: CLIToolType = cliToolParam || worktree.cliToolId || 'claude';
```

L75:
```typescript
const promptCheck = detectPrompt(cleanOutput);  // cliToolIdが渡されていない
```

cliToolIdは取得済みだが`detectPrompt()`に渡されていない。Issueではこのファイルを「関連コンポーネント（動作確認）」に分類しているが、これは直接的なバグの原因箇所であり「変更対象」に含めるべき。

---

### [S1-004] SHOULD FIX - auto-yes-manager.tsのpollAutoYes()内のdetectPrompt()もCodex非対応だが対策案に記載なし

**Category**: consistency

`auto-yes-manager.ts`のL262-290:
```typescript
async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType): Promise<void> {
  // ... L284でdetectThinkingにはcliToolIdを渡している
  if (detectThinking(cliToolId, cleanOutput)) { ... }
  // ... L290でdetectPromptにはcliToolIdを渡していない
  const promptDetection = detectPrompt(cleanOutput);
```

`detectThinking()`にはcliToolIdが正しく渡されているのに、同じ関数内の`detectPrompt()`には渡されていない。IssueではAuto-Yesモードでの自動応答も問題として記述しているため、このファイルは変更対象に含めるべき。

---

### [S1-005] SHOULD FIX - response-poller.tsとclaude-poller.tsのdetectPrompt()呼び出しが影響範囲から漏れている

**Category**: completeness

`response-poller.ts`のL244-258にはClaude専用の早期プロンプトチェック（`if (cliToolId === 'claude')`）があるが、L442とL556の`detectPrompt()`呼び出しはCLIツール種別を問わず実行される。Codexセッション時にもこれらの呼び出しが行われるため、影響範囲に含まれる。

---

### [S1-006] SHOULD FIX - Codex CLIの選択肢がTUI描画の可能性への言及なし

**Category**: correctness

`codex.ts`のstartSession()では:
```typescript
// Auto-skip update notification if present (select option 2: Skip)
await sendKeys(sessionName, '2', true);
// T2.6: Skip model selection dialog by sending Down arrow + Enter
await execAsync(`tmux send-keys -t "${sessionName}" Down`);
await execAsync(`tmux send-keys -t "${sessionName}" Enter`);
```

これはCodex CLIが少なくとも一部の場面でTUI方式（矢印キー選択）と番号入力方式の両方を使用していることを示唆する。問題の選択肢がどちらの方式かによって、テキストパターンマッチが有効かどうかが決まる。

---

### [S1-007] SHOULD FIX - auto-yes-resolver.tsのCodex対応方針が不明確

**Category**: clarity

`auto-yes-resolver.ts`はpromptData.typeが`'multiple_choice'`の場合、`isDefault=true`の選択肢を自動選択し、デフォルトがなければ`options[0]`を選択する。Codex CLIでデフォルト選択の概念があるかどうか、また最初の選択肢を自動選択することが安全かどうかの検討が記載されていない。

---

### [S1-008] NICE TO HAVE - status-detector.tsへの影響への言及なし

**Category**: completeness

`status-detector.ts`のL87で`detectPrompt(lastLines)`を呼び出し、プロンプト検出時に`status='waiting'`を返す。Codex CLIの選択肢が検出されない場合、サイドバーのステータスが`'waiting'`（黄色）ではなく`'running'`（スピナー）を誤表示する。

---

### [S1-009] NICE TO HAVE - current-output/route.tsが影響範囲に含まれていない

**Category**: completeness

`current-output/route.ts`のL88で`detectPrompt()`の結果を`isPromptWaiting`としてUIに返しており、選択肢UIの表示に直接影響する。Issueの影響範囲に記載されていない。

---

### [S1-010] NICE TO HAVE - detectPrompt()のCLIツール別対応の設計方針が絞り込まれていない

**Category**: clarity

対策案3では「CLIツール別の選択肢パターン分岐、またはパターンのパラメータ化」と2つのアプローチが並列で記載されている。Issue #161で確立された「prompt-detector.tsのCLIツール非依存性」の設計原則との整合性を考慮し、推奨案を絞り込むべき。

---

## detectPrompt() Call Graph (Impact Visualization)

```
detectPrompt(output)
  |
  +-- prompt-response/route.ts:75      [Codex affected] - 変更対象に昇格すべき
  +-- current-output/route.ts:88       [Codex affected] - 影響範囲に追加すべき
  +-- auto-yes-manager.ts:290          [Codex affected] - 変更対象に昇格すべき
  +-- status-detector.ts:87            [Codex affected] - 影響範囲に追加すべき
  +-- response-poller.ts:248           [Claude only branch, but...]
  +-- response-poller.ts:442           [Codex affected] - 影響範囲に追加すべき
  +-- response-poller.ts:556           [Codex affected] - 影響範囲に追加すべき
  +-- claude-poller.ts:164             [Claude only]
  +-- claude-poller.ts:232             [Claude only]
  +-- prompt-detector.ts:56 (internal) [Affected by design change]
```

---

## Conclusion

Issue #193の問題記述と根本原因分析は正確だが、実装計画の完全性に不足がある。特に以下の2点の解決が必要:

1. `detectPrompt()`の全呼び出し箇所を影響範囲に含め、シグネチャ変更の方針を明確にする
2. Codex CLIの選択肢出力形式をtmuxバッファの実データで確認し、テキストパターンマッチの方針が有効かどうかを検証する

これらが解決されれば、実装に進むことができる。
