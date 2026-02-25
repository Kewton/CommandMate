# Issue #368 レビューレポート - Stage 5

**レビュー日**: 2026-02-25
**フォーカス**: 通常レビュー（2回目） - 整合性・正確性の再チェック
**イテレーション**: Stage 5（Stage 1 + Stage 3 指摘反映確認 + 新規指摘）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

**総合評価**: Stage 1の12件およびStage 3の12件、合計24件の指摘事項が**全て適切に反映**されていることを確認した。新たに特定した問題は軽微であり、Must Fixは0件。本Issueは実装着手可能な状態にある。

---

## 前回指摘事項の反映確認

### Stage 1（通常レビュー 1回目）- 全12件反映済み

| ID | 重要度 | タイトル | 反映状況 |
|----|--------|---------|---------|
| F001 | must_fix | 変更対象ファイルの網羅性不足 | **反映済み** - セクション0にハードコード箇所一覧（14箇所）を全て列挙、リファクタリング方針を追加 |
| F002 | must_fix | cli_tool_idとselected_agentsの関係性未定義 | **反映済み** - 設計方針セクションで役割・整合性ルール・自動更新動作を明記 |
| F003 | must_fix | vibe-localの技術的詳細不足 | **反映済み** - 技術調査フェーズを表形式で追加、別Issue分離の判断基準も記載 |
| F004 | should_fix | クラス名typo ViveLocalTool | **反映済み** - VibeLocalToolに修正済み |
| F005 | should_fix | ALLOWED_CLI_TOOLSの拡張方針が曖昧 | **反映済み** - ツール別方針とselected_agentsとの非連動を明記 |
| F006 | should_fix | models.ts/sidebar.tsの型定義変更漏れ | **反映済み** - 両ファイルを変更対象に追加、型変更方針を具体化 |
| F007 | should_fix | i18n翻訳ファイルの変更漏れ | **反映済み** - i18nセクションとして変更対象に追加 |
| F008 | should_fix | テスト関連の受け入れ条件欠如 | **反映済み** - テストカテゴリに6項目を追加 |
| F009 | should_fix | CLIToolManager登録の波及的影響不足 | **反映済み** - stopPollers対応等を追記 |
| F010 | nice_to_have | SESSION_NAME_PATTERNのハイフン確認 | **反映済み** - 技術的考慮事項に追記 |
| F011 | nice_to_have | CLI_TOOL_IDSの一元化リファクタリング | **反映済み** - セクション0として前提作業に組み込み |
| F012 | nice_to_have | DBマイグレーションのバージョン番号 | **反映済み** - version 18を明記 |

### Stage 3（影響範囲レビュー 1回目）- 全12件反映済み

| ID | 重要度 | タイトル | 反映状況 |
|----|--------|---------|---------|
| F301 | must_fix | switch文のdefaultフォールバック問題 | **反映済み** - 5箇所の変更内容を表形式で記載、exhaustive switchガードのコード例を掲載 |
| F302 | must_fix | sidebar.tsのcliStatus型制限 | **反映済み** - Partial<Record<CLIToolType, BranchStatus>>への変更方針を具体化、toBranchItem()の設計変更を明記 |
| F303 | must_fix | selected_agentsのJSONバリデーション | **反映済み** - parseSelectedAgents()のコード例と6つのバリデーション観点を記載 |
| F304 | should_fix | 既存テストの破損リスク | **反映済み** - 4テストファイルを変更対象に追加、CLI_TOOL_IDS.length参照推奨 |
| F305 | should_fix | selected_agents更新のAPI設計 | **反映済み** - 既存PATCH APIへの統合、サーバーサイド整合性チェック等を明記 |
| F306 | should_fix | セッション管理の副作用 | **反映済み** - UI表示のみの影響、既存セッション継続等を明記 |
| F307 | should_fix | ALLOWED_CLI_TOOLSのvibe-local対応 | **反映済み** - 4項目の考慮事項を追記 |
| F308 | should_fix | ScheduleEntry.cliToolIdの型安全性 | **反映済み** - 本Issueスコープ外として明示 |
| F309 | should_fix | APIレスポンス形式変更の影響 | **反映済み** - ハイフン付きキーのアクセス方法を技術的考慮事項に追記 |
| F310 | nice_to_have | DBマイグレーションのデフォルト値 | **反映済み** - cli_tool_idに応じた動的デフォルト値のSQL例を掲載 |
| F311 | nice_to_have | CLAUDE.md更新 | **反映済み** - ドキュメントカテゴリとして変更対象に記載 |
| F312 | nice_to_have | getToolName()のDRY共通化 | **反映済み** - 変更対象の注記として追記 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### F501: PATCH APIレスポンスがselected_agents変更後にsessionStatusByCliを返さない設計の矛盾

**カテゴリ**: 設計整合性
**場所**: 対応方針 セクション3 > selected_agents更新のAPI設計（F305）

**問題**:
Issue本文では`selected_agents`の更新をPATCH `/api/worktrees/[id]`に統合すると記載されているが、現在のPATCH APIレスポンス（`src/app/api/worktrees/[id]/route.ts` L171-180）は単一ツールの`isSessionRunning`のみを返し、`sessionStatusByCli`オブジェクトを返さない。

現行のPATCHレスポンス:
```typescript
return NextResponse.json(
  { ...updatedWorktree, isSessionRunning: isRunning },
  { status: 200 }
);
```

一方、GET APIレスポンス（L101-111）は`sessionStatusByCli`を含む。`selected_agents`を変更した直後のUIでは、新しい`selected_agents`に基づいたcliStatusが必要になるが、PATCHレスポンスにsessionStatusByCliが含まれないと、クライアント側で追加のGETリクエストが必要になる。

**推奨対応**:
Issueの「selected_agents更新のAPI設計（F305）」セクションに、PATCHレスポンスの仕様を追加する。推奨は、PATCHレスポンスは現行のまま維持し、WorktreeDetailRefactoredの既存ポーリング機構による自動更新に委任する方針。

---

#### F502: activeCliTabのデフォルト値がselected_agentsの先頭と連動すべき点が未記載

**カテゴリ**: 完全性
**場所**: 変更対象ファイル一覧 > UIコンポーネント > WorktreeDetailRefactored.tsx

**問題**:
`WorktreeDetailRefactored.tsx` L952で`activeCliTab`は`useState<CLIToolType>('claude')`でハードコード初期化されている。`selected_agents`が`['gemini', 'codex']`の場合、初期表示では`'claude'`タブがアクティブになるが、`'claude'`は`selected_agents`に含まれないため、ターミナルヘッダーに表示されないツールがアクティブになるという矛盾が生じる。

**証拠**:
```typescript
// src/components/worktree/WorktreeDetailRefactored.tsx L952
const [activeCliTab, setActiveCliTab] = useState<CLIToolType>('claude');
```

Issueの変更対象には「ハードコード配列をselectedAgents stateに置換」と記載されているが、`activeCliTab`の初期値連動については明示されていない。

**推奨対応**:
変更対象のWorktreeDetailRefactored.tsxの説明に「`activeCliTab`のデフォルト値を`selected_agents[0]`に連動させる」旨を追記する。

---

### Nice to Have（あれば良い）

#### F503: db.tsのgetLastMessagesByCliBatch()の戻り値型がハードコードされている

**カテゴリ**: 完全性
**場所**: 変更対象ファイル一覧 > CLI_TOOL_IDS ハードコード統一

**問題**:
`src/lib/db.ts` L119-122の`getLastMessagesByCliBatch()`関数の戻り値型が`{ claude?: string; codex?: string; gemini?: string }`とハードコードされている。`models.ts`の`lastMessagesByCli`を`Record<CLIToolType, ...>`に変更する場合、この関数の戻り値型も更新が必要だが、変更対象ファイル一覧の「CLI_TOOL_IDS ハードコード統一」テーブルには`src/lib/db.ts`が明示的に記載されていない。

**推奨対応**:
変更対象テーブルに`src/lib/db.ts`の`getLastMessagesByCliBatch()`戻り値型の更新を追記する。

---

#### F504: NotesAndLogsPaneのSubTab型変更の実装詳細が不足

**カテゴリ**: 明確性
**場所**: 変更対象ファイル一覧 > UIコンポーネント > NotesAndLogsPane.tsx

**問題**:
変更対象に「SubTabに`'agent'`追加」と記載されているが、現在のSubTab型は`'notes' | 'logs'`のユニオン型（L21）である。`'agent'`追加に伴う具体的な実装詳細（SubTab型の拡張、タブボタンの追加、AgentSettingsPaneの描画条件）が簡潔に記載されていると、実装者の判断コストが下がる。

**推奨対応**:
変更内容の説明を「SubTab型を`'notes' | 'logs' | 'agent'`に拡張し、`activeSubTab === 'agent'`の場合にAgentSettingsPaneを描画」に拡充する。

---

#### F505: 受け入れ基準の実装順序ガイダンスが未記載

**カテゴリ**: 明確性
**場所**: 受け入れ基準セクション全体

**問題**:
対応方針のセクション0で「CLI_TOOL_IDS ハードコード箇所の一元化リファクタリング（前提作業）」と明記されており、これが最初に実施されるべきことは読み取れる。しかし、セクション1（vibe-local追加）の技術調査フェーズとセクション2-4の関係性、実装の推奨順序が明確に記載されていると、実装計画が立てやすい。

**推奨対応**:
受け入れ基準の前または対応方針の冒頭に「推奨実装順序: 0. リファクタリング -> 1. 技術調査 -> 2. UI/DB/API（並行可能）-> 3. テスト -> 4. ドキュメント」のような簡易ガイドを追加する。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/app/api/worktrees/[id]/route.ts` - PATCH APIレスポンスの仕様（F501）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/components/worktree/WorktreeDetailRefactored.tsx` - activeCliTabのデフォルト値（F502、L952）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/lib/db.ts` - getLastMessagesByCliBatch()の戻り値型（F503、L119-122）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-368/src/components/worktree/NotesAndLogsPane.tsx` - SubTab型定義（F504、L21）

---

## 総合評価

Issue #368は4回のレビューステージを経て、非常に高品質なIssueに仕上がっている。

**強み:**
- Stage 1/Stage 3の全24件の指摘事項が漏れなく反映されている
- 対応方針が「セクション0（前提リファクタリング）-> セクション1（vibe-local追加）-> セクション2（UI）-> セクション3（DB永続化）-> セクション4（動的レンダリング）」の論理的な順序で整理されている
- 設計方針（cli_tool_id vs selected_agents）、バリデーション戦略（parseSelectedAgents）、型変更方針（sidebar.ts）等が具体的なコード例付きで記載されている
- 影響範囲が網羅的にカバーされている（変更対象ファイル35+件、既存テスト更新4件）
- 技術的リスクに対する判断基準が明確（vibe-localの別Issue分離基準、ALLOWED_CLI_TOOLSの追加基準）
- レビュー履歴が適切に記録されており、トレーサビリティが確保されている

**今回の新規指摘（should_fix: 2件、nice_to_have: 3件）は全て軽微であり、実装を阻害するものではない。** 本Issueは実装着手可能な状態にある。
