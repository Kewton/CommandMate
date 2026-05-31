# Issue #739 TDD自動開発 進捗報告（iteration-1）

**Issue**: fix(terminal): removeSplit fails to re-normalize widths, leaving 50% empty space (#728 follow-up)
**ブランチ**: feature/739-worktree
**実施日**: 2026-05-31

## TDD サイクル結果

| フェーズ | 内容 | 結果 |
|---------|------|------|
| Red | 回帰テスト4件追加（removeSplit再正規化3→2→1 / 比率保持 / 単一splitロード自己回復 / 複数splitロード自己回復）。no-op確認テストも追加 | 4件 FAIL を確認 ✅ |
| Green | `normalizeWidths` ヘルパー追加、`removeSplit` と `readInitialState` に適用 | 26/26 PASS ✅ |
| Refactor | 実装は純関数＋最小差分で追加リファクタ不要。設計コメント付与済み | 完了 ✅ |

## 実装内容

### `src/hooks/useTerminalSplits.ts`
- `normalizeWidths(widths)` 純関数を追加（合計1.0へ比率保持正規化、`sum<=0`は長さ保存の等分フォールバック）。
- `removeSplit`: `normalizeWidths(prev.widths.slice(0, -1))` で再正規化。
- `readInitialState`: `isValidSplitConfig` 通過後に `{ ...parsed, widths: normalizeWidths(parsed.widths) }` を返却（mutate なし、sum=1.0 config には no-op）。

### `tests/unit/hooks/useTerminalSplits.test.ts`
- 回帰テスト5件追加（`toBeCloseTo(1)` 使用、`=== 1.0` 不使用 / 設計レビュー S3-001）。

### `CHANGELOG.md`
- `[Unreleased] > Fixed` に #739 を追記。

## 品質ゲート結果

| ゲート | コマンド | 結果 |
|--------|----------|------|
| TypeScript | `npx tsc --noEmit` | ✅ 0 errors |
| ESLint | `npm run lint` | ✅ No warnings or errors |
| Unit Test | `npm run test:unit` | ✅ 358 files / 6699 passed / 7 skipped |
| Build | `npm run build` | ✅ 成功 |

対象フックのテスト: 26/26 PASS（既存21 + 新規5）。

## 受入条件の充足状況

| 受入条件 | 状況 |
|----------|------|
| `+Split`→`-Split` で全幅占有 | ✅ removeSplit再正規化で flex-grow 合計=1.0 → 全幅（unit で sum≈1.0 担保） |
| `removeSplit` 後 sum ≈ 1.0（`toBeCloseTo`） | ✅ テスト追加・PASS |
| 不正 localStorage 状態のロード自己回復 | ✅ `[0.5]`→`[1]`、`[0.25,0.25]`→`[0.5,0.5]` テスト PASS |
| 3→2→1 連続でも各段階で sum≈1.0 | ✅ テスト PASS |
| 既存テスト全PASS＋回帰テスト追加 | ✅ |
| lint / tsc / test:unit / build 全PASS | ✅ |
| PC版・モバイル両方で動作確認 | PC: hook修正で解消。モバイルは当該hook非使用のため非影響（影響範囲レビューで確認） |
| e2e 追加 | スコープ外（Issue明記） |

## 変更ファイル（git diff --stat）

```
 CHANGELOG.md                               |  1 +
 src/hooks/useTerminalSplits.ts             | 28 ++++++++++-
 tests/unit/hooks/useTerminalSplits.test.ts | 79 ++++++++++++++++++++++++++++++
 3 files changed, 106 insertions(+), 2 deletions(-)
```

## 次のステップ

- [ ] コミット
- [ ] PR作成（`/create-pr`）→ develop
