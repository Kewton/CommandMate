# Architecture Review Report: Issue #314 - Stage 2 整合性レビュー

## Executive Summary

| 項目 | 値 |
|------|-----|
| Issue | #314 |
| Stage | 2 - 整合性レビュー |
| レビュー日 | 2026-02-19 |
| ステータス | conditionally_approved |
| スコア | 4/5 |
| 指摘件数 | 13件 (must_fix: 3, should_fix: 6, nice_to_have: 4) |

設計方針書 `issue-314-auto-yes-stop-condition-design-policy.md` と、対象となる10の実際のソースファイルおよび4つのテストファイルを詳細に比較レビューした。設計書は全体的に実際のコードベースと高い整合性を持っており、Stage 1で指摘された設計原則の問題点が適切に反映されている。ただし、3件のmust_fix項目（AutoYesState型の拡張に伴うglobalThis型宣言の言及不足、setAutoYesEnabled呼び出し元の網羅的な特定、AutoYesToggleのオブジェクト引数パターンへの変更に伴うテスト変更対応表の不足）が確認された。

---

## 整合性チェック詳細

### 1. AutoYesState型の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| AutoYesState.enabled | boolean | `src/lib/auto-yes-manager.ts` L22-23 | 一致 |
| AutoYesState.enabledAt | number | `src/lib/auto-yes-manager.ts` L24-25 | 一致 |
| AutoYesState.expiresAt | number | `src/lib/auto-yes-manager.ts` L26-27 | 一致 |
| AutoYesState.stopPattern? | string (新規) | 未実装 | 新規追加として正確 |
| AutoYesState.stopReason? | 'expired' \| 'stop_pattern_matched' (新規) | 未実装 | 新規追加として正確 |
| globalThis型宣言 | 記載なし | `src/lib/auto-yes-manager.ts` L116-121 | **DS2-F001**: globalThis宣言の更新について設計書に記載なし |

**判定**: 型拡張の設計自体は正確だが、globalThis型宣言への影響が設計書に未記載（DS2-F001: must_fix）。

### 2. setAutoYesEnabled()の整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| シグネチャ | `(worktreeId, enabled, duration?, stopPattern?)` | `(worktreeId, enabled, duration?)` L213 | 第4引数追加は新規変更として正確 |
| enableパス | state構築にstopPatternを含む | L214-223: stopPatternなし | 新規追加として正確 |
| disableパス | disableAutoYes()に委譲 | L224-233: 直接Map操作 | 設計書の変更方針は明確 |
| auto-yes/route.ts呼び出し | 4引数呼び出し | L136: 3引数呼び出し | 変更対象として記載あり |
| テストファイル呼び出し | テスト設計に言及あり | 約15箇所のsetAutoYesEnabled呼び出し | **DS2-F002**: テスト既存呼び出しの網羅的影響未記載 |

**判定**: 設計書の変更方針は実装可能だが、テストファイルへの影響の網羅的記載が不足（DS2-F002: must_fix）。

### 3. auto-yes/route.tsの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| リクエストボディ | stopPattern?: string追加 | `body.enabled`, `body.duration`, `body.cliToolId` のみ | 新規追加として正確 |
| 空文字正規化 | `body.stopPattern?.trim() \|\| undefined` | 未実装 | 新規追加として正確 |
| バリデーション | `validateStopPattern(stopPattern)` | 未実装 | 新規追加として正確 |
| 挿入位置 | 明示的な記載なし | duration検証(L120-129)後が自然 | **DS2-F004**: 挿入位置の明示推奨 |

**判定**: 整合性は良好。バリデーション挿入位置の明示が推奨される（DS2-F004: should_fix）。

### 4. current-output/route.tsの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| autoYesレスポンス | `{ enabled, expiresAt, stopReason? }` | L128-131: `{ enabled, expiresAt }` | 1フィールド追加で実装可能 |
| stopReasonの値 | `autoYesState?.stopReason` をそのまま返却 | autoYesState取得済み(L105) | 実装容易 |
| JSDoc解釈ルール | セクション4に詳細記載 | 未実装（新規追加） | 変更対象に記載あり |

**判定**: 整合性良好。JSDoc追加の実装漏れ防止を推奨（DS2-F005: should_fix）。

### 5. AutoYesConfirmDialogの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| onConfirmシグネチャ | `(duration, stopPattern?) => void` | L27: `(duration) => void` | 引数追加として正確 |
| stopPattern useState | `useState<string>('')` | 未実装 | 新規追加として正確 |
| regexError useState | `useState<string \| null>(null)` | 未実装 | 新規追加として正確 |
| isOpenリセット useEffect | DS1-F008対応で追加 | 未実装 | 新規追加として正確 |
| validateStopPattern使用 | DS1-F002対応 | auto-yes-config.tsに未実装 | 新規追加として正確 |
| 既存テスト影響 | L119, L127, L135 | 実際のテストL119/L127/L135で引数検証 | 行番号が正確 |

**判定**: 設計書の記載は実際のコードと行番号レベルで一致しており、高い整合性。ただし空文字正規化の詳細が不足（DS2-F006: should_fix）。

### 6. AutoYesToggleの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| onToggleシグネチャ | `(params: AutoYesToggleParams) => Promise<void>` | L24: `(enabled: boolean, duration?: AutoYesDuration) => Promise<void>` | **大きな変更** |
| handleToggle | `onToggle({ enabled: false })` | L81: `onToggle(false)` | 変更が必要 |
| handleConfirm | `onToggle({ enabled: true, duration, stopPattern })` | L91: `onToggle(true, duration)` | 変更が必要 |
| テスト影響 | 「既存テスト修正」の記載あり | L45/L59/L81/L86で引数検証 | **DS2-F007**: テスト変更対応表なし |

**判定**: 破壊的変更の設計は正確だが、テスト変更の具体的対応表が不足（DS2-F007: must_fix）。

### 7. WorktreeDetailRefactoredの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| handleAutoYesToggle | オブジェクト引数パターン | L1188: positional引数 | 変更として正確 |
| fetch body | `{ enabled, cliToolId, duration, stopPattern }` | L1193: `{ enabled, cliToolId, duration }` | stopPattern追加 |
| CurrentOutputResponse | `autoYes.stopReason?` 追加 | L85-88: stopReasonなし | 新規追加として正確 |
| prevAutoYesEnabledRef | トースト重複防止用 | 未実装 | 新規追加として正確 |
| stopReason検出ロジック | fetchCurrentOutput内で検出 | L1037-1041が対象箇所 | **DS2-F008**: 挿入位置の詳細記述推奨 |

**判定**: 整合性は概ね良好。stopReason検出ロジックの挿入位置詳細を推奨（DS2-F008: should_fix）。

### 8. auto-yes-config.tsの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| MAX_STOP_PATTERN_LENGTH | `500` 定数 | 未実装（新規追加） | 既存エクスポートに影響なし |
| validateStopPattern() | 長さチェック + 構文検証 | 未実装（新規追加） | 既存エクスポートに影響なし |
| モジュールJSDoc | 言及なし | L1-8: duration settingsのみ記載 | **DS2-F009**: JSDoc更新推奨 |

**判定**: 整合性良好。新規追加であり既存コードへの影響なし。

### 9. pollAutoYes()処理フローの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| checkStopCondition挿入位置 | thinking後、プロンプト検出前 | L382-389の間に挿入 | 挿入可能な位置を正確に特定 |
| 引数 | `(worktreeId, cleanOutput)` | cleanOutput (L361) が利用可能 | 整合性あり |
| cleanOutput全体使用 | 全文照合方式 | captureSessionOutput(id, cliToolId, 5000) | **DS2-F010**: 5000がバッファサイズである点の明記推奨 |

**判定**: 整合性良好。挿入位置は実装可能かつ正確。

### 10. i18nの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| 変更対象ファイル | `locales/ja/autoYes.json`, `locales/en/autoYes.json` | 各19キー（ja/en同一構造） | ファイル構造一致 |
| 追加キー一覧 | 具体的な記載なし | - | **DS2-F011**: 翻訳キー一覧の追加推奨 |

**判定**: ファイル構造は整合しているが、追加キーの具体的一覧が設計書に不足。

---

## 内部整合性チェック

| チェック項目 | 結果 | 備考 |
|------------|------|------|
| セクション間の矛盾 | 概ね一致 | DS2-F012: validateStopPatternのエラーメッセージ言語が不明確 |
| 状態遷移図とコード設計の一致 | 一致 | disableAutoYes()のreason別遷移が正確 |
| アーキテクチャ図とレイヤー構成の一致 | 一致 | 全レイヤーの変更が図に反映済み |
| テスト設計と変更対象の一致 | 概ね一致 | checkStopCondition()のテスト方法（private関数）が不明確（DS2-F013） |
| 実装チェックリストと変更一覧の一致 | 一致 | Must Fix / Should Fix の項目が変更一覧と対応 |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | AutoYesToggleのonToggleシグネチャ変更は全呼び出し元・テストに影響する破壊的変更 | Medium | High | P1 |
| 技術的リスク | setAutoYesEnabled()の引数追加により既存テスト15箇所の検証が必要 | Medium | Medium | P2 |
| セキュリティリスク | validateStopPattern()のクライアント・サーバー共用は正規表現インジェクション防止として適切 | Low | Low | P3 |
| 運用リスク | disableAutoYes()とcheckStopCondition()の実装順序に依存関係がある | Low | Medium | P2 |

---

## 必須改善項目 (Must Fix)

### DS2-F001: globalThis型宣言の更新を設計書に明記

AutoYesStateインターフェースにstopPattern/stopReasonを追加する際、`src/lib/auto-yes-manager.ts` L116-121の `declare global` ブロック内の `Map<string, AutoYesState>` は自動的に新しいインターフェースを参照するためコード変更は不要だが、この点を設計書の変更対象セクションで明確にすべき。

### DS2-F002: setAutoYesEnabled呼び出し元の網羅的影響記載

テストファイル `tests/unit/lib/auto-yes-manager.test.ts` および `tests/integration/auto-yes-persistence.test.ts` で約15箇所の setAutoYesEnabled() 呼び出しがある。第4引数はoptionalであるため既存テストは動作するが、テスト設計セクション9にこれらの既存テストへの影響（変更不要だが確認が必要な点）を明記すべき。

### DS2-F007: AutoYesToggle.test.tsx テスト変更対応表

onToggleのオブジェクト引数パターン変更に伴い、以下のテスト行の変更が必要:
- L45: `toHaveBeenCalledWith(true, DEFAULT_AUTO_YES_DURATION)` -> `toHaveBeenCalledWith({ enabled: true, duration: DEFAULT_AUTO_YES_DURATION })`
- L59: `toHaveBeenCalledWith(true, 10800000)` -> `toHaveBeenCalledWith({ enabled: true, duration: 10800000 })`
- L81: `toHaveBeenCalledWith(false)` -> `toHaveBeenCalledWith({ enabled: false })`
- L86: `toHaveBeenCalledWith(false)` -> `toHaveBeenCalledWith({ enabled: false })`

これらの具体的対応をテスト設計セクションに追加すべき。

---

## 推奨改善項目 (Should Fix)

### DS2-F003: 実装順序の明記

disableAutoYes() -> setAutoYesEnabled()修正 -> getAutoYesState()修正 -> checkStopCondition()追加 の順序に依存関係があるため、実装チェックリストに順序を明記する。

### DS2-F004: stopPatternバリデーション挿入位置の明示

auto-yes/route.tsのPOSTハンドラ内で、duration検証ブロック（L120-129）の直後にstopPatternバリデーションを配置することを設計書に明記する。

### DS2-F005: current-output/route.ts JSDoc追加の明記

変更対象ファイル一覧の変更概要に「JSDoc API解釈ルール追加」を明記する。

### DS2-F006: onConfirm呼び出し時のstopPattern正規化

AutoYesConfirmDialogのonConfirm呼び出しで `onConfirm(selectedDuration, stopPattern.trim() || undefined)` とする正規化を設計書に明示する。

### DS2-F008: fetchCurrentOutput内stopReason検出ロジックの挿入位置詳細

WorktreeDetailRefactoredのfetchCurrentOutput() L1037-1041の箇所にstopReason検出ロジックを追加することを設計書に明記する。

### DS2-F010: captureSessionOutputバッファサイズの明記

パフォーマンス設計セクション8で、captureSessionOutput()の第3引数（5000）が文字数上限であることを明記する。

---

## 検討事項 (Nice to Have)

### DS2-F009: auto-yes-config.tsモジュールJSDoc更新

現在のJSDoc「Shared config for Auto-Yes duration settings」にバリデーション関数の記載を追加。

### DS2-F011: i18n翻訳キー具体一覧の追加

stopPattern入力ラベル、プレースホルダー、バリデーションエラー、トースト通知メッセージの翻訳キーを設計書に列挙。

### DS2-F012: validateStopPatternエラーメッセージのi18n方針決定

エラー種別コード方式（'too_long', 'invalid_syntax'）を返しUI側でi18nマッピングする方式を推奨。

### DS2-F013: checkStopCondition()のテスト方法明記

private関数のため@internal exportするか、pollAutoYes()経由の統合テストのみで検証するかの方針を明記。

---

## 承認状態

**conditionally_approved** - 3件のmust_fix項目を反映した上で次のStageに進行可能。must_fix項目は全て設計書の記載補完（具体性の向上）であり、設計方針そのものの変更は不要。

---

*Reviewed by Architecture Review Agent*
*Stage 2: 整合性レビュー - 2026-02-19*
