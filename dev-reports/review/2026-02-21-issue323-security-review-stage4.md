# Issue #323 セキュリティレビュー (Stage 4)

**レビュー日**: 2026-02-21
**レビュー対象**: 設計方針書 `dev-reports/design/issue-323-auto-yes-manager-refactoring-design-policy.md` (Stage 1-3反映済み)
**対象コード**: `src/lib/auto-yes-manager.ts`
**ステージ**: 4/4 (セキュリティ)

---

## 1. エグゼクティブサマリー

Issue #323の設計方針書（pollAutoYes()の責務分割リファクタリング）に対し、セキュリティ観点から6項目のレビューを実施した。

**結論**: must_fixは0件。セキュリティ面での重大なリスクは確認されなかった。既存のセキュリティ機構（WORKTREE_IDバリデーション、ReDoS防止、DoS保護）はリファクタリング後も維持される設計であり、分割によって新たな攻撃面は生じない。should_fix 1件は設計文書の補足に関するものであり、実装上のセキュリティ欠陥ではない。

| 区分 | 件数 |
|------|------|
| must_fix | 0 |
| should_fix | 1 |
| nice_to_have | 2 |

---

## 2. セキュリティチェックリスト

### 2-1. WORKTREE_ID バリデーション

**判定: PASS**

設計方針書Section 8に「`WORKTREE_ID_PATTERN` バリデーション: `startAutoYesPolling()` 内に維持（分割対象外）」と記載されている。

既存コードの検証:
- `startAutoYesPolling()` (L630): `isValidWorktreeId(worktreeId)` によるゲートウェイ検証を実施
- `WORKTREE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/` により、英数字・ハイフン・アンダースコアのみ許可
- API Route (`src/app/api/worktrees/[id]/auto-yes/route.ts` L91): `isValidWorktreeId(params.id)` による二重バリデーション
- 検証済みのworktreeIdのみが`autoYesPollerStates` Mapに登録される
- `pollAutoYes()`はMap経由でworktreeIdを取得するため、未検証IDは到達不可

分割後の新規関数（`validatePollingContext`, `captureAndCleanOutput`, `processStopConditionDelta`, `detectAndRespondToPrompt`）がworktreeIdバリデーションを行わないのは、上記のゲートウェイ設計により適切である。ただし、`@internal export`関数のJSDocに前提条件として明記すべき（SEC001参照）。

### 2-2. ReDoS防止

**判定: PASS**

設計方針書Section 3-3に「既存 `checkStopCondition(worktreeId, cleanOutput)` (L409): 正規表現パターンマッチング担当、変更なし」と記載されている。

既存コードの検証:
- `checkStopCondition()` (L409-442): `validateStopPattern()` によるsafe-regex2事前検証 + `executeRegexWithTimeout()` による実行時保護
- `validateStopPattern()` (`src/config/auto-yes-config.ts` L70-86): `MAX_STOP_PATTERN_LENGTH = 500` + `safeRegex()` + `new RegExp()` 構文検証の3層防御
- `executeRegexWithTimeout()` (L384-395): 同期実行 + try-catch（将来のWorkerスレッド実装予約）

新規関数`processStopConditionDelta()`は`checkStopCondition()`にデルタ部分のみを委譲する設計であり、新たな正規表現実行パスは追加されない。正規表現処理チェーンは以下の通り維持される:

```
API Route (validateStopPattern) -> autoYesState.stopPattern に保存
  -> processStopConditionDelta() -> checkStopCondition() -> validateStopPattern() 再検証
    -> new RegExp() -> executeRegexWithTimeout()
```

### 2-3. @internal export のアクセス制御

**判定: CONDITIONAL (SEC001)**

設計方針書Section 5に4関数の`@internal export`が記載されている。既存パターン（`checkStopCondition`, `executeRegexWithTimeout`, `clearAllAutoYesStates`, `clearAllPollerStates`）と同一の方針であり、テスト専用エクスポートとして一貫性がある。

`@internal` はTypeScriptコンパイラが強制するアクセス制御ではなく、JSDocアノテーションによる規約ベースの制限である。現行プロジェクトでは`@internal`付きexportを外部モジュールから参照している箇所はなく、規約は守られている。ただし、各関数のJSDocにworktreeIdの前提条件が明記されていない点はSEC001として指摘する。

### 2-4. 信頼境界 (cleanOutput)

**判定: PASS**

`cleanOutput`の信頼境界を分析した結果:

1. **データ源**: `captureSessionOutput()` -> tmux `capture-pane` コマンド -> `stripAnsi()` で ANSI除去
2. **使用箇所**:
   - `processStopConditionDelta()`: `cleanOutput.length` 比較 + `cleanOutput.substring()` でデルタ抽出 -> `checkStopCondition()` で正規表現マッチ
   - `detectAndRespondToPrompt()`: `detectPrompt()` でパターンマッチ -> `resolveAutoAnswer()` -> `sendPromptAnswer()`
3. **インジェクションリスク評価**:
   - コマンドインジェクション: `cleanOutput`は`exec`/`eval`/`new Function()`に渡されない。`sendPromptAnswer()`に渡されるのは`resolveAutoAnswer()`の結果（プロンプトデータからの固定パターン応答）であり、`cleanOutput`自体ではない。
   - ANSIインジェクション: `stripAnsi()`で除去済み。既知の制限（SEC-002: 8-bit CSI未対応）があるが、tmux `capture-pane`出力ではリスクは低い。
   - XSSリスク: `cleanOutput`はサーバーサイドのみで使用され、レスポンスボディに直接含まれない。

### 2-5. globalThis の状態管理

**判定: PASS**

分割後のglobalThis Map操作を分析:

- `autoYesStates` (globalThis.__autoYesStates): `validatePollingContext()` -> `getAutoYesState()` -> `disableAutoYes()` -> `autoYesStates.set()` パス。既存の`pollAutoYes()` L461-464と同一。
- `autoYesPollerStates` (globalThis.__autoYesPollerStates): `validatePollingContext()` -> `stopAutoYesPolling()` -> `autoYesPollerStates.delete()` パス。既存の`pollAutoYes()` L463と同一。

Node.jsのシングルスレッド実行モデルにおいて、`validatePollingContext()`が`'expired'`を返した場合の`pollAutoYes()`即座returnにより、削除済みstateの参照は発生しない。`processStopConditionDelta()`と`detectAndRespondToPrompt()`は`pollerState`を引数として受け取る（Map経由の再取得ではない）ため、Map操作の競合は生じない。

### 2-6. DoS保護

**判定: PASS**

設計方針書Section 8に「`startAutoYesPolling()` 内に維持（分割対象外）」と記載されている。

既存コードの検証:
- `MAX_CONCURRENT_POLLERS = 50` (L81)
- `startAutoYesPolling()` L643: `autoYesPollerStates.size >= MAX_CONCURRENT_POLLERS` チェック
- 既存pollerの再起動時はカウントに含めない設計 (L642: `existingPoller`チェック)

分割対象は`pollAutoYes()`内部のみであり、ポーラー起動・停止のエントリーポイント（`startAutoYesPolling`/`stopAutoYesPolling`）は変更されない。DoS保護は維持される。

---

## 3. 指摘事項詳細

### SEC001: @internal export関数がworktreeIdバリデーションを前提条件として明記していない

| 項目 | 内容 |
|------|------|
| **重要度** | should_fix |
| **カテゴリ** | アクセス制御 |
| **対象** | 設計方針書 Section 3-1 ~ 3-4, Section 8 |

**詳細**: 分割後の4関数（`validatePollingContext`, `captureAndCleanOutput`, `processStopConditionDelta`, `detectAndRespondToPrompt`）は`@internal export`としてテスト以外からも呼び出し可能な状態になる。これらの関数はworktreeIdの形式チェック（`isValidWorktreeId()`）を内部では行わず、`startAutoYesPolling()`のゲートウェイで検証済みであることを前提としている。

この前提条件はSection 8の1行記述のみで示されており、各関数のJSDoc（Section 3-1 ~ 3-4）には記載がない。テストコードから直接呼び出す際に、未検証のworktreeIdが渡される可能性がある（テスト時は`'test-wt'`のような安全な文字列が使用されるため実害は小さいが、セキュリティ設計の完全性として明記が望ましい）。

**提案**: Section 3-1 ~ 3-4の各関数JSDocに `@precondition worktreeId must be validated by isValidWorktreeId() prior to calling this function` を追記する。

### SEC002: cleanOutputパラメータの信頼境界に関する設計書内の明示が不足

| 項目 | 内容 |
|------|------|
| **重要度** | nice_to_have |
| **カテゴリ** | 信頼境界 |
| **対象** | 設計方針書 Section 8 |

**詳細**: Section 8は「変更なし」の3行のみであり、新規関数が受け取る`cleanOutput`パラメータの信頼境界分析が含まれていない。`cleanOutput`はtmuxバッファ由来の準信頼データであるが、正規表現マッチとパターン検出にのみ使用され、`exec`/`eval`等の動的コード実行には渡されないため、インジェクションリスクはない。この分析結果を1-2行で補足することで、将来のレビューアーへの有用な情報となる。

### SEC003: validatePollingContext()の副作用によるglobalThis Map操作の安全性

| 項目 | 内容 |
|------|------|
| **重要度** | nice_to_have |
| **カテゴリ** | 状態管理 |
| **対象** | 設計方針書 Section 3-1 |

**詳細**: `validatePollingContext()`が`'expired'`判定時に`stopAutoYesPolling()`を呼び出し、`autoYesPollerStates.delete(worktreeId)`を実行する副作用がある。Section 3-5のコードサンプルでは`validatePollingContext()`が`'valid'`以外を返した場合に即座にreturnするため、削除済みstateの参照は発生しない。この安全性はNode.jsのシングルスレッド特性に依存しており、設計書に1行の注記があるとより堅牢な設計文書となる。

---

## 4. リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | @internal export関数への未検証worktreeId渡し | Low | Low | P3 |
| セキュリティ | cleanOutputを介したインジェクション | Low | Very Low | P3 |
| 運用リスク | globalThis Map状態の不整合 | Low | Very Low | P3 |

---

## 5. OWASP Top 10 チェック

| OWASP項目 | 該当 | 評価 |
|----------|------|------|
| A01: Broken Access Control | 部分的 | @internal exportは規約ベースのアクセス制御。TypeScriptコンパイラ強制ではないが、既存パターンに準拠しており許容範囲。 |
| A02: Cryptographic Failures | 非該当 | 暗号処理なし |
| A03: Injection | 該当 | cleanOutputは正規表現マッチのみに使用。exec/eval不使用。コマンドインジェクションリスクなし。 |
| A04: Insecure Design | 非該当 | 既存セキュリティ機構を維持する設計 |
| A05: Security Misconfiguration | 非該当 | 設定変更なし |
| A06: Vulnerable Components | 非該当 | 新規依存追加なし |
| A07: Auth Failures | 非該当 | 認証処理なし（ローカルツール） |
| A08: Data Integrity Failures | 非該当 | デシリアライゼーション処理なし |
| A09: Security Logging | PASS | console.warn/console.infoによるログ出力を維持。worktreeId以外の機密情報はログに含まれない。 |
| A10: SSRF | 非該当 | 外部リクエスト発行なし |

---

## 6. 承認ステータス

**ステータス**: conditionally_approved

**条件**: SEC001（@internal export関数のJSDocに前提条件を追記）の対応を推奨する。ただし、実装上のセキュリティ欠陥ではないため、実装者の判断で省略可能。

**スコア**: 4.5/5

---

## 7. レビュー対象ファイル

| ファイル | レビュー内容 |
|---------|------------|
| `dev-reports/design/issue-323-auto-yes-manager-refactoring-design-policy.md` | 設計方針書全体のセキュリティ観点レビュー |
| `src/lib/auto-yes-manager.ts` | 既存実装のセキュリティ機構確認 |
| `src/config/auto-yes-config.ts` | ReDoS防止（validateStopPattern, safe-regex2）確認 |
| `src/lib/prompt-key.ts` | generatePromptKey()のセキュリティ注記確認 |
| `src/lib/prompt-answer-sender.ts` | sendPromptAnswer()の入力データフロー確認 |
| `src/lib/cli-patterns.ts` | stripAnsi()のセキュリティ制限確認 |
| `src/lib/cli-session.ts` | captureSessionOutput()の信頼境界確認 |
| `src/lib/cli-tools/base.ts` | getSessionName()のvalidateSessionName()確認 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | API Routeのバリデーション層確認 |
| `src/lib/session-cleanup.ts` | stopAutoYesPolling()のインポート確認 |
| `src/lib/tmux.ts` | sendKeys()のエスケープ処理確認 |

---

*Generated by architecture-review-agent for Issue #323*
*Stage 4: Security Review*
*Date: 2026-02-21*
