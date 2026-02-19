# Issue #314 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-02-19
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3 / 4

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 4 |
| Should Fix | 7 |
| Nice to Have | 3 |
| **合計** | **14** |

---

## Must Fix（必須対応）

### S3-F001: AutoYesState型変更によるテスト影響の確認

**カテゴリ**: テスト
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/lib/auto-yes-manager.test.ts` (lines 176-212)

**問題**:
`isAutoYesExpired()`のテストでは`AutoYesState`オブジェクトをリテラルで構築している。新フィールド（`stopPattern?`, `stopReason?`）はoptionalのため既存テストのコンパイルは通るが、新フィールドに対するテストケースが不足する。

**証拠**:
```typescript
// tests/unit/lib/auto-yes-manager.test.ts line 177-181
const state: AutoYesState = {
  enabled: true,
  enabledAt: 1000,
  expiresAt: 2000,
};
// stopPattern, stopReason は optional のため省略可能
```

**推奨対応**:
Issueの実装タスクに「既存テストの通過確認」だけでなく、「stopPatternフィールド追加後のsetAutoYesEnabled/getAutoYesStateテスト追加」を明記する。

---

### S3-F002: setAutoYesEnabled()シグネチャ変更と期限切れ無効化パスの整合性

**カテゴリ**: 互換性
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/auto-yes-manager.ts` (lines 191-206, 213)

**問題**:
`getAutoYesState()`内の期限切れ無効化（line 197-201）はスプレッド演算子で既存stateを展開してから`enabled: false`を上書きしている。この場合、`stopPattern`は保持されるが、`stopReason`が未設定のままとなる。期限切れ時にstopReasonを`'expired'`に設定する処理が必要か、Issueで設計判断を明確にすべき。

**証拠**:
```typescript
// src/lib/auto-yes-manager.ts line 196-201
if (isAutoYesExpired(state)) {
  const disabledState: AutoYesState = {
    ...state,        // stopPattern は保持されるが stopReason は undefined のまま
    enabled: false,
  };
  autoYesStates.set(worktreeId, disabledState);
  return disabledState;
}
```

**推奨対応**:
Issueに「`getAutoYesState()`内の期限切れ無効化時に`stopReason: 'expired'`を設定する」設計を追記する。これにより、クライアント側が停止理由（期限切れ vs Stop条件マッチ vs 手動）を区別してトースト通知内容を切り替えられる。

---

### S3-F003: CurrentOutputResponseインターフェースのstopReason追加漏れ

**カテゴリ**: 影響範囲
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/components/worktree/WorktreeDetailRefactored.tsx` (lines 76-89)

**問題**:
`WorktreeDetailRefactored.tsx`内の`CurrentOutputResponse`型のautoYesプロパティは`{ enabled: boolean; expiresAt: number | null }`のみ定義。Issue本文では`current-output/route.ts`のレスポンスに`stopReason`フィールドを追加すると記載しているが、クライアント側の型定義更新が変更対象ファイルテーブルに明示されていない。

**証拠**:
```typescript
// WorktreeDetailRefactored.tsx line 85-88 (現在の型)
autoYes?: {
  enabled: boolean;
  expiresAt: number | null;
};
// stopReason フィールドが欠落
```

**推奨対応**:
影響範囲テーブルの`WorktreeDetailRefactored.tsx`の変更内容に「`CurrentOutputResponse.autoYes`型に`stopReason?: 'expired' | 'stop_pattern_matched' | 'manual'`フィールドを追加」を明記する。

---

### S3-F004: globalThis永続化テストのstopPatternカバレッジ不足

**カテゴリ**: テスト
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/integration/auto-yes-persistence.test.ts`

**問題**:
`auto-yes-persistence.test.ts`はglobalThisを介したhot-reload永続化をテストしているが、`stopPattern`フィールドの永続化テストが存在しない。Issue #225の3時間duration永続化テスト（line 156-184）と同様パターンでstopPatternの永続化テストが必要。

**証拠**:
```typescript
// tests/integration/auto-yes-persistence.test.ts line 156-184
// Issue #225: 3時間 duration の永続化テストは存在
test('should persist 3-hour duration in-memory state after module reload', async () => {
  // ...setAutoYesEnabled('test-duration-reload', true, 10800000)
  // ...vi.resetModules() で reload 後に expiresAt が保持されることを検証
});
// stopPattern の同等テストが必要
```

**推奨対応**:
Issueの実装タスクに「`tests/integration/auto-yes-persistence.test.ts`にstopPatternフィールドの永続化テストを追加」を追記する。

---

## Should Fix（推奨対応）

### S3-F005: AutoYesConfirmDialogテストのonConfirmシグネチャ対応

**カテゴリ**: テスト
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` (lines 115-143)

**問題**:
`onConfirm`のシグネチャが`(duration, stopPattern?) => void`に変更された場合、既存テストの`toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION)`はstopPatternを検証しない。Vitestの`toHaveBeenCalledWith`は引数が多い場合でも部分一致で通過するため既存テストは壊れないが、新引数のテストが暗黙的に欠落する。

**推奨対応**:
実装タスクの「ユニットテスト追加」に「AutoYesConfirmDialog: stopPattern入力フィールドのレンダリング・バリデーション・onConfirm呼び出し時のstopPattern引数テスト」を具体的に列挙する。

---

### S3-F006: AutoYesToggleテストのonToggleシグネチャ対応

**カテゴリ**: テスト
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/components/worktree/AutoYesToggle.test.tsx` (lines 39-62)

**問題**:
S3-F005と同様、`onToggle`に第3引数`stopPattern?`が追加された場合の既存テスト検証。既存テストは壊れないが、新引数カバレッジが必要。

**推奨対応**:
「AutoYesToggle: onToggle呼び出し時のstopPattern引数テスト」を実装タスクに追加。

---

### S3-F007: Desktop/Mobileの両レイアウトでのstopPattern伝達確認

**カテゴリ**: 互換性
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/components/worktree/WorktreeDetailRefactored.tsx` (lines 1811-1817, 1950-1957)

**問題**:
`AutoYesToggle`はDesktop（line 1811-1817）とMobile（line 1950-1957）の両方で使用されており、同一の`handleAutoYesToggle`コールバックを参照している。stopPattern追加による影響は自動的に両方に伝播するが、Issue本文のデータフローセクションではこの点が暗黙的。

**推奨対応**:
データフローセクションに「Desktop/Mobileの両AutoYesToggleが同一のhandleAutoYesToggleを参照」という点を補足するか、テスト計画に確認項目を追加。

---

### S3-F008: auto-yes/route.tsのGETレスポンスにstopReasonを含めるか否か

**カテゴリ**: 影響範囲
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/app/api/worktrees/[id]/auto-yes/route.ts` (lines 26-45, 66-83)

**問題**:
auto-yes APIのGETエンドポイント（line 66-83）は`buildAutoYesResponse()`で応答を構築しているが、`AutoYesResponse`インターフェース（line 26-30）に`stopReason`は含まれていない。current-output APIで通知する設計が主だが、auto-yes GETでも停止理由を返せると利便性が高い。

**推奨対応**:
Issueに「auto-yes GETレスポンスにstopReasonを含めるか否かの設計判断」を明記する。含める場合は`AutoYesResponse`と`buildAutoYesResponse()`の更新が必要。

---

### S3-F009: 正規表現マッチングのパフォーマンス特性の明確化

**カテゴリ**: パフォーマンス
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/auto-yes-manager.ts` (pollAutoYes, lines 344-453)

**問題**:
2秒間隔のポーリングで最大5000文字のテキストに対して正規表現マッチングを行う。ReDoS対策としてsafe-regex2が記載されているが、通常の正規表現でも5000文字は数マイクロ秒で完了する。Issue本文の「差分照合方式を検討する」は最適化として有効だが、初期実装で全文照合を選択した場合のパフォーマンス特性を明確にすべき。

**推奨対応**:
Issue内で「初期実装は全文照合（5000文字のRegExpマッチは十分高速）、差分照合は将来最適化として検討」と明確に判断を記載する。

---

### S3-F010: session-cleanup.tsの影響なし確認の記載

**カテゴリ**: 影響範囲
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/session-cleanup.ts` (lines 98-106)

**問題**:
`session-cleanup.ts`は`stopAutoYesPolling(worktreeId)`を呼び出すが、`AutoYesState`のフィールドには一切触れない。変更不要であることは確認済みだが、Issue本文の「関連コンポーネント」セクションに記載がない。

**推奨対応**:
「関連コンポーネント」セクションに `session-cleanup.ts -- 変更不要（stopAutoYesPolling()呼び出しのみ、AutoYesStateフィールドに非依存）` を追記。

---

### S3-F011: useAutoYes.tsのStop条件停止時の競合ウィンドウ

**カテゴリ**: 影響範囲
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/hooks/useAutoYes.ts` (lines 54-108)

**問題**:
Stop条件によりサーバー側でAuto-Yesが停止された後、クライアント側の`autoYesEnabled`がfalseに更新されるまでに最大1ポーリングサイクル（2-5秒）の遅延がある。この間にuseAutoYesがクライアント側で応答を試みる可能性があるが、サーバー側pollerは既に停止しているため重複応答にはならない。

**推奨対応**:
Issue本文のuseAutoYes.ts変更不要の判断は妥当。追加対応不要だが、設計ドキュメントに「クライアント通知の遅延ウィンドウ（最大1ポーリングサイクル）」を記載しておくことを推奨。

---

## Nice to Have（あれば良い）

### S3-F012: auto-yes-resolver.testへの影響なし確認

**カテゴリ**: テスト
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/lib/auto-yes-resolver.test.ts`

Stop条件チェックは`resolveAutoAnswer()`呼び出し前に行われるため、`auto-yes-resolver.ts`およびそのテストに影響なし。Issueの記載通り。

---

### S3-F013: auto-yes-config.testへの新テストケース追加の明示

**カテゴリ**: 影響範囲
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/config/auto-yes-config.test.ts`

`auto-yes-config.ts`に`MAX_STOP_PATTERN_LENGTH`等の定数を追加する場合、対応するテストの追加が必要。Issueの実装タスクに具体的なテストファイル名を追記すると明確。

---

### S3-F014: useAutoYes.testへの影響なし確認

**カテゴリ**: 互換性
**場所**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/hooks/useAutoYes.test.ts`

`useAutoYes.ts`が変更不要のため、テストへの影響もなし。

---

## 影響範囲サマリーマトリクス

| ファイル | 変更要否 | 影響の種類 | 既存テスト破壊リスク |
|---------|---------|-----------|-----------------|
| `src/lib/auto-yes-manager.ts` | 変更あり | AutoYesState/PollerState拡張、pollAutoYes()ロジック追加 | 低（optionalフィールド追加） |
| `src/config/auto-yes-config.ts` | 変更あり | MAX_STOP_PATTERN_LENGTH定数追加 | なし |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | 変更あり | UI追加、onConfirmシグネチャ変更 | 低（既存テストは部分マッチで通過） |
| `src/components/worktree/AutoYesToggle.tsx` | 変更あり | onToggleシグネチャ変更 | 低（同上） |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | 変更あり | stopPatternバリデーション追加 | 低（新パラメータはoptional） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 変更あり | autoYesレスポンスにstopReason追加 | なし |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 変更あり | 型定義変更、handleAutoYesToggle拡張、トースト通知 | なし |
| `locales/ja/autoYes.json` | 変更あり | 翻訳キー追加 | なし |
| `locales/en/autoYes.json` | 変更あり | 翻訳キー追加 | なし |
| `src/lib/session-cleanup.ts` | **変更不要** | stopAutoYesPolling()呼び出しのみ | なし |
| `src/lib/auto-yes-resolver.ts` | **変更不要** | Stop条件はその前段で判定 | なし |
| `src/hooks/useAutoYes.ts` | **変更不要** | stopPatternはサーバーサイド管理 | なし |
| `src/lib/prompt-detector.ts` | **変更不要** | Stop条件はprompt検出前に処理 | なし |
| `src/lib/cli-patterns.ts` | **変更不要** | stripAnsi/detectThinkingのみ | なし |

## テスト影響サマリー

| テストファイル | 既存テスト破壊 | 新規テスト追加 | 備考 |
|--------------|-------------|-------------|------|
| `tests/unit/lib/auto-yes-manager.test.ts` | なし | 必要 | stopPatternマッチ/不マッチ、stopReason設定 |
| `tests/integration/auto-yes-persistence.test.ts` | なし | 必要 | stopPatternのglobalThis永続化 |
| `tests/unit/config/auto-yes-config.test.ts` | なし | 必要 | MAX_STOP_PATTERN_LENGTH定数テスト |
| `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | なし | 必要 | stopPattern入力UI、バリデーション |
| `tests/unit/components/worktree/AutoYesToggle.test.tsx` | なし | 必要 | onToggle第3引数テスト |
| `tests/unit/lib/auto-yes-resolver.test.ts` | なし | 不要 | 影響なし |
| `tests/unit/hooks/useAutoYes.test.ts` | なし | 不要 | 影響なし |

---

## 後方互換性の総合評価

**後方互換性は維持される。** 全ての新フィールド（`stopPattern`, `stopReason`, `lastCheckedOutput`）はoptionalとして追加されるため、既存のコードパス・テスト・APIコントラクトに破壊的影響はない。Stop条件が空欄（未指定）の場合は従来通りの時間ベースのみの停止動作となり、既存ユーザーのワークフローに影響しない。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/auto-yes-manager.ts`: 主要変更対象（AutoYesState/PollerState、pollAutoYes）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/config/auto-yes-config.ts`: 定数追加対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/app/api/worktrees/[id]/auto-yes/route.ts`: APIバリデーション追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/app/api/worktrees/[id]/current-output/route.ts`: stopReasonレスポンス追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/components/worktree/WorktreeDetailRefactored.tsx`: クライアント型定義・通知
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/components/worktree/AutoYesConfirmDialog.tsx`: UI追加対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/components/worktree/AutoYesToggle.tsx`: シグネチャ変更対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/session-cleanup.ts`: 影響なし確認済み
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/hooks/useAutoYes.ts`: 影響なし確認済み
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/auto-yes-resolver.ts`: 影響なし確認済み

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/lib/auto-yes-manager.test.ts`: 既存テスト+新規テスト追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/integration/auto-yes-persistence.test.ts`: 新規永続化テスト追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/config/auto-yes-config.test.ts`: 新規定数テスト追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx`: 新規UIテスト追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/components/worktree/AutoYesToggle.test.tsx`: 新規引数テスト追加

### i18n
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/locales/ja/autoYes.json`: 翻訳キー追加
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/locales/en/autoYes.json`: 翻訳キー追加
