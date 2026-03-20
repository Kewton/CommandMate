# Issue #525 レビューレポート

**レビュー日**: 2026-03-20
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 2回目（Stage 5）

## 前回レビュー（Stage 1）の反映状況

| ID | カテゴリ | ステータス | 備考 |
|----|---------|----------|------|
| MF-1 | 正確性 | RESOLVED | 背景説明を非対称設計の正確な記述に修正 |
| MF-2 | 完全性 | RESOLVED | API設計方針セクション追加、GET/current-output両方の設計を明記 |
| SF-1 | 完全性 | RESOLVED | resource-cleanup.ts/session-cleanup.tsを影響範囲に追加 |
| SF-2 | 完全性 | RESOLVED | checkStopCondition()コールバック変更を実装タスクに追加 |
| SF-3 | 明確性 | RESOLVED | 既存実装の活用ポイントにAPIと状態管理間のギャップを明記 |
| SF-4 | 技術的妥当性 | RESOLVED | MAX_CONCURRENT_POLLERSリソース影響を記載 |
| NTH-1 | 完全性 | RESOLVED | スコープ外セクションでDB永続化について言及 |
| NTH-2 | 完全性 | NOT_ADDRESSED | i18n変更への言及なし（軽微） |

**評価**: Stage 1の Must Fix 2件、Should Fix 4件が全て反映済み。Issue品質は大幅に改善。

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

---

## Should Fix（推奨対応）

### SF-1: current-output APIのautoYesレスポンス形式が未決定

**カテゴリ**: 明確性
**場所**: ## 提案する解決策 > API設計方針 > current-output

**問題**:
current-output APIのautoYesレスポンスについて、2つの選択肢が併記されている。

1. `autoYes`フィールドをエージェント毎のマップ形式（`{ [cliToolId]: AutoYesState }`）に変更
2. リクエスト時の`cliToolId`パラメータに応じて該当エージェントの状態のみを返却

方式によってCLI側（`capture --json`出力）の後方互換性への影響が異なる。マップ形式にすると`CurrentOutputResponse.autoYes`の型が破壊的変更になる。

**証拠**:
- `src/cli/types/api-responses.ts` L45-49: `autoYes`は`{ enabled, expiresAt, stopReason }`の単一オブジェクト型
- `src/cli/commands/capture.ts` L17-21: `formatJson()`がautoYesを含むレスポンスをそのままJSON出力
- `current-output/route.ts` L49-50: 既に`cliTool`クエリパラメータを受け取っている

**推奨対応**:
`cliToolId`クエリパラメータで該当エージェントの状態のみを返却する方式を推奨。この方式であれば`autoYes`フィールドの形状は現行と同じ単一オブジェクトを維持でき、CLI `capture --json`の後方互換性を保てる。方針を1つに絞って明記すること。

---

### SF-2: auto-yes API POST disable時のstopAutoYesPolling複合キー対応が未記載

**カテゴリ**: 完全性
**場所**: ## 実装タスク > バックエンド > auto-yes/route.ts

**問題**:
`auto-yes/route.ts` POST時の`enabled: false`パスで`stopAutoYesPolling(params.id)`を呼んでいる箇所（L176）も複合キー化の影響を受ける。disabled時に正しいポーラーを停止するために`cliToolId`が必要だが、このdisableパスでのcliToolId解決ロジックが実装タスクに記載されていない。

**証拠**:
- `auto-yes/route.ts` L175-177: `else { stopAutoYesPolling(params.id); }` -- worktreeId単体で呼んでいる
- L156-158: `cliToolId`変数はdisable時でも参照可能（body.cliToolIdまたはデフォルト'claude'）

**推奨対応**:
POST disable時の`stopAutoYesPolling()`呼び出しを複合キー対応に修正するタスクを追加。具体的には:
1. `body.cliToolId`が指定されている場合は該当エージェントのポーラーのみ停止
2. 未指定時は`worktreeId`プレフィックスで全エージェントのポーラーを停止

---

## Nice to Have（あれば良い）

### NTH-1: 受入条件にCLI側検証の具体的手順がない

**カテゴリ**: 完全性
**場所**: ## 受入条件

**問題**:
受入条件「UIからの設定変更がCLIの`commandmate capture --json`のautoYesフィールドに反映される」は、current-output APIのレスポンス形式変更の影響を受ける。CLI側の動作確認手順が明示されていない。

**推奨対応**:
受入条件に「`capture --json`出力のautoYesフィールドが要求したcliToolIdのエージェントの状態を正しく返すこと」と具体的なCLI側検証を追記。

---

### NTH-2: incrementErrorCount()の複合キー対応が暗黙的

**カテゴリ**: 完全性
**場所**: ## 実装タスク > バックエンド > auto-yes-poller.ts

**問題**:
`incrementErrorCount()`（L187-188）が`disableAutoYes(worktreeId)`と`stopAutoYesPolling(worktreeId)`を呼んでおり、複合キー対応が必要。「全内部Map操作関数のキーを複合キーに統一」に包含されるが、エラー時の自動停止という重要な動作パスなので、明示的に言及があると実装ミスを防げる。

**推奨対応**:
`incrementErrorCount()`内の`disableAutoYes`/`stopAutoYesPolling`呼び出しの複合キー対応を明示的なサブタスクとして追記。

---

## 総合評価

Stage 1の指摘事項は全て適切に反映されており、Issue内容は大幅に改善されている。残存する指摘は Must Fix 0件、Should Fix 2件（API設計方針の曖昧さ、disable時のポーラー停止タスク欠落）、Nice to Have 2件で、いずれも実装時の詳細設計段階で解決可能なレベル。

**結論**: Issue内容は実装着手可能な品質に達している。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/auto-yes/route.ts`: POST disable時のstopAutoYesPolling複合キー対応
- `src/app/api/worktrees/[id]/current-output/route.ts`: autoYesレスポンス形式の設計判断
- `src/cli/types/api-responses.ts`: CurrentOutputResponse.autoYesの型定義（後方互換性）
- `src/cli/commands/capture.ts`: formatJson()のautoYes出力
- `src/lib/auto-yes-poller.ts`: incrementErrorCount()の複合キー対応
