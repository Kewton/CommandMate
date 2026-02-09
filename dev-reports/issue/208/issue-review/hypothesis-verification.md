# Issue #208 仮説検証レポート

## 検証日時
- 2026-02-09

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `buildDetectPromptOptions('claude')` が `{ requireDefaultIndicator: false }` を返す | Confirmed | `cli-patterns.ts:221-222` で確認 |
| 2 | Pass 1（❯インジケーター存在チェック）が完全にスキップされる | Confirmed | `prompt-detector.ts:313-329` で確認 |
| 3 | Layer 3（連番検証）は通常リストも通過する | Confirmed | `prompt-detector.ts:375-379` で確認 |
| 4 | Layer 5（question行チェック）は番号リスト上部のテキスト行で通過する | Confirmed | `prompt-detector.ts:360-373` で確認 |
| 5 | `resolveAutoAnswer()` は `multiple_choice` に対して最初の選択肢番号（"1"）を返す | Confirmed | `auto-yes-resolver.ts:23-36` で確認 |

## 詳細検証

### 仮説 1: `buildDetectPromptOptions('claude')` が `{ requireDefaultIndicator: false }` を返す

**Issue内の記述**:
> `cli-patterns.ts:207-209` の `buildDetectPromptOptions('claude')` が `{ requireDefaultIndicator: false }` を返す。

**検証手順**:
1. `src/lib/cli-patterns.ts:218-225` を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/lib/cli-patterns.ts:218-225
export function buildDetectPromptOptions(
  cliToolId: CLIToolType
): DetectPromptOptions | undefined {
  if (cliToolId === 'claude') {
    return { requireDefaultIndicator: false };
  }
  return undefined; // Default behavior (requireDefaultIndicator = true)
}
```

Claude CLIに対して明示的に `requireDefaultIndicator: false` を返している。

**Issueへの影響**: なし（仮説は正確）

---

### 仮説 2: Pass 1（❯インジケーター存在チェック）が完全にスキップされる

**Issue内の記述**:
> これにより `prompt-detector.ts` の2パス検出方式（Issue #161）における **Pass 1（❯インジケーター存在チェック）が完全にスキップ** され、番号付きリストを含むあらゆる通常出力が `multiple_choice` プロンプトとして誤検出される。

**検証手順**:
1. `src/lib/prompt-detector.ts:313-329` を確認
2. `requireDefault` が `false` の場合の挙動を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/lib/prompt-detector.ts:313-329
if (requireDefault) {
  let hasDefaultLine = false;
  for (let i = scanStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (DEFAULT_OPTION_PATTERN.test(line)) {
      hasDefaultLine = true;
      break;
    }
  }

  if (!hasDefaultLine) {
    return {
      isPrompt: false,
      cleanContent: output.trim(),
    };
  }
}
```

`requireDefault` が `false` の場合、このif文全体がスキップされ、❯インジケーターの存在チェックが行われない。

**Issueへの影響**: なし（仮説は正確）

---

### 仮説 3: Layer 3（連番検証）は通常リストも通過する

**Issue内の記述**:
> | **Layer 3** | 連番検証 | 無効 | 通常の番号付きリストも1始まり連番 |

**検証手順**:
1. `src/lib/prompt-detector.ts:375-379` を確認
2. `isConsecutiveFromOne()` の検証内容を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/lib/prompt-detector.ts:375-379
// Layer 3: Consecutive number validation (defensive measure)
const optionNumbers = collectedOptions.map(opt => opt.number);
if (!isConsecutiveFromOne(optionNumbers)) {
  return {
    isPrompt: false,
```

通常の番号付きリスト（「1. ファイルを作成」「2. テストを実行」）も1始まりの連番であるため、この検証を通過する。

**Issueへの影響**: なし（仮説は正確）

---

### 仮説 4: Layer 5（question行チェック）は番号リスト上部のテキスト行で通過する

**Issue内の記述**:
> | **Layer 5** | question行存在チェック | 無効 | 番号リスト上部にテキスト行が存在する |

**検証手順**:
1. `src/lib/prompt-detector.ts:360-373` を確認
2. question行の検出ロジックを確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/lib/prompt-detector.ts:360-373
// Non-option line handling
if (collectedOptions.length > 0 && line && !line.match(/^[-─]+$/)) {
  // Check if this is a continuation line (indented line between options,
  // or path/filename fragments from terminal width wrapping - Issue #181)
  const rawLine = lines[i]; // Original line with indentation preserved
  if (isContinuationLine(rawLine, line)) {
    // Skip continuation lines and continue scanning for more options
    continue;
  }

  // Found a non-empty, non-separator line before options - likely the question
  questionEndIndex = i;
  break;
}
```

番号リストの上部に存在する任意のテキスト行（サブエージェント完了メッセージなど）が「question行」として検出される。

**Issueへの影響**: なし（仮説は正確）

---

### 仮説 5: `resolveAutoAnswer()` は `multiple_choice` に対して最初の選択肢番号（"1"）を返す

**Issue内の記述**:
> ├─ 4. resolveAutoAnswer() → \"1\"（最初の選択肢番号）

**検証手順**:
1. `src/lib/auto-yes-resolver.ts:23-36` を確認
2. `multiple_choice` タイプの処理を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/lib/auto-yes-resolver.ts:23-36
if (promptData.type === 'multiple_choice') {
  const defaultOpt = promptData.options.find(o => o.isDefault);
  const target = defaultOpt ?? promptData.options[0];

  if (!target) {
    return null;
  }

  if (target.requiresTextInput) {
    return null;
  }

  return target.number.toString();
}
```

デフォルト選択肢が存在しない場合（❯なし形式）、`promptData.options[0]` が選択され、その番号（通常は1）が文字列として返される。

**Issueへの影響**: なし（仮説は正確）

---

## Stage 1レビューへの申し送り事項

**全仮説が Confirmed**: Issue内の根本原因分析はすべてコードベースと一致しています。

### レビュー時の重点確認ポイント

1. **背景の整合性確認**: Issue #193とIssue #161の関係性、設計意図の記載が正確か
2. **影響範囲の網羅性**: `claude`のみが影響を受けることの記載が十分か
3. **発生メカニズムの図解**: フローチャートの各ステップが実装と一致しているか
4. **対策の方向性**: 仮説が正確である以上、Issue内に解決策の示唆があるか

### 補足情報

- Issue #193で導入された `requireDefaultIndicator: false` は、Claude Codeの❯なし形式プロンプトに対応するための正当な設計判断であった
- しかし、この設定がIssue #161の主要防御（Pass 1ゲート）を無効化した副作用が、このIssueの根本原因である
- 解決には、Claude CLIとClaude Codeの区別、またはより高度なプロンプト/通常出力の判別ロジックが必要と考えられる

---

## 検証完了

- ✅ 全仮説検証完了（5件）
- ✅ すべて Confirmed
- ✅ Rejected な仮説なし
- ✅ Stage 1レビュー準備完了
