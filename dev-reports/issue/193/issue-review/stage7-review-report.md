# Issue #193 レビューレポート（Stage 7）

**レビュー日**: 2026-02-08
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: 7/8

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

## 前回指摘事項（Stage 3）の反映確認

全9件（Must Fix 2件 + Should Fix 4件 + Nice to Have 3件）が適切に反映されていることを確認した。

### Must Fix（2件 -- 全て解決済み）

| ID | ステータス | 検証結果 |
|-----|----------|---------|
| MF-1 | 解決済み | status-detector.ts経由の間接依存が間接影響ファイルテーブルとPhase 3チェックリストに正しく反映。cliToolIdからDetectPromptOptionsを構築する内部修正の記述あり |
| MF-2 | 解決済み | 既存テストのモック修正方針が具体化。さらにコードベース検証で、全テストファイルにおいてdetectPromptに対するtoHaveBeenCalledWith()アサーションが一切存在しないことを確認 |

### Should Fix（4件 -- 全て解決済み）

| ID | ステータス | 検証結果 |
|-----|----------|---------|
| SF-1 | 解決済み | claude-poller.tsの到達不能コード注記が変更対象テーブル・呼び出し箇所リスト・Phase 3に明記。startPollingのimportがsrc/内に存在しないことをgrepで確認 |
| SF-2 | 解決済み | auto-yes-resolver.test.tsがテスト影響範囲に追加。L47-58に「全選択肢isDefault: falseでoptions[0]選択」テストが既存であることを確認 |
| SF-3 | 解決済み | 統合テスト2ファイルがテスト影響範囲に追加。detectPromptの直接モック使用なし、変更要否「パス確認のみ」に更新済み |
| SF-4 | 解決済み | CLAUDE.mdが変更対象ファイルとドキュメント影響範囲の両方に記載 |

### Nice to Have（3件 -- 全て解決済み）

| ID | ステータス | 検証結果 |
|-----|----------|---------|
| NTH-1 | 解決済み | UIコンポーネント3ファイルが間接影響テーブルに記載。Phase 5にisDefault: false時の表示確認追加 |
| NTH-2 | 解決済み | Codex/Gemini影響分析が追加。cliToolIdベースのoptions構築設計が明記 |
| NTH-3 | 解決済み | PROMPT_HANDLING_IMPLEMENTATION_PLAN.mdがドキュメント影響範囲にフォローアップ対象として記載 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### SF-7-1: response-poller.ts L442のstripAnsi追加のClaude到達パスにおける冗長性の明確化

**カテゴリ**: 影響ファイル
**場所**: 対策案 > Phase 3 > response-poller.ts > L442

**問題**:
response-poller.ts L442の`detectPrompt(fullOutput)`呼び出しにおけるstripAnsi追加について、Claude到達パスでの挙動が明確に説明されていない。

具体的なデータフロー:
1. Claudeの場合、まずL244のClaude専用ガードに入り、L247-248で`stripAnsi(fullOutput)`を適用した上で`detectPrompt(cleanFullOutput)`が呼ばれる
2. L248のdetectPromptがfalseを返した場合にのみL442に到達する
3. L442で同じfullOutputに再度stripAnsiを適用してdetectPromptを呼んでも、L248と同じ結果（false）になる可能性が高い

したがって、L442のstripAnsi追加の実質的な恩恵は主にCodex/Geminiのパスにある。Issueの現行記述ではこの区別が不明瞭であり、実装者がClaude向けの修正効果を過大評価する可能性がある。

**証拠**:
```
response-poller.ts L244-258:
  if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');
    const cleanFullOutput = stripAnsi(fullOutput);
    const promptDetection = detectPrompt(cleanFullOutput);
    ...
  }

response-poller.ts L441-442:
  const fullOutput = lines.join('\n');
  const promptDetection = detectPrompt(fullOutput);
```

**推奨対応**:
Phase 3のresponse-poller.ts L442の説明に、「Claudeの場合はL248で既にstripAnsi適用済みのdetectPrompt()が実行されているため、L442のstripAnsi追加はClaude到達パスでは重複適用となる。L442修正の主な恩恵はCodex/Geminiのパス、およびコードの一貫性維持にある」と補足する。

---

#### SF-7-2: ケースBにおけるPromptPanel/MobilePromptSheetのselectedOption初期状態の動作検証

**カテゴリ**: テスト範囲
**場所**: 対策案 > Phase 5

**問題**:
ケースB（全選択肢がisDefault: false）の場合、PromptPanel.tsxとMobilePromptSheet.tsxの`selectedOption`初期値が`null`になる。

```typescript
// PromptPanel.tsx L69-74
const [selectedOption, setSelectedOption] = useState<number | null>(() => {
  if (promptData.type === 'multiple_choice') {
    const defaultOpt = promptData.options.find(opt => opt.isDefault);
    return defaultOpt?.number ?? null;  // isDefault: falseの場合 -> null
  }
  return null;
});
```

`selectedOption === null`の場合、`handleMultipleChoiceSubmit`（L106）で早期リターンされるため、ユーザーが選択肢を明示的にクリックしないと送信ボタンが機能しない。

既存の(マーカー付きプロンプトでは必ずisDefault: trueの選択肢が1つ存在するため、デフォルト選択が自動で行われている。ケースBではこの自動選択が行われないため、ユーザー体験が変わる。これはバグではなく意図された動作だが、Phase 5の動作検証項目に明記されていない。

**推奨対応**:
Phase 5の動作検証に以下の確認項目を追加:
- ケースBプロンプトで、デフォルト選択肢がない場合に送信ボタンが初期状態で無効化されていること
- ユーザーが選択肢をクリックした後に送信ボタンが有効化されること
- 選択肢が正しく送信されること

---

### Nice to Have（あれば良い）

#### NTH-7-1: prompt-response-verification.test.tsの修正方針の精度向上

**カテゴリ**: テスト範囲
**場所**: 影響範囲 > 既存テストファイルの更新 > prompt-response-verification.test.ts

**問題**:
既存テストファイル更新テーブルのprompt-response-verification.test.tsに「`toHaveBeenCalledWith()`アサーションのみ確認・更新」と記載されている。しかし、コードベース全体のgrep結果として、detectPromptに対する`toHaveBeenCalledWith()`アサーションはこのファイル内（およびauto-yes-manager.test.ts内）に一切存在しない。

テストの検証方法:
- `prompt-response-verification.test.ts`: `sendKeys`のtoHaveBeenCalled()（引数検証なし）で動作を検証
- `auto-yes-manager.test.ts`: `sendKeys`のtoHaveBeenCalled()/not.toHaveBeenCalled()で動作を検証

**推奨対応**:
prompt-response-verification.test.tsの修正方針を「detectPromptに対するtoHaveBeenCalledWithアサーションは使用されていない。vi.fn().mockReturnValue(...)のモック定義は引数の数に依存しないため既存テストは変更不要。パス確認のみ」に修正する。

---

#### NTH-7-2: status-detector.tsの既存stripAnsi適用状況の明記

**カテゴリ**: 影響ファイル
**場所**: 影響範囲 > 変更対象ファイル > status-detector.ts

**問題**:
status-detector.tsの`detectSessionStatus()`はL81で`stripAnsi(output)`を内部で呼び出し、ANSIストリップ済みの`cleanOutput`から`lastLines`を切り出して`detectPrompt(lastLines)`に渡している。

```typescript
// status-detector.ts L80-87
const cleanOutput = stripAnsi(output);
const lines = cleanOutput.split('\n');
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
const promptDetection = detectPrompt(lastLines);
```

したがって、受入条件の「detectPrompt()を呼び出す全箇所でANSI未ストリップの生出力が渡されていないこと」は、status-detector.ts経由のパスでは現行でも達成済みである。変更対象ファイルテーブルではstatus-detector.tsに「L87のdetectPrompt()修正」とのみ記載されているが、修正内容がoptions引数の追加のみであることが明示されていない。

**推奨対応**:
status-detector.tsの変更内容に「status-detector.tsは内部でstripAnsi()を既に適用済み（L81）のため、ANSIストリップの追加修正は不要。修正対象はdetectPrompt(lastLines, options)へのoptions引数追加のみ」と補足する。

---

## 影響範囲テーブルの網羅性評価

### 変更対象ファイルテーブル（9ファイル）

| ファイル | 検証結果 |
|---------|---------|
| `src/lib/prompt-detector.ts` | 適切。detectPrompt()シグネチャ変更、DetectPromptOptions定義、Pass 1/Layer 4修正 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 適切。L75のdetectPrompt()にoptions追加。cliToolIdはL50で取得済み |
| `src/lib/auto-yes-manager.ts` | 適切。L290のdetectPrompt()にoptions追加。cliToolIdはL262関数引数、stripAnsi()はL279で適用済み |
| `src/lib/response-poller.ts` | 適切。L442のstripAnsi追加+options追加、L556同様。L248は変更不要 |
| `src/lib/claude-poller.ts` | 適切。L164/L232のstripAnsi追加+options追加。到達不能コード注記あり |
| `src/lib/status-detector.ts` | 適切。L87のoptions追加のみ（stripAnsiはL81で適用済み） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 適切。L88のdetectPrompt()にoptions追加。cliToolIdはL40で取得済み |
| `tests/unit/prompt-detector.test.ts` | 適切。新規テスト追加 |
| `CLAUDE.md` | 適切。Issue #193概要セクション追加 |

**網羅性**: 漏れなし。detectPromptの全呼び出し箇所（8箇所直接+1箇所間接）が網羅されている。

### 間接影響ファイルテーブル（8ファイル）

| ファイル | 検証結果 |
|---------|---------|
| `worktrees/route.ts` L58 | 適切。detectSessionStatus()経由の間接呼び出し。コード変更不要 |
| `worktrees/[id]/route.ts` L58 | 適切。同上 |
| `auto-yes-resolver.ts` L23-36 | 適切。isDefaultフォールバック動作確認対象 |
| `respond/route.ts` L12 | 適切。getAnswerInputのみインポート。直接影響なし |
| `PromptPanel.tsx` | 適切。isDefault UIバッジとselectedOption初期化に間接影響 |
| `MobilePromptSheet.tsx` | 適切。同上 |
| `PromptMessage.tsx` | 適切。isDefault表示に間接影響 |
| `useAutoYes.ts` | 適切。resolveAutoAnswer()経由の間接影響 |

**網羅性**: 漏れなし。

### テスト影響範囲テーブル（7ファイル）

| ファイル | 検証結果 |
|---------|---------|
| `prompt-detector.test.ts` | 適切。追加のみ |
| `auto-yes-manager.test.ts` | 適切。パス確認のみ（toHaveBeenCalledWithアサーション未使用） |
| `prompt-response-verification.test.ts` | 適切。ただし修正方針がやや過剰（NTH-7-1参照） |
| `auto-yes-resolver.test.ts` | 適切。L47-58に既存テストあり追加不要 |
| `api-prompt-handling.test.ts` | 適切。パス確認のみ |
| `auto-yes-persistence.test.ts` | 適切。パス確認のみ |
| `status-detector.test.ts` | 適切。パス確認 |

**網羅性**: 漏れなし。

### ドキュメント影響範囲テーブル（2ファイル）

| ファイル | 検証結果 |
|---------|---------|
| `CLAUDE.md` | 適切。Phase 4完了後に更新 |
| `PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` | 適切。フォローアップ対応 |

**網羅性**: 漏れなし。

---

## detectPrompt()シグネチャ変更の波及効果完全性

### 呼び出し箇所の検証（9箇所全て確認済み）

コードベースの`grep -r 'detectPrompt' src/`の結果と、Issueに記載された9箇所（直接8+間接1）が完全に一致することを確認した。追加の呼び出し箇所は存在しない。

### stripAnsi適用状況サマリー

| 箇所 | 現行のstripAnsi状況 | 修正要否 |
|------|-------------------|---------|
| auto-yes-manager.ts L290 | 適用済み（L279） | options追加のみ |
| prompt-response/route.ts L75 | 適用済み（L74） | options追加のみ |
| current-output/route.ts L88 | 適用済み（L77） | options追加のみ |
| response-poller.ts L248 | 適用済み（L247） | 変更不要 |
| response-poller.ts L442 | **未適用** | stripAnsi追加 + options追加 |
| response-poller.ts L556 | **未適用** | stripAnsi追加 + options追加 |
| claude-poller.ts L164 | **未適用（到達不能）** | stripAnsi追加 + options追加 |
| claude-poller.ts L232 | **未適用（到達不能）** | stripAnsi追加 + options追加 |
| status-detector.ts L87（間接） | 適用済み（L81） | options追加のみ |

### テストモック影響サマリー

全テストファイルにおいて、detectPromptに対する`toHaveBeenCalledWith()`アサーションは存在しない。したがって、シグネチャ変更（optionalパラメータ追加）によるテストの破壊は発生しない。

---

## 総合評価

Issue #193の影響範囲分析は前回（Stage 3）のレビュー指摘事項を全て反映し、Stage 5/6での追加修正も適切に行われている。変更対象ファイル9件、間接影響ファイル8件、テスト影響範囲7件、ドキュメント影響範囲2件の全てが網羅的かつ正確に記載されている。

新規指摘事項はMust Fixなし、Should Fix 2件（データフロー説明の補足、UI動作検証項目の追加）、Nice to Have 2件（テスト修正方針の精度向上、stripAnsi適用状況の明記）であり、影響範囲の漏れに起因する重大な問題は発見されなかった。

## 参照ファイル

### コード
- `src/lib/prompt-detector.ts`: detectPrompt()のシグネチャ変更対象（L44）
- `src/lib/status-detector.ts`: detectSessionStatus()経由のdetectPrompt()間接呼び出し（L87）
- `src/lib/response-poller.ts`: detectPrompt()の3箇所呼び出し（L248, L442, L556）
- `src/lib/claude-poller.ts`: detectPrompt()の2箇所呼び出し（L164, L232）-- 到達不能コード
- `src/lib/auto-yes-manager.ts`: pollAutoYes()内のdetectPrompt()呼び出し（L290）
- `src/app/api/worktrees/[id]/prompt-response/route.ts`: プロンプト再検証（L75）
- `src/app/api/worktrees/[id]/current-output/route.ts`: thinkingガード付きdetectPrompt()（L88）
- `src/components/worktree/PromptPanel.tsx`: isDefault依存のselectedOption初期化（L69-74）
- `src/components/mobile/MobilePromptSheet.tsx`: 同上（L207-213）
- `tests/unit/api/prompt-response-verification.test.ts`: detectPromptモック（L49-51）
- `tests/unit/lib/auto-yes-manager.test.ts`: thinking stateスキップテスト（L427-498）
- `tests/unit/lib/auto-yes-resolver.test.ts`: isDefault: falseフォールバックテスト（L47-58）

### ドキュメント
- `CLAUDE.md`: Issue #193概要の追加対象
- `dev-reports/issue/180/issue-review/stage8-issue-body.md`: claude-poller.ts到達不能コード判定の根拠
