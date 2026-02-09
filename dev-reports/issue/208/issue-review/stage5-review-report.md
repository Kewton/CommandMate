# Issue #208 レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 通常レビュー
**イテレーション**: 2回目（Stage 5）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 1 |
| Nice to Have | 2 |

## 前回指摘事項の対応状況

### Stage 1（通常レビュー 1回目）の指摘

| ID | 内容 | 状況 |
|----|------|------|
| MF-1 | 行番号の不正確さ | Stage 2で修正済み。ただし commit 6deb100 のマージにより prompt-detector.ts の行番号が再びシフトした（後述 MF-1） |
| SF-1 | Layer 5の「無効」表現 | 修正済み。「条件付きで通過」に変更され、条件の説明も追加された |
| SF-2 | status-detector.ts経由パスの記載不足 | 修正済み。「パス3」として影響範囲セクションに追記された |
| SF-3 | Issue #193設計意図の説明不足 | 修正済み。背景セクションにIssue #193の正当性、Layer 5の限界、Pass 1無効化の説明が追加された |
| SF-4 | 対策案の欠落 | 修正済み。「対策案の方向性」セクションに3候補とIssue #193回帰リスク評価が追加された |
| NTH-1 | THINKING_CHECK_LINE_COUNT補足 | 修正済み。発生メカニズムフロー図のステップ2に補足が追加された |
| NTH-2 | cleanOutput全文渡しの補足 | 修正済み。ステップ3の補足に全文渡しと50行スキャンの説明が追加された |
| NTH-3 | 再現手順ステップ4の曖昧さ | 修正済み。具体的な出力例が追加された |

### Stage 3（影響範囲レビュー 1回目）の指摘

| ID | 内容 | 状況 |
|----|------|------|
| MF-1 | response-poller.ts影響パスの記載漏れ | 修正済み。「パス2」として3箇所のdetectPromptWithOptions()呼び出しが詳細に記載された |
| SF-1 | claude-poller.ts整合性チェック | 修正済み。「整合性チェック対象」セクションとして記載された |
| SF-2 | テスト範囲の欠落 | 修正済み。「テスト対象」セクションに単体テスト4項目、結合テスト1項目、回帰テスト2項目が追加された |
| SF-3 | useAutoYes.ts経由パスの記載漏れ | 修正済み。「パス4」「パス5」として記載された |
| NTH-1 | ドキュメント更新対象の記載 | 修正済み。「ドキュメント更新対象」セクションが追加された |
| NTH-2 | Issue #193回帰リスク評価 | 修正済み。各対策案にリスク評価と共通回帰テスト項目が追加された |

---

## Must Fix（必須対応）

### MF-1: commit 6deb100によるprompt-detector.ts行番号のシフト

**カテゴリ**: 正確性
**場所**: ## 関連コード テーブル、## 根本原因分析 > 発生メカニズム フロー図

**問題**:
PR #210（commit `6deb100`: `fix(prompt-detector): strip trailing empty lines before scan window computation`）がmainにマージされた。この変更で`detectMultipleChoicePrompt()`に末尾空行トリム処理（12行）が追加され、以降のコードが+8行シフトした。Issueの関連コードテーブルに記載されているprompt-detector.tsの行番号が現在のソースコードと一致しない。

**具体的なシフト**:

| 項目 | Issueの記載 | 実際の行番号（現在） |
|------|-----------|-------------------|
| Pass 1ゲート（Layer 2） | 313-329 | 321-337 |
| Pass 2 + Layer 3-5 | 338-403 | 346-411 |

**証拠**:
```
# commit 6deb100 の差分より:
# L305-311: 末尾空行トリムのwhile loop + effectiveEnd変数 + コメント（12行追加）
# L314: scanStart計算（旧L304）
# L321: Pass 1 if (requireDefault) ブロック開始（旧L313）
# L346: Pass 2 for loop開始（旧L338）
# L402-411: Layer 5 SEC-001ガード（旧L394-403）
```

**推奨対応**:
関連コードテーブルのprompt-detector.tsの行番号を以下のように修正する:
- `313-329` -> `321-337`
- `338-403` -> `346-411`

---

## Should Fix（推奨対応）

### SF-1: 末尾空行トリム処理がバグ発生確率に与える影響の記載漏れ

**カテゴリ**: 正確性
**場所**: ## 根本原因分析 > 発生メカニズム フロー図 ステップ3

**問題**:
commit `6deb100` で `detectMultipleChoicePrompt()` にtmux末尾空行トリム処理（L305-311）が追加された。これはIssue #188の修正の一部として、tmuxパディング空行によるスキャンウィンドウのずれを防ぐために導入されたものである。

この変更はIssue #208のバグに対して以下の影響を与える:
- **変更前**: tmuxバッファ末尾に40行以上の空行パディングがある場合、50行スキャンウィンドウ（`lines.length - 50` to `lines.length`）の大部分が空行で占められ、番号付きリストがウィンドウ外に出る可能性があった。つまり、tmuxパディングが「偶発的な防御」として機能していた
- **変更後**: effectiveEnd起点でウィンドウが計算されるため、番号付きリストが確実にウィンドウ内に収まり、誤検出がより確実に発生するようになった

Issue本文にはこの変更の影響が記載されておらず、発生メカニズムの完全性が損なわれている。

**証拠**:
```typescript
// prompt-detector.ts L305-311 (commit 6deb100 で追加)
let effectiveEnd = lines.length;
while (effectiveEnd > 0 && lines[effectiveEnd - 1].trim() === '') {
  effectiveEnd--;
}
// L314: const scanStart = Math.max(0, effectiveEnd - 50);
// 以前は: const scanStart = Math.max(0, lines.length - 50);
```

**推奨対応**:
発生メカニズムフロー図のステップ3の補足に、末尾空行トリム処理の追加（commit 6deb100）が誤検出の発生確率を上昇させた事実を追記する。

---

## Nice to Have（あれば良い）

### NTH-1: prompt-detector.tsとstatus-detector.tsの末尾空行トリム処理の類似実装

**カテゴリ**: 整合性
**場所**: ## 関連コード セクション

**問題**:
`prompt-detector.ts` L305-311 と `status-detector.ts` L122-127 の両方で、tmux末尾空行パディングのトリム処理が独立して実装されている。コードの目的は同一だが、実装方式が微妙に異なる（`effectiveEnd` 変数 vs `lastNonEmptyIndex` + `slice`）。

**証拠**:
```typescript
// prompt-detector.ts L305-311
let effectiveEnd = lines.length;
while (effectiveEnd > 0 && lines[effectiveEnd - 1].trim() === '') {
  effectiveEnd--;
}

// status-detector.ts L122-127
let lastNonEmptyIndex = lines.length - 1;
while (lastNonEmptyIndex >= 0 && lines[lastNonEmptyIndex].trim() === '') {
  lastNonEmptyIndex--;
}
const contentLines = lines.slice(0, lastNonEmptyIndex + 1);
```

**推奨対応**:
関連コードテーブルまたは補足として、両箇所の類似実装を記載する。本Issueの直接スコープ外だが、修正作業中のコード参照時に有用な情報である。

---

### NTH-2: 案1のisContinuationLine()既存改善への言及

**カテゴリ**: 完全性
**場所**: ## 対策案の方向性 > 案1

**問題**:
対策案1（構造的差異利用）で「question行の検出条件を厳格化」と記載されているが、Issue #188の追加修正で既に`isContinuationLine()`に`?`終端除外ロジックが追加されている事実への言及がない。これは案1の実装時の出発点として有用な参照情報である。

**証拠**:
```typescript
// prompt-detector.ts isContinuationLine() 内
const hasLeadingSpaces = /^\s{2,}[^\d]/.test(rawLine) && !line.endsWith('?');
// ?終端行はcontinuation lineとして扱われないため、question行として検出対象に残る
```

**推奨対応**:
案1の詳細に、`isContinuationLine()`の`?`終端除外ロジックが既にquestion行検出を改善している点を補足する。

---

## 新規マージコミットの影響分析

### commit 6deb100: fix(prompt-detector): strip trailing empty lines before scan window computation

**マージ元**: PR #210 (feature/188-worktree)
**マージ先**: main
**影響**: Issue #208のバグの発生確率を上昇させる方向に作用

| 影響項目 | 詳細 |
|---------|------|
| **行番号シフト** | prompt-detector.ts内のPass 1 / Pass 2 / Layer 3-5の行番号が+8行シフト |
| **バグ発生確率** | tmuxパディング空行による「偶発的防御」が排除され、番号付きリストがスキャンウィンドウ内に確実に収まるようになったため、誤検出の発生確率が上昇 |
| **防御層分析への影響** | 新しい防御層の追加ではないため、「各防御層の分析」テーブル自体の変更は不要。ただし、スキャンウィンドウの精度向上が誤検出の安定化に寄与する旨の補足が望ましい |

---

## 総合評価

Issue #208は2回のイテレーション（Stage 1-4）を経て、根本原因分析、影響範囲、テスト対象、対策案の方向性が網羅的に記載された高品質なバグ報告となっている。

Stage 1およびStage 3の全指摘事項（MF 2件、SF 7件、NTH 5件）が適切に反映されていることを確認した。

今回の2回目レビューで検出された新規指摘は、主にcommit `6deb100`（PR #210マージ）によるprompt-detector.tsの変更に起因するものであり、Issue本文の根本的な正確性には影響しない。MF-1（行番号シフト）は事実確認レベルの修正、SF-1（末尾空行トリムの影響）は分析の精度向上のための追記である。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/prompt-detector.ts` L299-449: detectMultipleChoicePrompt()全体（末尾空行トリムL305-311含む）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/cli-patterns.ts` L218-225: buildDetectPromptOptions()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/auto-yes-manager.ts` L317: detectPrompt()呼び出し
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/status-detector.ts` L122-127: 末尾空行トリム（類似実装）、L134-135: detectPrompt()呼び出し
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/src/lib/response-poller.ts` L95-101, L297-310, L486-498, L606-629: detectPrompt関連呼び出し

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/CLAUDE.md`: Issue #188追加修正セクション
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/dev-reports/design/issue-193-multiple-choice-prompt-detection-design-policy.md`: requireDefaultIndicator設計根拠
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-208/dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md`: 2パス検出方式の設計根拠
