# Issue #288 影響範囲レビューレポート

**レビュー日**: 2026-02-17
**フォーカス**: 影響範囲レビュー（Impact Scope）
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

## 影響範囲の全体像

Issue #288 の変更は `src/components/worktree/MessageInput.tsx` の内部状態追加に限定されており、破壊的変更はない。propsインターフェースの変更がないため、親コンポーネント（`WorktreeDetailRefactored.tsx`）や関連コンポーネント（`SlashCommandSelector.tsx`）のコード修正は不要である。変更リスクは低い。

### 影響ファイルマトリクス

| ファイル | 変更種別 | リスク | 備考 |
|---------|---------|--------|------|
| `src/components/worktree/MessageInput.tsx` | 直接変更 | Low | isFreeInputMode state追加、条件分岐追加 |
| `src/components/worktree/SlashCommandSelector.tsx` | 変更なし（間接影響） | None | isOpen=falseで既存の早期リターンが機能 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 変更なし | None | propsインターフェース変更なし |
| `src/lib/standard-commands.ts` | 変更なし | None | コマンド定義に影響なし |
| `src/components/worktree/index.ts` | 変更なし | None | re-exportのみ |
| `tests/unit/components/worktree/MessageInput.test.tsx` | テスト追加必要 | -- | 新機能のテストカバレッジ |
| `tests/unit/components/SlashCommandSelector.test.tsx` | テスト追加推奨 | -- | isOpen=false時のキーイベント透過 |

---

## Should Fix（推奨対応）

### SF-1: テスト範囲の不足 - MessageInput.test.tsxにフリー入力モードのテストケースが存在しない

**カテゴリ**: テスト範囲
**場所**: 受入条件セクション / `tests/unit/components/worktree/MessageInput.test.tsx`

**問題**:
既存の `MessageInput.test.tsx` にはスラッシュコマンドセレクターの表示/非表示制御や、`handleFreeInput` 後の Enter 送信を検証するテストケースが一切存在しない。現行テストは Desktop/Mobile/IME/Accessibility/Basic rendering の 5 カテゴリのみで構成されており、すべて `showCommandSelector=false` の状態で動作検証している。

今回の修正で追加される `isFreeInputMode` フラグの動作を検証するテストがなければ、将来のリグレッション検出が不可能である。

**証拠**:
- `tests/unit/components/worktree/MessageInput.test.tsx` を全行確認: 252行、5つのdescribeブロック
- スラッシュコマンド関連テストは `SlashCommandSelector.test.tsx` に分離されているが、MessageInput との統合テスト（セレクター表示条件、フリー入力モード遷移）は存在しない

**推奨対応**:
受入条件に以下を明記する:
- 「isFreeInputModeフラグの動作を検証するユニットテストが追加されていること」

具体的に必要なテストケース:
1. `handleFreeInput` 呼び出し後にカスタムコマンド入力しても `showCommandSelector` が `false` のままであること
2. `handleFreeInput` 後に Enter キーで `submitMessage` が呼ばれること
3. メッセージ全削除後に再度 `/` 入力でセレクターが表示されること
4. `submitMessage` 後に `isFreeInputMode` がリセットされること

---

### SF-2: SlashCommandSelectorのテスト観点が影響範囲セクションに記載されていない

**カテゴリ**: 影響ファイル
**場所**: 影響範囲セクション

**問題**:
Issue の影響範囲セクションでは変更対象を `MessageInput.tsx` のみとし、`SlashCommandSelector.tsx` は「変更不要」としている。これは正しいが、`SlashCommandSelector.tsx` のグローバル keydown リスナー（L93-121, L124-129）の動作が `isFreeInputMode` の有無で間接的に変わる点について、テスト観点での影響が記載されていない。

`SlashCommandSelector.test.tsx` を確認すると、フリー入力モード遷移後のキーボードナビゲーションテスト（Enter/ArrowDown/ArrowUp）が含まれておらず、`isOpen=false` 時にグローバルリスナーが Enter イベントを消費しないことの検証がない。

**証拠**:
- `SlashCommandSelector.tsx` L93-121: `handleKeyDown` 内で `if (!isOpen) return;` により `isOpen=false` 時は早期リターンする
- `SlashCommandSelector.tsx` L124-129: `addEventListener` は `isOpen` の値に関係なく常に登録されている
- `SlashCommandSelector.test.tsx` L203-217: `isOpen=true` 時の Escape キーテストのみ。`isOpen=false` 時の Enter キー透過テストは未存在

**推奨対応**:
影響範囲セクションの関連コンポーネントに以下のテスト観点を追加する:
- 「`SlashCommandSelector.test.tsx` に `isOpen=false` 時にグローバル keydown リスナーが Enter イベントを消費しないことを検証するテストケースの追加を推奨」

---

## Nice to Have（あれば良い）

### NTH-1: propsインターフェース非変更の明記

**カテゴリ**: 移行考慮
**場所**: 影響範囲セクション

**問題**:
`isFreeInputMode` は `useState<boolean>` で管理される内部状態であり、props やコンテキスト経由で外部に公開されない。そのため `WorktreeDetailRefactored.tsx` やその他親コンポーネントへの破壊的変更は発生しない。この点は Issue 本文で明示されていないが、レビューアが安心できる情報として記載があると望ましい。

**推奨対応**:
影響範囲セクションに「`MessageInput` の props インターフェース（`MessageInputProps`）に変更なし。`isFreeInputMode` は内部状態のため、親コンポーネント（`WorktreeDetailRefactored.tsx` Desktop: L1802-1808, Mobile: L2038-2043）への破壊的変更なし」と明記する。

---

### NTH-2: CLAUDE.mdへのモジュール記載追加

**カテゴリ**: ドキュメント更新
**場所**: CLAUDE.md

**問題**:
CLAUDE.md の主要機能モジュール一覧に `MessageInput.tsx` や `SlashCommandSelector.tsx` の記載がない。今回の修正で `isFreeInputMode` という新たな状態管理パターンが追加されるため、将来のメンテナンスを考慮すると CLAUDE.md への追記が望ましい。

**推奨対応**:
CLAUDE.md の主要機能モジュール一覧に `src/components/worktree/MessageInput.tsx` のエントリ追加を検討する。

---

### NTH-3: e2eテストカバレッジの将来的な拡大

**カテゴリ**: テスト範囲
**場所**: `tests/e2e/worktree-detail.spec.ts`

**問題**:
e2e テスト（`tests/e2e/worktree-detail.spec.ts`）には MessageInput の存在確認とテキスト入力のテストのみ存在し、スラッシュコマンドセレクターとの統合 e2e テストは含まれていない。フリー入力モードの e2e テスト追加は本 Issue 範囲外だが、将来的なカバレッジ拡大の検討材料として認識しておくべき。

**推奨対応**:
今回のスコープ外として問題ないが、将来の Issue として「スラッシュコマンド操作の e2e テスト追加」を検討する。

---

## 破壊的変更の分析

**結論: 破壊的変更なし**

| 観点 | 評価 | 詳細 |
|------|------|------|
| Props インターフェース | 変更なし | `MessageInputProps` に追加/変更なし |
| コンポーネント公開 API | 変更なし | `src/components/worktree/index.ts` の export に影響なし |
| 依存ライブラリ | 追加なし | 新規 npm パッケージ不要 |
| DB スキーマ | 影響なし | フロントエンドのみの変更 |
| API エンドポイント | 影響なし | バックエンド変更なし |
| 既存テスト | 破壊なし | 既存テストは全て通過する見込み |

---

## 依存関係の分析

```
WorktreeDetailRefactored.tsx
  └── MessageInput.tsx  [変更対象]
        ├── SlashCommandSelector.tsx  [変更なし / 間接影響あり]
        │     └── SlashCommandList.tsx  [影響なし]
        ├── InterruptButton.tsx  [影響なし]
        ├── useSlashCommands.ts  [影響なし]
        ├── useIsMobile.ts  [影響なし]
        └── api-client.ts (worktreeApi)  [影響なし]
```

`MessageInput.tsx` への変更は内部状態の追加のみであり、上流（`WorktreeDetailRefactored.tsx`）および下流（`SlashCommandSelector.tsx`）への伝播は発生しない。

---

## 参照ファイル

### コード
- `src/components/worktree/MessageInput.tsx`: 変更対象ファイル。L37, L66-83, L132-135, L141-148, L153-163, L192
- `src/components/worktree/SlashCommandSelector.tsx`: 間接影響ファイル。L93-121, L124-129, L131-133
- `src/components/worktree/WorktreeDetailRefactored.tsx`: MessageInput利用箇所。L1802-1808, L2038-2043

### テスト
- `tests/unit/components/worktree/MessageInput.test.tsx`: 既存テスト（フリー入力モードのテスト未存在）
- `tests/unit/components/SlashCommandSelector.test.tsx`: 既存テスト（isOpen=false時のキーイベントテスト未存在）
- `tests/e2e/worktree-detail.spec.ts`: e2eテスト（スラッシュコマンド統合テスト未存在）

### ドキュメント
- `CLAUDE.md`: プロジェクトガイドライン（MessageInput.tsxの記載なし）
