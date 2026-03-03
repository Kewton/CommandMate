# Architecture Review Report: Issue #391 Stage 4 Security Review

## Executive Summary

| 項目 | 値 |
|------|-----|
| **Issue** | #391 |
| **Stage** | 4 - セキュリティレビュー |
| **対象** | エージェント選択チェックボックスの自動リチェック修正 設計方針書 |
| **ステータス** | **承認 (Approved)** |
| **スコア** | 5/5 |
| **セキュリティリスクレベル** | Low |
| **Must Fix** | 0件 |
| **Should Fix** | 0件 |
| **Nice to Have** | 3件 |

本修正はクライアントサイドの状態管理ロジック（`isEditing`フラグ + `selectedAgentsRef`同一値チェック）のみの変更であり、サーバーサイドのセキュリティ境界には一切影響しない。OWASP Top 10の全評価項目でpass判定とした。

---

## 1. OWASP Top 10 準拠チェック

### A01: アクセス制御の不備 -- PASS

**評価観点**: isEditing状態により不正なAPI呼び出しが可能になるか

**分析結果**: isEditingはクライアントサイドのReact state（`useState(false)`）であり、サーバーサイドの認証・認可メカニズムとは完全に独立している。

- **認証ミドルウェア** (`src/middleware.ts`): PATCH `/api/worktrees/:id` へのリクエストは全てmiddlewareのトークン認証とIP制限を通過する。isEditing状態はこのフローに一切関与しない。
- **worktreeID検証** (`src/lib/auto-yes-manager.ts`): PATCH APIは`isValidWorktreeId()`（パターン: `/^[a-zA-Z0-9_-]+$/`）で入力を検証する。クライアントサイドの状態変更がこのバリデーションを迂回する経路は存在しない。
- **isEditing=true中のAPI呼び出し制御**: isEditingがtrueの間はPATCH APIが呼ばれない（チェック数が1の中間状態）。これはビジネスロジックとして正しい動作であり、不正なAPI呼び出しの抑制ではなく、不完全なデータの送信防止を目的としている。

**結論**: アクセス制御の不備は検出されなかった。

### A03: インジェクション -- PASS

**評価観点**: selectedAgents配列への不正値注入の可能性

**分析結果**: 多層防御により不正値注入リスクは排除されている。

1. **クライアントサイド**: `CLI_TOOL_IDS`定数からのみチェックボックスが生成される。DevTools等での改ざんは可能だが、サーバーサイドで防御される。
2. **PATCH API** (`src/app/api/worktrees/[id]/route.ts` L209-216): `validateSelectedAgentsInput(body.selectedAgents)`を呼び出し。
3. **バリデーションロジック** (`src/lib/selected-agents-validator.ts`):
   - `Array.isArray(input)` -- 配列であることを確認
   - `input.length !== 2` -- 要素数が正確に2であることを確認
   - `CLI_TOOL_IDS.includes(id)` -- 各要素がホワイトリスト内であることを確認
   - `input[0] === input[1]` -- 重複を排除
4. **fetch URL構築**: `worktreeId`はテンプレートリテラルで挿入されるが、サーバーサイドの`isValidWorktreeId()`（`/^[a-zA-Z0-9_-]+$/`）でパストラバーサル・インジェクションを防止。

**結論**: インジェクションリスクは検出されなかった。

### A04: 安全でない設計 -- PASS

**評価観点**: 中間状態（isEditing=true）が悪用される可能性

**分析結果**: isEditing=trueの中間状態には以下の特性がある。

- **影響範囲**: `AgentSettingsPane`コンポーネント内の`useEffect`ガード条件のみに影響。ポーリングによる`setCheckedIds`の上書きを抑制する。
- **悪用可能性**: isEditingはReact stateであり、外部（他のコンポーネント、API、サーバー）からアクセス不可。DevToolsでstateを改ざんしても、影響はUI表示のみ（チェックボックスの見た目）であり、サーバーデータに影響しない。
- **永続的な中間状態**: ユーザーがチェックを1つ外して放置した場合、isEditing=trueが継続する。しかしこの状態は(a)サブタブ切り替えによるアンマウントで自動解消、(b)ページリロードで解消される（設計方針書 S1-007, S3-005で文書化済み）。
- **セキュリティ境界への影響**: なし。サーバーサイドの認証・バリデーションはisEditing状態と独立して動作する。

**結論**: 安全でない設計パターンは検出されなかった。

### A08: ソフトウェア・データの整合性の不備 -- PASS

**評価観点**: クライアント-サーバー間のデータ整合性

**分析結果**:

- **案A（isEditingフラグ）**: 中間状態中のサーバー同期抑制は意図的な設計判断。API成功時に`setCheckedIds(new Set(pair))`で確定値を設定し（S1-002）、直後に`setIsEditing(false)`で同期を再開する。API失敗時はサーバー値（`selectedAgents` prop）にリバートする。
- **案B（同一値チェック）**: `selectedAgentsRef.current`との要素順序込み比較により、同一値の場合は`setSelectedAgents`をスキップ。これは参照同一性の問題を解決するものであり、データ整合性を損なわない。
- **二重防御**: 案A+B の組み合わせにより、中間状態保護と不要更新防止の両方を実現。どちらか一方が想定外の動作をしても、もう一方で補完される。

**結論**: データ整合性の不備は検出されなかった。

---

## 2. クライアントサイドセキュリティ分析

### 2-1. isEditing状態によるUI操作

| 攻撃シナリオ | 影響 | 防御メカニズム |
|-------------|------|--------------|
| DevToolsでisEditingをtrueに固定 | ポーリング同期が停止（UI表示のみ影響） | サーバーデータには影響なし |
| DevToolsでisEditingをfalseに固定 | 通常動作（ポーリング同期が継続） | 問題なし |
| isEditing中に別タブからPATCH API直接呼び出し | サーバーデータが更新される | PATCH APIのバリデーションで保護 |

### 2-2. selectedAgentsRef参照による情報漏洩

`selectedAgentsRef`はWorktreeDetailRefactored内のローカルref。格納される値は`CLIToolType`の配列（`['claude', 'codex']`等）であり、機密情報ではない。CLI_TOOL_IDSは公開定数として`src/lib/cli-tools/types.ts`に定義されており、漏洩リスクは存在しない。

### 2-3. ポーリング同期抑制と認証状態

isEditing中のポーリング同期抑制は`setCheckedIds`のガードのみに影響する。`fetchWorktree()`自体は引き続き実行され、認証エラー（401）が発生した場合はmiddlewareによりログインページへリダイレクトされる。ポーリング同期抑制が認証状態の不整合を引き起こすことはない。

### 2-4. XSS防止（R4-006）

設計方針書およびAgentSettingsPane実装ともに、`dangerouslySetInnerHTML`は使用されていない。全ての表示名は`getCliToolDisplayName(toolId)`の戻り値をtext nodeとしてレンダリングしている（L284: `{getCliToolDisplayName(toolId)}`）。R4-006準拠が維持される。

---

## 3. 既存セキュリティ設計との整合性

### 3-1. PATCH APIバリデーション

設計方針書の修正はPATCH APIのバリデーションロジックに一切変更を加えない。既存のバリデーションチェーンは以下の通りで、全て維持される。

```
PATCH /api/worktrees/:id
  -> isValidWorktreeId(params.id)         // worktreeIDフォーマット検証
  -> getWorktreeById(db, params.id)       // 存在確認
  -> request.json() + typeof check        // リクエストボディ検証
  -> validateSelectedAgentsInput()        // selectedAgents専用バリデーション
    -> Array.isArray + length === 2       // 型・長さ検証
    -> CLI_TOOL_IDS.includes()           // ホワイトリストバリデーション
    -> 重複チェック                       // 同一値排除
```

### 3-2. 認証ミドルウェア

`src/middleware.ts`のmatcher設定（L126-138）により、`/api/worktrees/:id`へのリクエストは認証チェックの対象となる。本修正はmiddleware.tsに変更を加えないため、整合性は完全に維持される。

### 3-3. IP制限

middleware.ts L68-78の`isIpRestrictionEnabled()`チェックは全HTTPリクエストに適用される。本修正の影響を受けない。

---

## 4. 状態の機密性分析

| 状態 | 型 | 機密性 | 外部漏洩リスク |
|------|-----|--------|-------------|
| isEditing | boolean (React state) | なし | DevToolsでのみアクセス可能。値はtrue/falseのみ |
| checkedIds | Set<CLIToolType> (React state) | なし | CLI_TOOL_IDSは公開定数 |
| selectedAgentsRef | MutableRefObject (useRef) | なし | CLIToolType配列で機密情報を含まない |
| worktreeId | string (props) | 低 | URL構築に使用されるが、サーバーサイドでバリデーション済み |

---

## 5. リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | isEditing中間状態の長期残留 | Low | Low | P3 (S3-005で自然回復パス文書化済み) |
| セキュリティリスク | 該当なし | Low | Low | N/A |
| 運用リスク | 該当なし | Low | Low | N/A |

---

## 6. 検出事項一覧

### Must Fix: 0件

なし

### Should Fix: 0件

なし

### Nice to Have: 3件

#### S4-001: isEditing中間状態と認証ミドルウェアの独立性の明記

- **OWASP**: A04
- **場所**: 設計方針書 セクション6
- **説明**: セクション6の「セキュリティ上の新規リスクはない」という記載は正確だが、認証ミドルウェアとの独立性を明示するとより堅牢なドキュメントとなる。
- **提案**: 「認証ミドルウェア（middleware.ts）はisEditing状態とは独立して動作し、PATCH APIへの全リクエストに対してトークン認証・IP制限を適用する」旨を追記。対応は任意。

#### S4-002: worktreeIdテンプレートリテラルのサーバーサイド防御確認

- **OWASP**: A03
- **場所**: 設計方針書 セクション3-1
- **説明**: `fetch(`/api/worktrees/${worktreeId}`, ...)`のテンプレートリテラル構築はクライアントサイドのインジェクションポイントだが、サーバーサイドの`isValidWorktreeId()`（`/^[a-zA-Z0-9_-]+$/`）で完全に防御されている。追加対応は不要。

#### S4-003: selectedAgents配列のクライアント-サーバー間整合性担保

- **OWASP**: A08
- **場所**: 設計方針書 セクション3-1 + `src/lib/selected-agents-validator.ts`
- **説明**: `validateSelectedAgentsInput()` + `validateAgentsPair()`によるサーバーサイドバリデーションが堅牢に設計されている。クライアントサイドの改ざんに対して十分な防御力がある。追加対応は不要。

---

## 7. 総合評価

本設計方針書はセキュリティの観点から優れた設計となっている。

**主な評価ポイント**:

1. **変更スコープの限定性**: クライアントサイドの状態管理ロジックのみの変更であり、セキュリティ境界（認証、認可、バリデーション）に一切影響しない。
2. **既存防御メカニズムの維持**: PATCH APIの`validateSelectedAgentsInput()`、`isValidWorktreeId()`、認証ミドルウェア、IP制限は全て変更なしで維持される。
3. **XSS防止**: R4-006（dangerouslySetInnerHTML禁止）が遵守されている。
4. **情報漏洩リスク**: 追加される状態（isEditing, selectedAgentsRef）に機密情報は含まれない。
5. **防御的設計**: 案A+Bの二重防御により、クライアントサイドの状態管理の堅牢性が向上する。

**承認判定**: 実装に進むことを推奨する。

---

*Review conducted: 2026-03-02*
*Reviewer: Architecture Review Agent (Stage 4 Security)*
*Design Document: dev-reports/design/issue-391-agent-checkbox-fix-design-policy.md*
