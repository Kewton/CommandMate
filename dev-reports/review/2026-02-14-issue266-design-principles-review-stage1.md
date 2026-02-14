# Architecture Review: Issue #266 - 設計原則レビュー (Stage 1)

| 項目 | 内容 |
|------|------|
| **Issue** | #266 ブラウザタブ切り替え時の入力クリア修正 |
| **レビュー対象** | 設計方針書 `issue-266-visibility-change-input-clear-design-policy.md` |
| **フォーカス** | 設計原則 (SOLID / KISS / YAGNI / DRY) |
| **ステージ** | Stage 1 - 通常レビュー |
| **日付** | 2026-02-14 |
| **ステータス** | **Approved** |
| **スコア** | **5 / 5** |

---

## 1. エグゼクティブサマリー

Issue #266の設計方針書は、`visibilitychange`イベントハンドラによる不要な`setLoading(true/false)`がコンポーネントツリーのアンマウント/リマウントを引き起こし、入力内容がクリアされるバグの根本原因を正確に特定している。修正方針として「軽量リカバリパターン」を提案しており、エラー状態時のみフルリカバリ(`handleRetry`)を実行し、正常時はloading状態を変更しないバックグラウンドfetchに限定する設計は、SOLID/KISS/YAGNI/DRY各原則に概ね適合している。

1件の推奨改善項目(DRY関連)を検出したが、設計書自体で意図的トレードオフとして認識・文書化されており、全体の設計品質は高い。

---

## 2. 設計原則チェックリスト

### 2-1. SOLID原則

#### Single Responsibility Principle (SRP) -- PASS

| 関数 | 責務 | 評価 |
|------|------|------|
| `handleRetry` | エラー状態からのフルリカバリ (setLoading + setError + fetch) | 単一責務を維持 |
| `handleVisibilityChange` (修正後) | バックグラウンド復帰時のデータ同期 | 単一責務に限定 |

設計書のSF-001で、`handleVisibilityChange`の責務を「バックグラウンド復帰時のデータ同期」に明確に限定している。修正前は`handleRetry()`をそのまま呼び出していたため、実質的に「エラーリカバリ」という本来別の責務を暗黙的に担っていた。修正後はエラー時と正常時で明確に分岐し、各パスの責務が明確になる。

```typescript
// 修正後: 責務の分離が明確
if (error) {
  handleRetry();     // エラーリカバリ(handleRetryの責務)
  return;
}
// 軽量リカバリ(handleVisibilityChangeの責務)
await Promise.all([fetchWorktree(), fetchMessages(), fetchCurrentOutput()]);
```

#### Open/Closed Principle (OCP) -- PASS

既存の`handleRetry()`関数に一切の変更を加えず、`handleVisibilityChange`のみにガード条件を追加する設計。既存コードの動作を保持しつつ、新しい分岐動作を追加している。代替案4(handleRetryにskipLoadingオプション追加)を明確に却下し、handleRetryの既存インターフェースを安定させている判断は適切。

#### Liskov Substitution Principle (LSP) -- N/A

本修正にクラス継承関係は存在しないため適用外。

#### Interface Segregation Principle (ISP) -- N/A

インターフェース設計の変更は含まれない。

#### Dependency Inversion Principle (DIP) -- PASS

`fetchWorktree`、`fetchMessages`、`fetchCurrentOutput`はいずれも`useCallback`で抽象化されたフック関数であり、具体的なAPI URL(`/api/worktrees/:id`等)やfetchの実装詳細から呼び出し元を分離している。依存注入のパターンとして適切。

---

### 2-2. KISS原則 -- PASS

設計書SF-002が述べる通り、修正のコアロジックは「`error`状態の有無による単純なif分岐」のみ。

```typescript
if (error) {
  handleRetry();  // フルリカバリ
  return;
}
// 軽量リカバリ
```

代替案との比較表(設計書4-3)で、より複雑な選択肢(useRef/state lift、keyプロップ、handleRetryへのオプション追加)を検討・却下し、最もシンプルな根本原因解決を選択している。特に「handleRetryにskipLoadingオプション追加」案は実現可能だが、handleRetryの責務を曖昧にするとして適切に排除している。

---

### 2-3. YAGNI原則 -- PASS

本設計は必要最小限の変更に徹底している。

**YAGNIに準拠している点:**
- 軽量リカバリ失敗時のリトライ機構を導入しない(既存ポーリングで自然回復)
- 入力状態の永続化(localStorage等)を導入しない
- MessageInputやPromptPanelへの変更を加えない(根本原因の解決で不要)
- 新しいコンポーネントや抽象レイヤーを追加しない

**変更対象ファイルが1ファイルのみ** (`WorktreeDetailRefactored.tsx`)であり、SF-003「最小変更」原則に完全に合致している。

---

### 2-4. DRY原則 -- CONDITIONAL PASS

**観察**: 修正後のコードでは、fetch3連呼び出しパターンが複数箇所に存在する。

| 箇所 | パターン |
|------|---------|
| `handleRetry` (L1450-1452) | `fetchWorktree()` -> `Promise.all([fetchMessages(), fetchCurrentOutput()])` |
| `handleVisibilityChange` (修正後) | `Promise.all([fetchWorktree(), fetchMessages(), fetchCurrentOutput()])` |
| `loadInitialData` (L1522-1526) | `fetchWorktree()` -> `Promise.all([fetchMessages(), fetchCurrentOutput()])` |
| ポーリング (L1568) | `Promise.all([fetchCurrentOutput(), fetchWorktree(), fetchMessages()])` |

設計書4-2で「DRY原則の一部緩和（handleRetryとfetch呼び出しの重複）」として明示的にトレードオフを認識・文書化している。この判断は以下の理由で妥当:

1. `handleRetry`はfetchに加えて`setError(null)`と`setLoading(true/false)`を含むため、単純な共通化は不可
2. 各呼び出し箇所でfetchの実行順序(逐次 vs 並行)や後続処理が異なる
3. 共通化のための過度な抽象化(refreshData関数等)はKISSに反する可能性がある

---

## 3. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | fetch呼び出しパターン追加時の同期漏れ | Low | Low | P3 |
| セキュリティ | なし (既存fetchの再利用のみ) | Low | Low | - |
| 運用リスク | なし (既存スロットルガード維持) | Low | Low | - |

---

## 4. 改善提案

### 4-1. 必須改善項目 (Must Fix)

なし。

### 4-2. 推奨改善項目 (Should Fix)

#### SF-DRY-001: fetch呼び出しパターンの重複に関するコメント強化

**対象**: `WorktreeDetailRefactored.tsx` の `handleVisibilityChange` (修正後)

**現状**: 設計書ではDRY緩和のトレードオフを認識しているが、実装コード内でそのことを明示するコメントがないと、将来のメンテナで重複を見た開発者が不整合を起こす可能性がある。

**推奨**: 軽量リカバリのfetch呼び出し箇所に、handleRetryとの関係性を示すコメントを追記する。

```typescript
// [SF-002] 正常時は軽量リカバリ（loading状態を変更しない）
// NOTE: handleRetry()と同じfetchを呼ぶが、setLoading/setErrorを
// 含まないため共通化せず独立して実装（DRY緩和、設計書4-2参照）
try {
  await Promise.all([
    fetchWorktree(),
    fetchMessages(),
    fetchCurrentOutput(),
  ]);
} catch {
  // 軽量リカバリ失敗時はサイレント（次回ポーリングで回復）
}
```

**重要度**: Low

### 4-3. 検討事項 (Consider)

#### C-KISS-001: 開発環境でのデバッグログ

軽量リカバリのcatchブロックでサイレント無視としているが、開発環境でのみconsole.warnを出力することで、デバッグ効率を向上できる可能性がある。ただし、現状のサイレント無視は設計判断として合理的であり、必須ではない。

#### C-YAGNI-001: リトライ機構不導入の判断を支持

軽量リカバリ失敗時にリトライ機構を導入しない判断は、既存のポーリングuseEffect(L1560-1574)が5秒/1秒間隔でデータを再取得しているため、YAGNI原則に正しく従った好例。

---

## 5. テスト設計の評価

設計書のテスト設計(セクション9)は、4つのユニットテストケースと5つの受入テストケースを定義している。

**既存テスト** (`WorktreeDetailRefactored.test.tsx` L799-1003) には、現在のhandleRetry直接呼び出しに基づく4つのテストケース(TC-1~TC-4)が存在する。修正後は以下のテスト変更が必要:

| 既存テスト | 修正後の期待動作 | 変更内容 |
|-----------|-----------------|---------|
| TC-1: visible時のデータ再取得 | `setLoading`が呼ばれずにfetch実行 | アサーション変更が必要 |
| TC-2: エラー時のvisibilitychange | `handleRetry()`呼び出し(変更なし) | テストロジック維持 |
| TC-3: hidden時の非発火 | 変更なし | テスト維持 |
| TC-4: スロットル | 変更なし | テスト維持 |

設計書のテストケース「正常時のvisibilitychangeでsetLoadingが呼ばれないこと」は、TC-1の修正版として実装可能であり、テスト設計は十分。

---

## 6. 総合評価

本設計方針書は、設計原則の観点から高い品質を示している。

| 評価項目 | 結果 | コメント |
|---------|------|---------|
| SRP | PASS | handleVisibilityChangeとhandleRetryの責務分離が明確 |
| OCP | PASS | 既存handleRetryを変更せず拡張 |
| LSP | N/A | 継承関係なし |
| ISP | N/A | インターフェース変更なし |
| DIP | PASS | useCallback抽象化による依存分離 |
| KISS | PASS | エラー有無のシンプルな分岐のみ |
| YAGNI | PASS | 1ファイル変更のみ、不要な機構の追加なし |
| DRY | Conditional PASS | 意図的トレードオフとして文書化済み |

特筆すべきは、設計書自体に設計根拠ID(SF-001, SF-002, SF-003)を付与し、代替案との比較表を含めている点。設計判断の追跡可能性が高く、将来のメンテナンスに有益。

**最終判定: Approved (5/5)**
