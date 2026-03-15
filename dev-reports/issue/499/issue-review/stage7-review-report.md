# Issue #499 レビューレポート（Stage 7）

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2
**ステージ**: 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

**総合品質**: very_good

Stage 3の全8件の指摘が適切に反映されており、Issue本文は実装開始可能な品質に達している。新たなmust_fixレベルの問題は発見されなかった。

---

## 前回指摘（Stage 3）の対応状況

| ID | タイトル | 状態 |
|----|---------|------|
| F3-001 | Item 3のキャッシュ影響未記載 | resolved |
| F3-002 | Item 5のUI側stopReasonハンドリング不足 | resolved_with_concerns |
| F3-003 | テストファイル影響の未特定 | resolved |
| F3-004 | detectPrompt呼び出し元スコープ | resolved |
| F3-005 | Thinking間隔+期限切れ検出遅延 | resolved |
| F3-006 | キャッシュTTL変更の影響範囲 | resolved |
| F3-007 | stopPattern設定時の5000行維持根拠 | resolved |
| F3-008 | stripBoxDrawingテスト手法 | resolved |

F3-002は対応済みだが、UI実装設計の変更に伴う新たな懸念がある（F7-001参照）。

---

## Should Fix（推奨対応）

### F7-001: Item 5のUI実装設計でstopReasonPending booleanからstopReason値保持への変更が既存ロジックに影響

**カテゴリ**: 波及効果
**場所**: Item 5 UI側の対応セクション

**問題**:
Issue本文では「setStopReasonPendingのboolean管理ではなく、stopReasonの値自体をstateに保持」する方針が記載されている。しかし現在のWorkTreeDetailRefactored.tsx (L202) はstopReasonPending: booleanで管理しており、L391の条件分岐、L784-787のuseEffect、L785のshowToast呼び出しの全てを変更する必要がある。受入条件には'consecutive_errors'のテストのみ記載されており、'stop_pattern_matched'の既存動作維持のリグレッションテストが明記されていない。

**証拠**:
- `src/components/worktree/WorktreeDetailRefactored.tsx` L202: `const [stopReasonPending, setStopReasonPending] = useState(false);`
- L391: `data.autoYes.stopReason === 'stop_pattern_matched'` -- 完全一致判定
- L785: `showToast(tAutoYes('stopPatternMatched'), 'info')` -- 現在のToast表示

**推奨対応**:
受入条件に「'stop_pattern_matched'のstopReasonが従来通り情報レベル(info)のToastで表示され、既存のi18nキー('autoYes.stopPatternMatched')が使用されることをリグレッションテストで確認」を追加する。

---

### F7-002: i18nロケールファイルが関連ファイルに記載されていない

**カテゴリ**: 影響ファイル
**場所**: 関連ファイルセクション

**問題**:
Item 5 UI側の対応(3)で「i18nに'autoYes.consecutiveErrorsStopped'等の翻訳キーを追加」と記載されているが、関連ファイルセクションにi18nロケールファイルが列挙されていない。実際に変更が必要なファイルは以下の2つ。

**証拠**:
- `locales/en/autoYes.json`: 'stopPatternMatched'キー(L25)は存在するが'consecutiveErrorsStopped'は未定義
- `locales/ja/autoYes.json`: 同様に'consecutiveErrorsStopped'は未定義

**推奨対応**:
関連ファイルの直接変更対象に以下を追加する:
- `locales/en/autoYes.json` - Item 5のconsecutiveErrorsStopped翻訳キー追加
- `locales/ja/autoYes.json` - Item 5のconsecutiveErrorsStopped翻訳キー追加

---

### F7-003: auto-yes-resolver.test.tsとauto-yes-manager-cleanup.test.tsが影響テストファイルに含まれていない

**カテゴリ**: テスト影響
**場所**: 関連ファイル > 影響を受けるテストファイル

**問題**:
影響テストファイルに4つのテストファイルが列挙されているが、以下の2つが含まれていない:
- `tests/unit/lib/auto-yes-resolver.test.ts` - Item 5の連続エラー停止がresolver動作に影響しないことの確認
- `tests/unit/auto-yes-manager-cleanup.test.ts` - 新stopReason値でのクリーンアップ動作確認

**推奨対応**:
影響テストファイルに上記2ファイルを追加する。影響が軽微な場合でも、テスト一覧に含めて明示する方が実装時の見落としを防げる。

---

## Nice to Have（あれば良い）

### F7-004: Item 5の連続エラー閾値20回の定数名に関する指針

**カテゴリ**: 後方互換性
**場所**: Item 5 対策セクション

**問題**:
既存のMAX_CONSECUTIVE_ERRORS = 5 は「バックオフ開始閾値」として使用されている。Item 5で追加する連続エラー20回の「自動停止閾値」は意味が異なるため、命名の混乱を避ける指針があると良い。

**推奨対応**:
AUTO_STOP_ERROR_THRESHOLD = 20 のような明示的な命名を推奨として追記する。

---

### F7-005: Item 2とItem 3の組み合わせ動作に関する補足

**カテゴリ**: 副作用リスク
**場所**: Item 2 対策セクション

**問題**:
Thinking検出時の5秒間隔延長と300行キャプチャ削減の組み合わせにおいて、Thinking終了後にプロンプト検出フローへ自動移行する動作パスが設計として意図されたものであることの説明がない。

**推奨対応**:
Item 2に「Thinking終了後はdetectThinking()がfalseを返し、通常のプロンプト検出フローに自動移行する。5秒間隔による検出遅延は最大5秒」旨の補足を追記する。

---

## 参照ファイル

### コード
- `src/components/worktree/WorktreeDetailRefactored.tsx`: Item 5のUI側変更対象（L202, L391, L784-787）
- `src/config/auto-yes-config.ts`: AutoYesStopReason型拡張と新定数追加の対象（L43）
- `src/lib/auto-yes-state.ts`: MAX_CONSECUTIVE_ERRORS(5)とは別の自動停止閾値定数が必要（L331）
- `locales/en/autoYes.json`: consecutiveErrorsStopped翻訳キー追加が必要（関連ファイル未記載）
- `locales/ja/autoYes.json`: consecutiveErrorsStopped翻訳キー追加が必要（関連ファイル未記載）

### テスト
- `tests/unit/lib/auto-yes-resolver.test.ts`: 影響テストファイルに未記載
- `tests/unit/auto-yes-manager-cleanup.test.ts`: 影響テストファイルに未記載
