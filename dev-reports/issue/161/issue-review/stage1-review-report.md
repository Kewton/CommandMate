# Issue #161 Review Report - Stage 1 (通常レビュー)

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue番号 | #161 |
| Issueタイトル | auto yes 実行時、それなりの頻度で"1"が送信される |
| レビューステージ | Stage 1 - 通常レビュー（1回目） |
| フォーカスエリア | 通常（整合性・正確性） |
| レビュー日時 | 2026-02-06 |

---

## 指摘事項サマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 1 |
| should_fix | 4 |
| nice_to_have | 3 |
| **合計** | **8** |

---

## 詳細指摘事項

### 1. [must_fix] 検出条件の説明が不正確

**カテゴリ**: 正確性

**現状の記載**:
> 現在の条件: 2つ以上のオプション + ❯インジケーター

**問題点**:
Issueでは「2つ以上のオプション + ❯インジケーター」と記載されているが、実際のコード（`prompt-detector.ts:241-248`）では「2つ以上のオプション AND 少なくとも1つに❯インジケーターが存在」という条件になっている。

**実際のコード**:
```typescript
// prompt-detector.ts:241-248
const hasDefaultIndicator = options.some(opt => opt.isDefault);
if (options.length < 2 || !hasDefaultIndicator) {
  return {
    isPrompt: false,
    cleanContent: output.trim(),
  };
}
```

**修正案**:
正確な条件を記載: 「現在の条件: `options.length >= 2 AND options.some(opt => opt.isDefault)` ※isDefaultは❯インジケーターの有無で判定」

---

### 2. [should_fix] TEXT_INPUT_PATTERNSの存在が言及されていない

**カテゴリ**: 完全性

**問題点**:
`prompt-detector.ts`にはTEXT_INPUT_PATTERNSという重要な定数が存在し、これにマッチする選択肢は`requiresTextInput: true`としてマークされる。`auto-yes-resolver.ts`ではこのフラグをチェックし、自動応答をスキップする。

**実際のコード**:
```typescript
// prompt-detector.ts:169-175
const TEXT_INPUT_PATTERNS: RegExp[] = [
  /type\s+here/i,
  /tell\s+(me|claude)/i,
  /enter\s+/i,
  /custom/i,
  /differently/i,
];

// auto-yes-resolver.ts:31-33
if (target.requiresTextInput) {
  return null;
}
```

**修正案**:
「type here」「tell me」「custom」等を含む選択肢は自動応答がスキップされる点を根本原因の分析または関連コンポーネントに追記すべき。

---

### 3. [should_fix] 対策案2で提案しているthinking状態チェックは既存関数で実装可能

**カテゴリ**: 整合性

**現状の記載**:
> 対策案2: コンテキスト判定
> - Claude CLIが「thinking」状態でないことを確認

**問題点**:
`cli-patterns.ts`に`detectThinking()`関数が既に存在する（L71-93）。この関数はCLAUDE_THINKING_PATTERNを使用してthinking状態を検出できる。

**実際のコード**:
```typescript
// cli-patterns.ts:71-93
export function detectThinking(cliToolId: CLIToolType, content: string): boolean {
  // ...
  switch (cliToolId) {
    case 'claude':
      result = CLAUDE_THINKING_PATTERN.test(content);
      break;
    // ...
  }
  return result;
}
```

**修正案**:
対策案2を「既存の`detectThinking()`関数を`auto-yes-manager.ts`のポーリングループで利用する」という具体的な実装方針に更新すべき。

---

### 4. [should_fix] 対策案3の連番検証について現状の説明が不足

**カテゴリ**: 整合性

**現状の記載**:
> 対策案3: 選択肢パターンの厳密化
> - 選択肢が正確に連番（1, 2, 3...）であることを検証

**問題点**:
現在のコードでは既にnumber値をパースしているが、連番かどうかの検証は行っていない（`prompt-detector.ts:213`）。

**実際のコード**:
```typescript
// prompt-detector.ts:213
const number = parseInt(match[2], 10);
```

**修正案**:
現状で既にnumberをパースしている点を踏まえ、「連番検証ロジックを追加する」という形で対策案を具体化すべき。例: `options.every((opt, i) => opt.number === i + 1)`

---

### 5. [should_fix] optionPatternの問題点の説明を詳細化すべき

**カテゴリ**: 正確性

**現状の記載**:
```typescript
const optionPattern = /^\s*([❯ ]\s*)?(\d+)\.\s*(.+)$/;
```
> このパターンは「1. xxx」形式の通常テキスト（番号付きリスト）にもマッチする

**問題点**:
正規表現自体は正確だが、問題の本質は`[❯ ]`グループが「❯または空白」を許容しているため、空白だけでもマッチする点にある。さらに、❯がなくても2つ以上のオプションが存在すれば誤検出の可能性がある。

**修正案**:
「`[❯ ]`グループが空白文字1つでもマッチするため、通常の番号付きリストが2行以上あり、かついずれかの行の先頭に❯が含まれていると誤検出される」と具体的に説明すべき。

---

### 6. [nice_to_have] 継続行検出ロジックの言及

**カテゴリ**: 完全性

**問題点**:
`prompt-detector.ts:222-233`に継続行（インデントされた行、5文字未満の断片）を検出してスキップするロジックが存在する。これが誤検出の原因となる可能性もある。

**実際のコード**:
```typescript
// prompt-detector.ts:222-233
const hasLeadingSpaces = rawLine.match(/^\s{2,}[^\d]/) && !rawLine.match(/^\s*\d+\./);
const isShortFragment = line.length < 5 && !line.endsWith('?');
const isContinuationLine = hasLeadingSpaces || isShortFragment;

if (isContinuationLine) {
  continue;
}
```

**修正案**:
根本原因の分析に継続行スキップロジックの存在を追記すると、問題の理解が深まる。

---

### 7. [nice_to_have] スキャン範囲の拡張について言及

**カテゴリ**: 完全性

**問題点**:
`prompt-detector.ts:206`のコメントによると、スキャン範囲は当初20行から50行に拡張されている。

**実際のコード**:
```typescript
// prompt-detector.ts:205-206
// Increased from 20 to 50 to handle multi-line wrapped options
for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
```

**修正案**:
スキャン範囲が50行に拡張されており、これにより誤検出リスクが増加している可能性がある点を言及すると良い。

---

### 8. [nice_to_have] サーバー側とクライアント側の動作タイミング説明

**カテゴリ**: 明確性

**現状の記載**:
> サーバー側ポーリング（auto-yes-manager.ts）とクライアント側フック（useAutoYes.ts）の両方

**問題点**:
重複防止機構の詳細が記載されていない。

**実際のコード**:
```typescript
// auto-yes-manager.ts:56
export const POLLING_INTERVAL_MS = 2000;

// useAutoYes.ts:18
const DUPLICATE_PREVENTION_WINDOW_MS = 3000;
```

**修正案**:
サーバー側は2秒間隔でポーリング、クライアント側はサーバーが3秒以内に応答した場合はスキップするという重複防止機構がある点を明記すると問題の理解が深まる。

---

## 総合評価

Issue #161の記載内容は概ね正確であり、問題の根本原因の仮説も妥当である。特にoptionPatternが通常の番号付きリストにマッチしてしまう問題の指摘は正確。

ただし、以下の点で実際のコードとの差異や不足がある:

1. **検出条件の正確な説明**: 「2つ以上のオプション AND ❯インジケーターを持つオプションが1つ以上」
2. **TEXT_INPUT_PATTERNSによるrequiresTextInputチェックの存在**
3. **既存のdetectThinking()関数の活用可能性**

これらを踏まえると:
- **対策案2（コンテキスト判定）** は既存関数を活用する形で比較的容易に実装可能
- **対策案1（厳格なプロンプト検出）** と **対策案3（選択肢パターンの厳密化）** は有効だが、実装の詳細を詰める必要がある

---

## 推奨アクション

1. must_fix項目（1件）を修正
2. should_fix項目（4件）の修正を検討
3. nice_to_have項目（3件）は余裕があれば追記
