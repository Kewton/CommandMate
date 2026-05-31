# Issue #739 設計方針書 — removeSplit width 再正規化

**Issue**: fix(terminal): removeSplit fails to re-normalize widths, leaving 50% empty space (#728 follow-up)
**種別**: bug fix（#728 follow-up）
**作成日**: 2026-05-31
**対象モジュール**: `src/hooks/useTerminalSplits.ts`（PC専用）

---

## 1. 問題と根本原因

PC ターミナル分割（#728）で `+Split` → `-Split` と戻すと、ターミナルが container の 50% 幅のまま残り右半分が空きスペースになる。

| 原因 | 箇所 | 内容 |
|------|------|------|
| ① removeSplit 非正規化 | `useTerminalSplits.ts:129-136` | 末尾 width を slice するだけ。`[0.5,0.5]`→`[0.5]`（sum=0.5） |
| ② Flexbox 仕様 | `TerminalSplitContainer.tsx:188-194` | `flex-grow` 合計<1 のとき free space を割合分しか配分しない（`flex-basis:0`） |
| ③ 永続化された不正状態 | `useTerminalSplits.ts:77-83` / `terminal-split-config.ts:62-82` | `widthsValid`/`isValidSplitConfig` は各要素>0のみ検証、合計=1.0 を検証しない → 不正 `[0.5]` が localStorage に残存・リロードで再現 |

（全 Issue Review Phase 0.5 で Confirmed 済み）

---

## 2. 設計目標

1. `removeSplit` 後、残った widths の合計が常に 1.0（比率を保持して再正規化）。
2. 既存ユーザーの localStorage に残った不正状態（sum≠1.0）をロード時に自己回復。
3. `widthsValid` / `isValidSplitConfig` の**仕様は変更しない**（後方互換：不正値を拒否ではなく正規化で吸収）。
4. 既存テスト・既存挙動（addSplit, setSplitWidth, PaneResizer, CLI選択保持, focus clamp）に回帰を出さない。

---

## 3. 採用する設計

### 3.1 `normalizeWidths` ヘルパー（純関数）

```ts
function normalizeWidths(widths: number[]): number[] {
  const sum = widths.reduce((s, w) => s + w, 0);
  // フォールバックは「長さ保存（等分）」。length=1固定だと多要素で
  // widths.length === splits.length 不変条件を破りうるため（S1-001）。
  return sum > 0
    ? widths.map(w => w / sum)
    : widths.map(() => 1 / widths.length);
}
```

- 純関数。`useTerminalSplits` 内モジュールスコープに配置（`widthsValid` 等の既存ヘルパーと同階層）。
- 入力 mutate なし（新配列を返す）。

### 3.2 `removeSplit` で再正規化

```ts
const removeSplit = useCallback(() => {
  setConfig(prev => {
    if (prev.splits.length <= MIN_SPLITS) return prev;
    const splits = prev.splits.slice(0, -1);
    const widths = normalizeWidths(prev.widths.slice(0, -1));
    return { splits, widths };
  });
}, []);
```

### 3.3 ロード時の自己回復（`readInitialState`）

`isValidSplitConfig(parsed)` を**通過した後**、`parsed` を直接返さず正規化コピーを返す:

```ts
if (isValidSplitConfig(parsed)) {
  return { ...parsed, widths: normalizeWidths(parsed.widths) };
}
```

- `parsed` を mutate しない（S1-002）。
- 有効 config（sum=1.0）に対しては no-op（`w/1.0 === w`、浮動小数点誤差のみ）。
- 不正 `[0.5]`（valid 判定を通る）→ `[1]` に回復。
- 次の persist effect が回復後の値を書き戻し、永続的に自己修復。

### 3.4 addSplit は変更なし

`lastWidth/2 + lastWidth/2 = lastWidth` で合計保存済み（Confirmed）。

---

## 4. 検討した代替案

| 代替案 | 不採用理由 |
|--------|-----------|
| `widthsValid`/`isValidSplitConfig` を sum=1.0 検証に変更し不正値を拒否 | 既存の有効状態を破壊し DEFAULT に落とすため UX 劣化。後方互換性のため正規化吸収を選択（スコープ外と明記） |
| Container 側で render 時に grow を正規化 | 状態は不正なまま。永続化された不正値が残り、複数 consumer で重複ロジック化 |
| `flex-basis` を `%` 指定に変更 | CSS 構造変更で #728 のリサイズ挙動全体に波及。リスク大 |

→ **状態（hook）側で正規化**するのが単一責任・最小波及。

---

## 5. テスト戦略（TDD）

回帰テストを `tests/unit/hooks/useTerminalSplits.test.ts` に追加:

1. `removeSplit` 後に `widths.reduce(sum)` が **≈ 1.0**（3→2→1 各段階で）。
   - **浮動小数点注意（設計レビュー S3-001 / Should Fix）**: 正規化後の IEEE754 合計は厳密に `1.0` とは限らない（例: `[0.123,0.456]` 正規化で `1.0000000000000002`）。テストは `expect(sum).toBeCloseTo(1)` を用い、`=== 1.0` / `toBe(1.0)` は使わない。
2. removeSplit が**比率を保持**（例: `[0.6,0.3,0.1]` から末尾除去 → `[0.6/0.9, 0.3/0.9]` ≈ `[0.667, 0.333]`、sum=1.0）。
3. 不正 `widths=[0.5]`（valid 判定を通る単一要素 sum≠1.0）を localStorage に置きロード → `[1]` に自己回復。
4. 有効 config `[0.6,0.4]` ロードが no-op（既存 `restores a valid stored config` で担保、回帰しないこと）。
5. 既存テスト全 PASS（exact width を assert する既存テストがないことは影響範囲レビューで確認済み）。

受入: `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全 PASS。

---

## 6. 影響範囲・非影響（影響範囲レビュー確定）

- **変更**: `src/hooks/useTerminalSplits.ts`, `tests/unit/hooks/useTerminalSplits.test.ts`, `CHANGELOG.md`
- **非影響**: `TerminalSplitContainer.tsx`（描画が正常化されるのみ）, `terminal-split-config.ts`（仕様不変）, `setSplitWidth`/`PaneResizer`（毎回 sum 再計算で正規化非依存）, e2e, モバイル経路（当該 hook 非 import）

---

## 7. セキュリティ／非機能

- 入力は自プロセスの localStorage 由来の数値配列のみ。外部入力・PII・コマンド実行なし。
- `normalizeWidths` は O(n)（n≤3）。性能影響なし。
- 例外安全: `readInitialState` は既存の try/catch 内。`normalizeWidths` は throw しない純算術。
