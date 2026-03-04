# Architecture Review Report: Issue #402

## Executive Summary

| 項目 | 内容 |
|------|------|
| Issue | #402: detectPromptの重複ログ出力抑制 |
| Stage | 1 - 通常レビュー（設計原則） |
| Focus | 設計原則（SOLID / KISS / YAGNI / DRY） |
| Status | **Conditionally Approved** |
| Score | **4 / 5** |
| Must Fix | 0 件 |
| Should Fix | 3 件 |
| Nice to Have | 5 件 |

設計方針書は全体として高品質であり、KISS/YAGNI原則を適切に遵守した現実的な設計となっている。戻り値に影響を与えないログ専用のキャッシュという設計判断は、OCP（Open/Closed Principle）の観点からも適切である。いくつかのShould Fix指摘は主に設計方針書の記述精度に関するものであり、設計方針そのものの変更を要求するものではない。

---

## Detailed Findings

### Should Fix (3件)

#### S1-001: SRP - detectPrompt()へのログ抑制責務の追加

**カテゴリ**: SRP (Single Responsibility Principle)

**指摘内容**:

`detectPrompt()`にログ抑制キャッシュの責務が追加される。`detectPrompt()`の本来の責務は「プロンプト検出」であり、「ログ出力の重複抑制」は横断的関心事（cross-cutting concern）である。現状の設計では`detectPrompt()`関数の冒頭で末尾50行の抽出、比較、キャッシュ更新を行い、関数内の複数箇所で`isDuplicate`フラグを参照してログをガードする。これにより、プロンプト検出ロジックとログ制御ロジックが同一関数内で混在する。

ただし、この逸脱は意図的かつ合理的である。ログ抑制を別モジュールに分離する場合、`detectPrompt()`のoutputパラメータを外部に渡す必要があり、責務の境界を不必要に複雑化させる。プロジェクト内の`auto-yes-manager.ts`でもポーリング状態をモジュールスコープで管理する同様のパターンが採用されている。

**改善案**:

現時点では6行程度のインライン実装で十分であり、過度な分離はYAGNIに反する。ただし、設計方針書のD2セクションにSRP逸脱のトレードオフ根拠を1-2行で明記することを推奨する。例: 「SRP観点ではログ抑制は横断的関心事だが、output文字列への直接アクセスが必要であり、外部分離はKISS/YAGNIに反するためインライン実装を採用する」

**影響セクション**: 4. 詳細設計 > D2: detectPrompt() への組み込み

---

#### S1-002: 複数worktreeでのキャッシュ共有に関するトレードオフ記述の補強

**カテゴリ**: その他（設計トレードオフの文書化）

**指摘内容**:

モジュールスコープ変数`lastOutputTail`がプロセス全体で共有されるため、異なるworktreeからの呼び出しが相互にキャッシュを上書きする。設計方針書DC-001で「実害小：同一outputは事実上発生しない」と記載されているが、これは「異なるworktreeが同じ出力を持つことはない」という観点での記述であり、キャッシュヒット率の低下については言及が不十分である。

具体的なシナリオとして：

1. Worktree A が`detectPrompt(outputA)`を呼び出し、`lastOutputTail = tailA`に更新
2. Auto-yes-managerがWorktree B に対して`detectPrompt(outputB)`を呼び出し、`lastOutputTail = tailB`に上書き
3. 次のポーリングサイクルでWorktree A が同一の`outputA`で呼び出された場合、`tailA !== tailB`のためキャッシュミスとなる

ただし、この場合でもログが出力されるだけ（=変更前と同じ動作）であり、機能劣化は一切ない。

**改善案**:

DC-001のトレードオフ記述に「複数worktreeが同時にアクティブな場合、キャッシュヒット率は低下するが、最悪ケースでも変更前と同等のログ量に留まり、機能劣化はない」と明記することを推奨する。

**影響セクション**: 9. 設計上の決定事項とトレードオフ > DC-001

---

#### S1-008: テスト方式の記述がlogger実装と不一致

**カテゴリ**: その他（テスト設計の正確性）

**指摘内容**:

テスト設計（セクション8）で「`vi.spyOn(console, 'log')`でログ出力をキャプチャ」と記載されているが、実際の`prompt-detector.ts`のログ出力は`createLogger('prompt-detector')`で生成された構造化ロガー（`src/lib/logger.ts`）を使用しており、`console.log`を直接使用していない。このため、テスト方式の記述が実装と整合しない。

**改善案**:

テスト方式を以下に修正する:

```
vi.mock('@/lib/logger')でcreateLoggerをモックし、返却されるloggerオブジェクトの
debug/infoメソッドのspy経由で呼び出し回数を検証する。
```

**影響セクション**: 8. テスト設計 > テスト方式

---

### Nice to Have (5件)

#### S1-003: 設計方針書内の用語「ハッシュ」と実装の不整合

**カテゴリ**: 命名

設計方針書のセクション3タイトルが「方式(A) output文字列末尾ハッシュ」、mermaid図内のラベルが「lastOutputHash」となっているが、実際にはハッシュ計算を行わず文字列比較を採用している（変数名は`lastOutputTail`）。設計方針書内の用語を「末尾文字列比較」に統一し、mermaid図の`lastOutputHash`を`lastOutputTail`に修正することを推奨する。

**影響セクション**: 3. 技術選定 / 2. アーキテクチャ設計 > mermaid図

---

#### S1-004: output.split('\n')の重複呼び出し

**カテゴリ**: KISS / DRY

設計方針書D2のコード例では、キャッシュ判定用に`output.split('\n')`を行った後、既存コード（L173）でも同じ`output.split('\n')`が行われる。実装時には既存の`const lines = output.split('\n')`を関数冒頭に移動し、キャッシュ判定用の`tailForDedup`もこの`lines`から算出することで、split()の二重呼び出しを回避できる。

**影響セクション**: 4. 詳細設計 > D2: detectPrompt() への組み込み

---

#### S1-005: OCP遵守の確認（問題なし）

**カテゴリ**: OCP

D4-002制約「ログ抑制はログ出力のみに影響し、プロンプト検出ロジック自体には影響しないこと」が明記されており、既存の呼び出し元6箇所のコード変更も不要。OCP（Open/Closed Principle）は良好に遵守されている。指摘なし。

---

#### S1-006: isDuplicateガードの3箇所分散

**カテゴリ**: DRY

`if (!isDuplicate)` ガードが3箇所に分散しているが、現時点ではログ箇所が3つのみであり、過度な抽象化はKISS原則に反する。ただし、将来ログ箇所が増える場合に備え、実装時のコードコメントで留意事項を残すことを推奨する。

**影響セクション**: 4. 詳細設計 > D2: detectPrompt() への組み込み

---

#### S1-007: YAGNI遵守の確認（問題なし）

**カテゴリ**: YAGNI

方式(B) worktreeIdパラメータ追加の不採用、集約ログ方式の不採用、1エントリキャッシュへの限定、いずれもYAGNI原則に合致している。末尾50行の比較ウィンドウサイズも`detectMultipleChoicePrompt`のスキャンウィンドウと一致しており合理的。指摘なし。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 複数worktree同時使用時のキャッシュヒット率低下 | Low | Med | P3 |
| 技術的リスク | output.split()の二重呼び出しによる微小なパフォーマンスオーバーヘッド | Low | High | P3 |
| セキュリティ | キャッシュ内容はプロセスメモリ内のみ、外部非公開 | Low | Low | -- |
| 運用リスク | ログ抑制によるデバッグ情報の減少 | Low | Low | P3 |
| テストリスク | logger mockの不正確な設計によるテスト不備 | Med | Med | P2 |

---

## Design Principles Compliance Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (Single Responsibility) | Mostly Compliant | ログ抑制は横断的関心事だが、KISS/YAGNIとのトレードオフで許容。根拠を文書化推奨 (S1-001) |
| OCP (Open/Closed) | Compliant | 既存動作への影響ゼロ。戻り値不変。呼び出し元変更不要 |
| LSP (Liskov Substitution) | N/A | 継承関係なし |
| ISP (Interface Segregation) | Compliant | DetectPromptOptionsインターフェースに変更なし |
| DIP (Dependency Inversion) | N/A | 新たな依存関係の導入なし |
| KISS | Compliant | 1エントリキャッシュ、文字列比較、完全スキップ方式。いずれも最もシンプルな選択肢 |
| YAGNI | Compliant | worktreeId別キャッシュ、集約ログ、ハッシュ計算を不採用。適切なスコープ |
| DRY | Mostly Compliant | isDuplicateガード3箇所の分散は許容範囲。split()重複は実装時に解消可能 (S1-004) |

---

## Improvement Recommendations Summary

### 推奨改善項目 (Should Fix) -- 3件

1. **S1-001**: 設計方針書D2セクションにSRP逸脱のトレードオフ根拠を明記
2. **S1-002**: DC-001のトレードオフ記述に複数worktree時のキャッシュヒット率低下の影響を追記
3. **S1-008**: テスト方式の記述を`vi.spyOn(console, 'log')`から`vi.mock('@/lib/logger')`に修正

### 検討事項 (Nice to Have) -- 5件

4. **S1-003**: 設計方針書内の「ハッシュ」用語を「文字列比較」に統一
5. **S1-004**: 実装時にoutput.split('\n')の重複呼び出しを回避
6. **S1-005**: OCP遵守確認済み（指摘なし）
7. **S1-006**: isDuplicateガード分散の留意コメント追加
8. **S1-007**: YAGNI遵守確認済み（指摘なし）

---

## Approval Status

**Conditionally Approved** -- Must Fix項目はゼロ。Should Fix 3件は主に設計方針書の記述精度に関する指摘であり、実装開始を妨げるものではない。設計方針書の更新と並行して実装を進めることが可能。

---

*Reviewed by: Architecture Review Agent*
*Review date: 2026-03-03*
*Design document: dev-reports/design/issue-402-detect-prompt-log-dedup-design-policy.md*
