# Issue #181 Stage 2: 影響範囲レビュー結果

**レビュー日**: 2026-02-07
**Issue番号**: 181
**Issueタイトル**: fix: 複数行オプションを含むmultiple choiceプロンプトが検出されない

---

## 1. レビュー概要

Issue #181で提案されている継続行検出ロジックの拡張が、既存システムに与える影響を分析する。

---

## 2. 変更が影響するファイル・モジュール

### 2.1 直接変更対象

| ファイル | 変更内容 | 影響レベル |
|---------|---------|-----------|
| `src/lib/prompt-detector.ts` | `detectMultipleChoicePrompt()`内の継続行検出条件拡張 | 中 |

**変更箇所詳細**（L293-296付近）:
```typescript
// 現在
const hasLeadingSpaces = rawLine.match(/^\s{2,}[^\d]/) && !rawLine.match(/^\s*\d+\./);
const isShortFragment = line.length < 5 && !line.endsWith('?');
const isContinuationLine = hasLeadingSpaces || isShortFragment;

// 修正案に基づく拡張
const isPathContinuation = /^[\\/~]/.test(line) || /^[a-zA-Z0-9_-]+$/.test(line);
const isContinuationLine = hasLeadingSpaces || isShortFragment || isPathContinuation;
```

### 2.2 間接影響を受けるモジュール

| ファイル | 依存関係 | 影響 |
|---------|---------|------|
| `src/lib/auto-yes-manager.ts` | `detectPrompt()`を呼び出し | 検出精度向上によりAuto-Yes動作が改善 |
| `src/lib/response-poller.ts` | `detectPrompt()`を3箇所で呼び出し | 検出精度向上 |
| `src/lib/claude-poller.ts` | `detectPrompt()`を呼び出し | 検出精度向上 |
| `src/lib/status-detector.ts` | `detectPrompt()`を呼び出し | ステータス判定精度向上 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | `detectPrompt()`を呼び出し | クライアント向けpromptData精度向上 |
| `src/hooks/useAutoYes.ts` | promptDataを消費 | 検出結果の恩恵を受ける |

### 2.3 UIコンポーネントへの波及

| コンポーネント | 影響 |
|--------------|------|
| `PromptPanel.tsx` | 正しくpromptDataを受信可能に |
| `MobilePromptSheet.tsx` | モバイルでプロンプト表示改善 |
| `PromptMessage.tsx` | プロンプトメッセージ表示改善 |
| `MessageList.tsx` | メッセージリスト表示改善 |

---

## 3. 依存関係への影響

### 3.1 detectPrompt()の呼び出しチェーン

```
detectPrompt() [prompt-detector.ts]
    |
    +-- detectMultipleChoicePrompt() [変更対象]
    |       |
    |       +-- isContinuationLine判定 [拡張対象]
    |
    +-- [呼び出し元]
            |
            +-- auto-yes-manager.ts (pollAutoYes)
            +-- response-poller.ts (extractResponse x3)
            +-- claude-poller.ts (extractClaudeResponse)
            +-- status-detector.ts (detectStatus)
            +-- current-output/route.ts (API)
            +-- worktrees/route.ts (API)
            +-- worktrees/[id]/route.ts (API)
```

### 3.2 外部依存関係

**影響なし**: 本変更はprompt-detector.ts内部の条件分岐拡張であり、外部ライブラリやDBスキーマへの影響はない。

---

## 4. 破壊的変更の有無

### 4.1 分析結果

| 観点 | 結果 | 詳細 |
|-----|------|------|
| API互換性 | 維持 | `PromptDetectionResult`型の変更なし |
| 戻り値の型 | 維持 | 同一のinterface |
| 動作の変更 | **あり（改善）** | False Negativeの減少 |

### 4.2 破壊的変更リスク

**副作用リスク（中）**: 修正案の一部パターンは通常テキストを誤って継続行と認識する可能性がある。

#### リスクパターン分析

| 修正案パターン | リスク評価 | 理由 |
|--------------|----------|------|
| `/^[\\/~]/` (パス開始) | 低 | `/`や`~`で始まる通常テキストは稀 |
| `/^[a-zA-Z0-9_-]+$/` (ファイル名断片) | **中** | 短い単語（`test`, `data`, `Yes`等）も該当 |

**推奨**: `/^[a-zA-Z0-9_-]+$/`は「オプション行の直後に現れる場合のみ」等のコンテキスト条件を追加することでリスク軽減可能。

---

## 5. テスト範囲の妥当性

### 5.1 Issue記載のテスト範囲

Issue本文にはテストケースが明示されていない。

### 5.2 必要なテスト

| テストカテゴリ | ケース | 重要度 |
|--------------|-------|-------|
| **新規テスト** | 複数行折り返しオプションの検出 | Must |
| **新規テスト** | パス継続行（`/path/to/file`折り返し）の検出 | Must |
| **新規テスト** | ファイル名断片（`ndmate-issue-161`等）の検出 | Must |
| **回帰テスト** | Issue #161の既存テスト全パス | Must |
| **負荷テスト** | 短い単語が継続行として誤認識されないこと | Should |
| **境界テスト** | 50行ウィンドウ境界でのオプション折り返し | Should |

### 5.3 テストファイル変更

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/prompt-detector.test.ts` | 複数行オプションテストケース追加 |

---

## 6. 移行考慮

### 6.1 既存ユーザーへの影響

**影響なし**: 本変更はFalse Negativeの修正であり、既存の正常動作に影響しない。

### 6.2 設定変更

**不要**: 環境変数や設定ファイルの変更は不要。

### 6.3 マイグレーション

**不要**: DBスキーマ変更なし。

---

## 7. ドキュメント更新

### 7.1 必要な更新

| ドキュメント | 更新内容 | 必要性 |
|------------|---------|-------|
| `CLAUDE.md` | 変更ログの記載（最近の実装機能セクション） | Should |
| `dev-reports/design/issue-181-*.md` | 設計方針書の作成 | Should |

### 7.2 更新例（CLAUDE.md）

```markdown
### Issue #181: 複数行オプションプロンプト検出修正
- **問題解決**: ターミナル幅で折り返されたmultiple choiceオプションが検出されない問題を修正
- **継続行検出拡張**: パス継続（`/`始まり）とファイル名断片の検出条件を追加
- **主要コンポーネント**:
  - `src/lib/prompt-detector.ts` - isContinuationLine条件拡張
```

---

## 8. Must Fix（必須対応）

### MF-1: テスト計画の明記

**カテゴリ**: テスト範囲
**場所**: Issue本文

**問題**:
テスト計画が記載されていないため、変更の検証方法が不明確。

**推奨対応**:
以下のテスト計画セクションを追加:
```markdown
## テスト計画
- [ ] 複数行折り返しオプションの検出テスト
- [ ] パス継続行の検出テスト
- [ ] Issue #161回帰テスト確認
- [ ] 既存yes/noパターンの回帰テスト
```

### MF-2: 副作用リスクのテスト明記

**カテゴリ**: テスト範囲
**場所**: Issue本文

**問題**:
修正案の`/^[a-zA-Z0-9_-]+$/`パターンが通常テキストを誤認識するリスクに対するテストが計画されていない。

**推奨対応**:
負荷テスト/誤認識防止テストを計画に追加:
```markdown
## 負荷テスト
- [ ] 短い単語（`Yes`, `No`, `test`等）が継続行として誤認識されないこと
- [ ] 質問文が継続行として誤認識されないこと
```

---

## 9. Should Fix（推奨対応）

### SF-1: Issue #161との依存関係明記

**カテゴリ**: 依存関係
**場所**: ## 関連Issue セクション

**問題**:
Issue #161への参照はあるが、依存関係の詳細が不明確。

**推奨対応**:
```markdown
## 関連Issue
- #161 (Auto-Yes誤検出修正) - 本Issueの継続行検出ロジック（L293-295）はIssue #161で導入された
- #180 (ステータス表示の不整合) - 同じくプロンプト検出ロジックの問題を報告
```

### SF-2: Issue #180との関連性詳細化

**カテゴリ**: 依存関係
**場所**: ## 関連Issue セクション

**問題**:
Issue #180は「プロンプト検出の範囲が広すぎる」問題であり、本Issueは「プロンプト検出が狭すぎる」問題。両者は相反するベクトルを持つ修正であり、同時に対応する場合はバランス調整が必要。

**推奨対応**:
Issue #180との関係性を詳細化:
```markdown
- #180 (ステータス表示の不整合)
  - 問題: 過去のプロンプトを誤検出（False Positive）
  - 本Issue: 折り返しプロンプトを検出漏れ（False Negative）
  - 両者のバランスに注意（同時修正時は相互影響を確認）
```

### SF-3: 50行ウィンドウとの相互作用

**カテゴリ**: 影響分析
**場所**: Issue本文

**問題**:
`detectMultipleChoicePrompt()`は50行ウィンドウ（L237）を使用しているが、長いオプションが複数行に渡る場合、ウィンドウ境界での動作が不明確。

**推奨対応**:
50行ウィンドウとの相互作用を記載:
```markdown
## 考慮事項
- 50行スキャンウィンドウ境界での複数行オプション検出
- オプションテキストが極端に長く、50行を超える場合の動作
```

---

## 10. Nice to Have（あれば良い）

### NTH-1: パフォーマンス影響の記載

**カテゴリ**: 影響分析
**場所**: Issue本文

**問題**:
正規表現パターン追加によるパフォーマンス影響が不明。

**推奨対応**:
```markdown
## パフォーマンス考慮
- 追加正規表現（2パターン）はアンカー付きで軽量
- 既存の50行ウィンドウ内での実行のため影響軽微
```

### NTH-2: セキュリティ考慮（ReDoS）

**カテゴリ**: 影響分析
**場所**: Issue本文

**問題**:
Issue #161設計書ではReDoS安全性を確認していたが、本Issueの追加パターンについては未確認。

**推奨対応**:
```markdown
## セキュリティ考慮
- `/^[\\/~]/`: アンカー付き、ReDoS安全
- `/^[a-zA-Z0-9_-]+$/`: アンカー付き、単純な文字クラス、ReDoS安全
```

---

## 11. 参照ファイル

### 影響を受けるコード
| ファイル | 依存タイプ | 影響レベル |
|---------|----------|----------|
| `src/lib/prompt-detector.ts` | 直接変更 | 高 |
| `src/lib/auto-yes-manager.ts` | 呼び出し元 | 中 |
| `src/lib/response-poller.ts` | 呼び出し元 | 中 |
| `src/lib/claude-poller.ts` | 呼び出し元 | 中 |
| `src/lib/status-detector.ts` | 呼び出し元 | 中 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | API呼び出し元 | 中 |
| `src/hooks/useAutoYes.ts` | データ消費者 | 低 |

### 影響を受けるテスト
| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/prompt-detector.test.ts` | テストケース追加必須 |

### 参照ドキュメント
| ファイル | 参照理由 |
|---------|---------|
| `dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md` | 継続行検出ロジックの設計背景 |

---

## 12. サマリー

### 影響範囲評価

| 領域 | 影響レベル | コメント |
|-----|----------|---------|
| 直接変更ファイル | 1ファイル | prompt-detector.tsのみ |
| 間接影響ファイル | 7ファイル | 呼び出し元全て |
| 破壊的変更 | なし | API互換性維持 |
| テスト影響 | 追加必要 | 新規テストケース必須 |
| ドキュメント | 更新推奨 | CLAUDE.md、設計書 |

### 主な指摘事項

1. **Must**: テスト計画を明記し、検証可能性を確保
2. **Should**: Issue #180/#161との関連性を詳細化し、相互影響を考慮
3. **Nice**: パフォーマンス・セキュリティ考慮を記載

### 推奨事項

本Issueは影響範囲が明確で、破壊的変更もないため、実装は比較的安全に行える。ただし、以下の点に注意:

1. **修正案の副作用テスト**: `/^[a-zA-Z0-9_-]+$/`パターンが通常テキストを誤認識しないことを確認
2. **Issue #180との同時対応**: 両者が相反するベクトル（False Positive vs False Negative）のため、バランスに注意
3. **回帰テスト**: Issue #161で追加されたテストケースが全てパスすることを確認
