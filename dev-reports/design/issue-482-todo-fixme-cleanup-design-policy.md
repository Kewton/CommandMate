# 設計方針書: TODO/FIXME マーカー解消（Issue #482）

## 基本情報

| 項目 | 内容 |
|------|------|
| Issue | #482 refactor: TODO/FIXME マーカー解消（R-4） |
| 親Issue | #475 |
| 作成日 | 2026-03-13 |
| 種別 | リファクタリング（コードクリーンアップ） |

---

## 1. 問題の概要

コードベースに残存する4箇所のTODO/FIXMEマーカーを対応または削除する。いずれも将来の検討を促すコメントであり、実行時の挙動に影響しない。変更対象はすべてコメント・JSDoc修正のみ。

### 対象一覧

| ファイル | 行 | 種別 | 対応方針 |
|---------|-----|------|---------|
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | 33 | TODOマーカー | TODOコメント削除（型定義維持） |
| `src/lib/cli-tools/opencode-config.ts` | 217 | TODOマーカー | TODOコメント削除・JSDocに集約 |
| `src/lib/cli-tools/opencode-config.ts` | 284 | TODOマーカー | TODOコメント削除・JSDocに集約 |
| `src/lib/cli-patterns.ts` | 27 | JSDoc内未解決参照 | Issue #XXX → Issue #188 に修正 |

---

## 2. 設計方針

### 方針1: slash-commands/route.ts:33 のTODO解消

**現状**:
```typescript
// TODO: api-client.ts の SlashCommandsResponse との型統合を検討する（sources フィールドの共有）
interface SlashCommandsResponse {
  groups: ReturnType<typeof getStandardCommandGroups>;
  sources: { standard: number; worktree: number; mcbd: number; skill: number; };
  cliTool: CLIToolType;
}
```

**設計判断: 統合不要（方針B）**

根拠:
- `api-client.ts` の `SlashCommandsResponse`（`{ groups }` のみ）は `/api/slash-commands`（MCBD向け）に対応
- `route.ts` のローカル型は `/api/worktrees/[id]/slash-commands` に対応
- 2つは異なるAPIエンドポイントに紐づき、用途・構造が異なる
- `api-client.ts` の型を外部からimportしているモジュールは存在しない
- YAGNI原則: 現時点で統合によるメリットがなく、将来の需要も不明

**対応内容**:
- L33のTODOコメントを削除する
- L29-32のNOTEコメント（独立した型である旨の説明）は維持する
- 型定義（`interface SlashCommandsResponse`）はそのまま維持

### 方針2: opencode-config.ts:217, 284 のTODO解消

**現状（L217, L284）**:
```typescript
// TODO: If a 3rd provider is added, extract common HTTP fetch logic
// to fetchWithTimeout(url, timeoutMs, maxResponseSize): Promise<string | null>
```

**設計判断: TODOコメント削除 + JSDocに集約**

根拠:
- `ensureOpencodeConfig` 関数のJSDoc（L340-342）に3rd provider追加時の設計指針（data-driven design）が既に存在するため、fetchWithTimeoutの共通化ヒントもJSDocに集約して管理箇所を一元化する
- KISS原則: 現在providerは2つのみ（Ollama, LM Studio）であり早期最適化は不要
- 重複したコメントを削除してJSDocに集約することでDRY原則を満たす

**対応内容**:
- L217とL284のTODOコメント（各2行）を削除
- `ensureOpencodeConfig` のJSDoc（L340-342付近）に1行追記:
  ```
  HTTP fetch logic (fetchWithTimeout) can be extracted to a shared helper.
  ```

### 方針3: cli-patterns.ts:27 の Issue #XXX 解消

**現状（L25-27）**:
```typescript
/**
 * Alternative 2: "esc to interrupt" status bar text (Issue #XXX)
 * Claude Code shows "esc to interrupt" in the terminal status bar during active processing.
```

**設計判断: Issue #188 に置き換え**

根拠:
- git log調査により `コミット5ebd2ba → PR #210（feature/188-worktree）→ Issue #188` を確認
- Issue #188: fix: 応答完了後もスピナーが表示され続ける（ステータス検出の修正）

**対応内容**:
- `Issue #XXX` を `Issue #188` に置き換える
- コメント内容は維持

---

## 3. アーキテクチャへの影響

### 影響なし（変更がない箇所）
- APIエンドポイントの仕様・レスポンス構造
- 型定義（実際のTypeScript型）
- テストコード
- ランタイム挙動

### 変更される箇所（コメントのみ）

```
src/
├── app/api/worktrees/[id]/slash-commands/route.ts  # L33: TODOコメント1行削除
├── lib/cli-tools/opencode-config.ts               # L217-218, L284-285: TODOコメント各2行削除
│                                                   # L340-342付近: JSDocに1行追記
└── lib/cli-patterns.ts                            # L27: Issue #XXX → Issue #188
```

---

## 4. 技術選定

本Issueはコメント修正のみのため、技術選定の変更はなし。

---

## 5. セキュリティ設計

変更はコメント・JSDocのみ。セキュリティへの影響なし。

---

## 6. テスト設計

### テストへの影響

| テストファイル | 影響 |
|-------------|------|
| `tests/integration/api-worktree-slash-commands.test.ts` | なし（型importなし、動作不変） |
| `tests/unit/cli-tools/opencode-config.test.ts` | なし（コメント変更のみ） |
| `src/lib/__tests__/cli-patterns.test.ts` | なし（JSDoc変更のみ、パターン定義不変） |

### 追加テスト

不要（コメント変更のみのため）。

---

## 7. 設計上の決定事項とトレードオフ

| 決定事項 | 採用理由 | トレードオフ |
|---------|---------|------------|
| 型統合を実施しない（方針B） | 異なるエンドポイント・独立したスコープ | 将来的に統合したい場合は再度検討が必要 |
| opencode-config TODOを削除し集約 | DRY原則・KISS原則 | fetchWithTimeoutの実装ヒントをJSDocに移す（情報量は維持） |
| Issue #188への置き換え | 正確な参照でコードの追跡可能性が向上 | なし |

---

## 8. 実装チェックリスト

- [ ] `src/app/api/worktrees/[id]/slash-commands/route.ts` L33 TODOコメント削除
- [ ] `src/lib/cli-tools/opencode-config.ts` L217-218 TODOコメント削除
- [ ] `src/lib/cli-tools/opencode-config.ts` L284-285 TODOコメント削除
- [ ] `src/lib/cli-tools/opencode-config.ts` ensureOpencodeConfig JSDocにfetchWithTimeoutヒント追記
- [ ] `src/lib/cli-patterns.ts` L27 `Issue #XXX` → `Issue #188` に修正
- [ ] `npx tsc --noEmit` パス
- [ ] `npm run lint` パス
- [ ] `npm run test:unit` パス
- [ ] 親Issue #475 のR-4行の残存件数を更新（Issue #475 本文のチェックリストにある「R-4: TODO/FIXME マーカー」行の残存件数を、本Issue完了後の値（0件）に書き換える。`gh issue edit 475` または GitHub Web UIで更新）

---

## 9. 関連Issue・PR

- 親Issue: #475
- 関連Issue: #188（cli-patterns.tsのJSDoc参照先）
- 本Issueで解消するTODO導入コミット:
  - `5ebd2ba`: cli-patterns.ts L27 の Issue #XXX 参照
