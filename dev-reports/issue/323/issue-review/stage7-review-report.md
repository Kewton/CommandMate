# Issue #323 レビューレポート (Stage 7)

**レビュー日**: 2026-02-21
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

Stage 3の影響範囲指摘IF001-IF006は全て適切に対応済み。更新後のIssue本文は、影響範囲・テスト方針・CLAUDE.md更新について具体的かつ正確な記述となっている。新たなmust_fixは検出されなかった。

---

## 前回指摘の対応状況

### IF001: テストimport変更の詳細化 -- **addressed**

**Stage 3指摘**: テストファイルの変更内容を「importブロック拡張 + describeブロック整理」に詳細化すること。

**対応確認**: 変更対象ファイルテーブルで以下の通り反映済み。
- `import対象が22個→26-30個程度に増加`（Stage 5のS2F001反映で数値も正確に修正済み）
- `checkStopCondition/processStopConditionDelta describeブロック整理`

実際のテストファイル（`tests/unit/lib/auto-yes-manager.test.ts` L2-25）のimport数を検証したところ、15関数 + 6定数 + 1型 = 22個であり、Issue記載と一致する。

---

### IF002: AutoYesPollerStateインターフェースへの影響 -- **addressed**

**Stage 3指摘**: 設計選択肢(B)でAutoYesPollerStateへのフィールド追加が必要になるか明記すること。

**対応確認**: 停止条件ロジック設計選択肢セクションに以下が追記済み。
- `既存のstopCheckBaselineLengthフィールドの再利用で十分か、追加フィールド（例: stopCheckEnabled等）が必要かを検討`
- `AutoYesPollerStateの変更は最小限に留めること`
- 変更時の波及先3箇所を明示: `globalThis.__autoYesPollerStatesの型宣言`、`startAutoYesPolling()内の初期化処理`、`tests/integration/auto-yes-persistence.test.tsのglobalThis参照テスト`

実際のコード確認: `AutoYesPollerState`（L39-54）は6フィールドを持ち、`globalThis`宣言（L125-130）、初期化（L653-661）、永続性テスト（`tests/integration/auto-yes-persistence.test.ts` L57-90）で参照されている。Issue記載の波及先は全て正確である。

---

### IF003: タイマーテスト安定性リスク -- **addressed**

**Stage 3指摘（must_fix）**: 分割関数の個別テストはタイマー非依存で記述する方針を受入条件に含めること。

**対応確認**: 以下の3箇所で対応済み。
1. **テスト方針セクション新設**: 「既存テストの維持」「分割関数の個別テスト」「processStopConditionDelta()のテスト設計」の3サブセクション
2. **受入条件**: `分割関数の個別テストはタイマー非依存（直接関数呼び出し）で記述すること`
3. **既存テスト修正方針**: `テストの修正は最小限にとどめ、テストの意図は変えないこと`

実際のコード確認: 既存テストのdelta-basedテスト（L1344-1515）は全てvi.useFakeTimers + vi.advanceTimersByTimeAsyncパターンを使用している。タイマー非依存の個別テスト方針により、これらの統合テストとの補完関係が成立する設計になっている。

---

### IF005: processStopConditionDelta()のテスト方針 -- **addressed**

**Stage 3指摘**: processStopConditionDelta()のテスト方針を事前に検討すること。同一モジュール内のcheckStopCondition()モック化の制約を考慮すること。

**対応確認**: テスト方針セクションに専用サブセクション「processStopConditionDelta() のテスト設計」が追加済み。
- ESModulesのnamed exportモック化が困難である制約を明記
- 推奨アプローチ: `checkStopCondition()をモック化せず、pollerState.stopCheckBaselineLengthの変化、checkStopConditionの副作用としてのautoYesState変更を検証する統合的な単体テスト`

実際のコード確認: checkStopCondition()（L409-442）はworktreeIdを受け取りautoYesStateを内部で操作するため、副作用（disableAutoYes呼び出し、stopAutoYesPolling呼び出し）は外部から観測可能。推奨アプローチは実現可能である。

---

### IF006: CLAUDE.md更新の受入条件化 -- **addressed**

**Stage 3指摘**: 変更対象ファイルテーブルにCLAUDE.mdを追加し、受入条件にも含めること。

**対応確認**: 以下の2箇所で対応済み。
1. **変更対象ファイルテーブル**: `CLAUDE.md | auto-yes-manager.tsモジュール説明の更新（分割関数名、設計選択結果の追記）`
2. **受入条件**: `CLAUDE.mdのauto-yes-manager.tsモジュール説明が更新されていること（分割関数名、設計選択結果の追記）`

更新内容も「分割関数名」「設計選択結果の追記」と具体的に定義されており、PRレビュー時に検証可能な粒度になっている。

---

## 新規指摘事項

### Should Fix（推奨対応）

#### S2IF001: processStopConditionDelta()テストでのpollerState生成方法が未定義

**カテゴリ**: テスト実現可能性
**場所**: テスト方針 > processStopConditionDelta() のテスト設計

**問題**:
テスト方針で「タイマー非依存（直接関数呼び出し）」を要求しているが、processStopConditionDelta()に渡すpollerStateオブジェクトの生成方法が未定義である。

現在のauto-yes-manager.tsでは、pollerStateは`startAutoYesPolling()`内（L653-661）でのみ生成され、`autoYesPollerStates` Map経由でアクセスされる。テスト側から直接pollerStateを注入する手段がない。

processStopConditionDelta()の関数シグネチャとして2つの選択肢がある:
- **(A) pollerStateを引数として受け取る**: テスト側でAutoYesPollerState型のオブジェクトリテラルを直接生成して渡せる。タイマー非依存テストが自然に記述可能。
- **(B) worktreeIdを渡してMap経由で内部取得**: startAutoYesPolling()経由での状態セットアップが必要。setTimeout副作用が伴うため、タイマー非依存の原則と矛盾する可能性がある。

Stage 3のIF007（nice_to_have）で「pollerStateは引数として受け取る」方針が推奨されていたが、現在のIssue本文では明示されていない。

**推奨対応**:
processStopConditionDelta()を含む分割関数の引数設計方針として「pollerStateを引数として受け取る」ことをIssue本文に明記すること。これにより、テスト方針セクションの「タイマー非依存テスト」要求と引数設計が整合する。

**根拠コード**:
```
// src/lib/auto-yes-manager.ts L653-661 (pollerState生成箇所)
const pollerState: AutoYesPollerState = {
  timerId: null,
  cliToolId,
  consecutiveErrors: 0,
  currentInterval: POLLING_INTERVAL_MS,
  lastServerResponseTimestamp: null,
  lastAnsweredPromptKey: null,
  stopCheckBaselineLength: -1,
};
```

---

### Nice to Have（あれば良い）

#### S2IF002: docs/implementation-history.mdへのエントリ追加が受入条件に未記載

**カテゴリ**: ドキュメント更新
**場所**: 受入条件セクション

**問題**:
Stage 3のdoc_referencesで指摘されていた`docs/implementation-history.md`の更新が受入条件に含まれていない。CLAUDE.mdの関連ドキュメントセクションに記載されている通り、各Issueの実装完了後にエントリを追加するプロジェクト慣行がある。

**推奨対応**:
受入条件に追加するか、PRレビュー時のチェック項目として記載すること。

---

#### S2IF003: E2E動作確認手順の不在

**カテゴリ**: テスト範囲
**場所**: テスト方針セクション

**問題**:
Stage 3のIF004（nice_to_have）で推奨されていた手動E2E動作確認手順（プロンプト応答、停止条件マッチ、期限切れの3パターン）がIssue本文に含まれていない。自動テストでの品質担保は十分だが、pollAutoYes()のタイミング動作は実環境でしか検証できない側面がある。

**推奨対応**:
「動作確認手順」セクションを追加し、手動テストの3パターンを記載すること。ただし、受入条件としては既存テストのパスと個別テスト追加で十分カバーされているため、あくまで追加措置としての位置付けで良い。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/auto-yes-manager.ts` | リファクタリング対象（705行、pollAutoYes L455-593 = 139行） |
| `tests/unit/lib/auto-yes-manager.test.ts` | 既存テスト（1516行、import 22個） |
| `tests/integration/auto-yes-persistence.test.ts` | globalThis永続性テスト（185行） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | 変更対象ファイルテーブルと受入条件に追加済み |
| `docs/implementation-history.md` | Issue #323エントリ追加が必要だが受入条件に未記載 |

---

## 総合評価

Issue #323の影響範囲分析は2回のレビューサイクルを経て、高い品質に達している。

**対応済み項目の評価**:
- Stage 3で指摘した5件（IF001-IF006、IF004は前回対象外）は全て適切に対応されている
- 特にIF003（must_fix: タイマーテスト安定性）はテスト方針セクションの新設と受入条件への追加で手厚く対応されており、実装ガイドとして十分な詳細度がある
- IF002のAutoYesPollerState波及先の列挙は、実際のコード（L39-54, L125-130, L653-661, auto-yes-persistence.test.ts）と正確に一致している

**残課題**:
- should_fix 1件: processStopConditionDelta()の引数設計方針（pollerStateを引数として受け取る）をIssue本文に明示すること。テスト方針の「タイマー非依存」要求と整合させるために推奨
- nice_to_have 2件: docs/implementation-history.md更新の受入条件化、E2E手動確認手順の追加

**結論**: 影響範囲は適切に特定・文書化されており、実装に進められる状態である。
