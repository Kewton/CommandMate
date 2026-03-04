# Issue #406 レビューレポート

**レビュー日**: 2026-03-04
**フォーカス**: 通常レビュー（整合性・正確性・完全性）
**イテレーション**: 1回目（Stage 1）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**: needs_improvement

Issueの目的（イベントループブロック解消）は妥当だが、実装タスク・受入条件・影響範囲のスコープが `validateCmatePath()` の `realpathSync()` に限定されすぎている。実際には同一呼び出しパス上の `readCmateFile()` 内 `readFileSync()` も非同期化対象に含めるべきであり、さらに `syncSchedules()` の async 化も波及的に必要となる。これらの追加タスクが明記されていないため、実装者が不足タスクを発見して対応する必要がある状態。

---

## Must Fix（必須対応）

### R1-001: readCmateFile() 内の readFileSync() が実装タスクと影響範囲に含まれていない

**カテゴリ**: 完全性
**場所**: 実装タスク / 影響範囲

**問題**:
Issueの実装タスクは `validateCmatePath()` の `realpathSync()` のみを非同期化対象としているが、`validateCmatePath()` を async 化すると、その呼び出し元である `readCmateFile()` (`cmate-parser.ts` L311-329) も async 化が必須となる。`readCmateFile()` 内の `readFileSync(filePath, 'utf-8')` (L317) も同期I/Oであり、非同期化の対象として明示すべきである。

`validateCmatePath()` のみを async 化し `readFileSync()` を残すと、同一関数内に非同期と同期のI/Oが混在する不整合な実装となる。

**証拠**:

```typescript
// src/lib/cmate-parser.ts L311-329
export function readCmateFile(worktreeDir: string): CmateConfig | null {
  const filePath = path.join(worktreeDir, CMATE_FILENAME);
  try {
    validateCmatePath(filePath, worktreeDir);  // L316: async化後は await が必要
    const content = readFileSync(filePath, 'utf-8');  // L317: 同期I/O（Issue未言及）
    return parseCmateFile(content);
  } catch (error) {
    // ...
  }
}
```

**推奨対応**:
実装タスクに以下を追加する:
1. `readCmateFile()` を async 関数に変更
2. `readFileSync()` を `fs.promises.readFile()` に置換

影響範囲テーブルの `cmate-parser.ts` の変更内容を「`validateCmatePath()` と `readCmateFile()` を async 化」に更新する。

---

### R1-002: syncSchedules() の async 化が実装タスクに含まれていない

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
`readCmateFile()` が async になると、その唯一の呼び出し元である `syncSchedules()` (`schedule-manager.ts` L478, L516) も async 化が必要になる。`syncSchedules()` は現在 `void` 関数として定義されており、以下の2箇所から呼ばれている:

1. `initScheduleManager()` の初期同期 (L617): `syncSchedules();`
2. `setInterval` コールバック (L620-622): `setInterval(() => { syncSchedules(); }, POLL_INTERVAL_MS);`

`setInterval` 内の呼び出しは `void syncSchedules()` とする必要があり、初期同期 (L617) を `await` したい場合は `initScheduleManager()` 自体も async 化が必要になるという設計判断が生じる。

**証拠**:

```typescript
// src/lib/schedule-manager.ts L603-626
export function initScheduleManager(): void {
  // ...
  syncSchedules();  // L617: readCmateFile が async になると await が必要

  manager.timerId = setInterval(() => {
    syncSchedules();  // L621: void syncSchedules() に変更が必要
  }, POLL_INTERVAL_MS);
  // ...
}
```

**推奨対応**:
実装タスクに以下を追加する:
1. `syncSchedules()` を async 関数に変更
2. `setInterval` 内の呼び出しを `void syncSchedules()` に変更
3. `initScheduleManager()` 内の初期同期呼び出しの設計判断を記載

---

## Should Fix（推奨対応）

### R1-003: 受入条件のスコープが validateCmatePath() のみに限定されている

**カテゴリ**: 完全性
**場所**: 受入条件

**問題**:
現在の受入条件は「`validateCmatePath()` 内に同期ファイルI/Oが残っていないこと」だが、Issueの目的はスケジュールマネージャのポーリングループでのイベントループブロック解消である。`readCmateFile()` の `readFileSync()` も同じ呼び出しパス上で同期ブロッキングを起こしており、受入条件が目的と整合していない。

**推奨対応**:
受入条件を以下に拡充する:
- 「`validateCmatePath()` および `readCmateFile()` 内に同期ファイルI/Oが残っていないこと」

もしくは、意図的に `readFileSync()` をスコープ外とするなら、その理由を明記する。

---

### R1-004: getCmateMtime() の statSync() に対するスコープ判断が未記載

**カテゴリ**: スコープ
**場所**: 背景・課題

**問題**:
`schedule-manager.ts` L163 の `getCmateMtime()` 内の `statSync()` も同期I/Oである。この関数は毎回のポーリングで全 worktree に対して呼ばれる (L488)。ただし、`statSync` は `realpathSync`/`readFileSync` と比較してメタデータのみの読み取りであり高速なため、スコープ外とすることは妥当だが、その判断理由が未記載。

**推奨対応**:
「背景・課題」セクションに以下を追記する:
「`getCmateMtime()` の `statSync()` も同期I/Oだが、メタデータのみの読み取りでありブロッキング時間が極めて短いため、本Issueのスコープ外とする。」

---

### R1-005: 行番号の不一致

**カテゴリ**: 正確性
**場所**: 背景・課題

**問題**:
Issueの「背景・課題」セクションで `schedule-manager.ts` の行番号を L363-442 と記載しているが、現在のコードでは `syncSchedules()` は L478-591 に位置している。これは Issue #409 の実装後にコードが変更されたことによるズレと考えられる。

**推奨対応**:
行番号を現在のコードに合わせて更新する（`syncSchedules()`: L478-591、`setInterval`: L620-622）。あるいは、行番号への依存を避け関数名のみで記載する。

---

### R1-006: テスト更新タスクの具体化

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
`validateCmatePath()` は現在 `boolean` を返す同期関数であり、async 化すると `Promise<boolean>` を返すようになる。テストでは `expect(() => validateCmatePath(...)).not.toThrow()` パターンを使用しており (`cmate-parser.test.ts` L378)、async 化後は `expect(async () => validateCmatePath(...)).rejects.toThrow()` パターンに変更が必要。実装タスクの「ユニットテスト更新」が抽象的。

**証拠**:

```typescript
// tests/unit/lib/cmate-parser.test.ts L378, L387
expect(() => validateCmatePath(correctFile, worktreeDir)).not.toThrow();
expect(() => validateCmatePath(symlinkPath, worktreeDir)).toThrow('Path traversal detected');
```

**推奨対応**:
実装タスクの「ユニットテスト更新」を具体化する:
1. `validateCmatePath` テストを async/await 対応に変更
2. `.toThrow()` を `.rejects.toThrow()` に変更
3. `readCmateFile` が async 化される場合、`schedule-manager` テストのモック更新も必要

---

## Nice to Have（あれば良い）

### R1-007: initScheduleManager() の波及影響

**カテゴリ**: 完全性
**場所**: 影響範囲

**問題**:
`syncSchedules()` を async にした場合、`initScheduleManager()` 内の初期同期 (L617) を `await` したいケースでは、`initScheduleManager()` 自体も async にする必要があり、その呼び出し元である `server.ts` にも波及する可能性がある。ただし、初期同期を `void syncSchedules()` とするなら波及は限定的。

**推奨対応**:
影響範囲テーブルに `server.ts` を追加するか、設計判断として「`initScheduleManager()` は sync のまま維持し、初期同期は fire-and-forget とする」を明記する。

---

### R1-008: パフォーマンス改善の定量的な期待値

**カテゴリ**: 明確性
**場所**: 背景・課題

**問題**:
Issueは「イベントループがブロックされ、他のAPIリクエストのレイテンシが増加」と記載しているが、改善の定量的な期待値がない。`realpathSync` のブロッキング時間は通常 1-5ms/呼び出し程度であり、改善の優先度判断に役立つ情報が不足している。

**推奨対応**:
背景セクションに、想定される worktree 数での累積ブロッキング時間の概算を追記する。
例: 「100 worktree の場合、`realpathSync` x 2 + `readFileSync` x 1 で推定 300-500ms のイベントループブロック」。

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連性 |
|---------|--------|--------|
| `src/lib/cmate-parser.ts` | L15, L80-98, L311-329 | 変更対象: `validateCmatePath()` の `realpathSync` (L84-85)、`readCmateFile()` の `readFileSync` (L317)、import文 (L15) |
| `src/lib/schedule-manager.ts` | L159-176, L478-591, L603-626 | 呼び出し元: `getCmateMtime()` の `statSync` (L163)、`syncSchedules()` の `readCmateFile` 呼び出し (L516)、`initScheduleManager()` (L617, L620-622) |
| `tests/unit/lib/cmate-parser.test.ts` | L358-391 | テスト修正対象: `.not.toThrow()` / `.toThrow()` を async パターンに変更 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | `cmate-parser.ts` と `schedule-manager.ts` のモジュール説明に変更内容を反映する必要がある |
| `dev-reports/design/issue-409-schedule-perf-design-policy.md` | Issue #409 設計方針書に Issue #406 との相互依存が記載されており (L552)、マージ順序の考慮が必要 |
