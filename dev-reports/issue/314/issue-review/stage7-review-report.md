# Issue #314 レビューレポート -- Stage 7

**レビュー日**: 2026-02-19
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7/8（影響範囲レビュー 2回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 6 |
| Nice to Have | 3 |

Stage 3-6で指摘された影響範囲の問題は全てIssue本文に反映済みであることを確認した。今回の2回目影響範囲レビューでは、Stage 5で追加された設計変更（spread operator化、stopReason型変更、トースト重複防止）の波及影響に注目し、6件のShould Fix指摘を新たに検出した。特に **既存テストの破壊ポイント** (S7-F002, S7-F003) と **spread operator化時のエッジケース** (S7-F001) が実装時の注意点として重要である。

---

## 前回指摘の反映状況

### Stage 3 影響範囲レビュー（1回目）-- 全14件

| ID | 重要度 | 反映状況 |
|----|--------|----------|
| S3-F001 | Must Fix | VERIFIED -- テスト追加が実装タスクに明記済み |
| S3-F002 | Must Fix | VERIFIED -- 期限切れ時のstopPattern保持・stopReason設定が設計済み |
| S3-F003 | Must Fix | VERIFIED -- CurrentOutputResponse.autoYes型にstopReason追加が明記済み |
| S3-F004 | Must Fix | VERIFIED -- 永続化テスト追加が実装タスクに記載済み |
| S3-F005 | Should Fix | VERIFIED -- ConfirmDialog stopPatternテスト追加が記載済み |
| S3-F006 | Should Fix | VERIFIED -- Toggle stopPatternテスト追加が記載済み |
| S3-F007 | Should Fix | VERIFIED -- Desktop/Mobile両レイアウトのstopPattern伝達保証を追記済み |
| S3-F008 | Should Fix | VERIFIED -- GETレスポンスのstopReasonは将来検討として記録済み |
| S3-F009 | Should Fix | VERIFIED -- 全文照合採用、差分照合は将来最適化として明記済み |
| S3-F010 | Should Fix | VERIFIED -- session-cleanup.ts変更不要が追記済み |
| S3-F011 | Should Fix | VERIFIED -- useAutoYes.ts変更不要判断が維持 |
| S3-F012 | Nice to Have | VERIFIED -- auto-yes-resolver.test影響なし確認済み |
| S3-F013 | Nice to Have | VERIFIED -- auto-yes-config.testのテストは暗黙的に含まれる |
| S3-F014 | Nice to Have | VERIFIED -- useAutoYes.test影響なし確認済み |

### Stage 5 通常レビュー（2回目）-- 全7件

| ID | 重要度 | 反映状況 |
|----|--------|----------|
| S5-F001 | Should Fix | VERIFIED -- spread operator化が設計に反映済み。新規指摘S7-F001でexisting=undefined時フォールバック処理を追加指摘 |
| S5-F002 | Should Fix | VERIFIED -- 再有効化時クリア確認テストが実装タスクに追加済み |
| S5-F003 | Should Fix | VERIFIED -- stopReason型が確定、全セクションに一貫反映済み |
| S5-F004 | Should Fix | VERIFIED -- トースト重複防止メカニズムが設計根拠付きで反映済み。新規指摘S7-F006で依存配列影響を追加指摘 |
| S5-F005 | Should Fix | VERIFIED -- safe-regex2見送り方針が確定・反映済み |
| S5-F006 | Nice to Have | VERIFIED -- 番号注記が追加済み |
| S5-F007 | Nice to Have | VERIFIED -- 空文字列正規化処理が追記済み |

---

## Should Fix（推奨対応）

### S7-F001: setAutoYesEnabled() spread operator化時のexisting=undefinedフォールバック処理

**カテゴリ**: 影響範囲
**場所**: `src/lib/auto-yes-manager.ts` (lines 224-233) / Issue本文のsetAutoYesEnabled() disableパスのコードイメージ

**問題**:
S5-F001で設計されたdisableパスのspread operator化 `{ ...existing, enabled: false }` は、`existing` がundefined（事前にsetAutoYesEnabled(true)が呼ばれていないworktreeIdに対してsetAutoYesEnabled(false)を呼んだ場合）のケースを考慮していない。既存テスト（auto-yes-manager.test.ts line 110-116）は `setAutoYesEnabled('wt-new', false)` でenabledat=0, expiresAt=0を期待しており、spread operator化後のフォールバック処理が必要。

**証拠**:
- 現在のコード: `{ enabled: false, enabledAt: existing?.enabledAt ?? 0, expiresAt: existing?.expiresAt ?? 0 }`
- Issue本文のコードイメージ: `{ ...existing, enabled: false }` -- existingがundefinedの場合、必須フィールド `enabledAt` と `expiresAt` が欠落する
- テスト: `tests/unit/lib/auto-yes-manager.test.ts` line 110-116の `should disable auto-yes even when no prior state exists`

**推奨対応**:
disableパスのコードイメージを以下のように修正する：
```typescript
const existing = autoYesStates.get(worktreeId);
autoYesStates.set(worktreeId, {
  enabled: false,
  enabledAt: existing?.enabledAt ?? 0,
  expiresAt: existing?.expiresAt ?? 0,
  ...(existing && { stopReason: existing.stopReason, stopPattern: existing.stopPattern }),
});
```

---

### S7-F002: AutoYesConfirmDialog.test.tsxのonConfirm引数検証がexact matchで壊れる

**カテゴリ**: テスト
**場所**: `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` (lines 115-143)

**問題**:
AutoYesConfirmDialogのonConfirmコールバックが `(duration: AutoYesDuration)` から `(duration: AutoYesDuration, stopPattern: string)` に変更される。VitestのtoHaveBeenCalledWithはexact matchであるため、2引数で呼ばれた関数に対して1引数のexpectは**失敗する**。既存テストの3ケース（line 119, 127, 135）が全て壊れる。

**証拠**:
- line 119: `expect(defaultProps.onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION)`
- line 127: `expect(defaultProps.onConfirm).toHaveBeenCalledWith(10800000)`
- line 135: `expect(defaultProps.onConfirm).toHaveBeenCalledWith(28800000)`

**推奨対応**:
Issue #314の実装タスク内のAutoYesConfirmDialogテスト項目に、上記3テストケースの修正が必要であることを具体的な行番号付きで明記する。修正例: `toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, '')` or `toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, expect.any(String))`。

---

### S7-F003: AutoYesToggle.test.tsxのonToggle引数検証が新シグネチャで壊れる可能性

**カテゴリ**: テスト
**場所**: `tests/unit/components/worktree/AutoYesToggle.test.tsx` (lines 39-62)

**問題**:
AutoYesToggleのonToggleコールバックが `(enabled: boolean, duration?: AutoYesDuration)` から `(enabled: boolean, duration?: AutoYesDuration, stopPattern?: string)` に変更される。handleConfirmの実装が `onToggle(true, duration, stopPattern)` と3引数で呼び出す場合、既存テストの `toHaveBeenCalledWith(true, DEFAULT_AUTO_YES_DURATION)` は2引数のexpectに対して3引数での呼び出しとなり、exact matchで失敗する。

**証拠**:
- line 44-46: `expect(defaultProps.onToggle).toHaveBeenCalledWith(true, DEFAULT_AUTO_YES_DURATION)`
- line 58-60: `expect(defaultProps.onToggle).toHaveBeenCalledWith(true, 10800000)`

**推奨対応**:
Issue #314の実装タスク内のAutoYesToggleテスト項目に修正が必要なテストケースを具体的に明記する。ON->OFFテスト（line 81-88）は `toHaveBeenCalledWith(false)` でdisable時はstopPatternを渡さないため影響なし。

---

### S7-F004: current-output/route.tsのstopReasonフィールド返却条件が未明記

**カテゴリ**: 影響範囲
**場所**: `src/app/api/worktrees/[id]/current-output/route.ts` (lines 128-131)

**問題**:
現在のautoYesレスポンスは `enabled: autoYesState?.enabled ?? false, expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null` と、enabledの値に応じてexpiresAtを条件分岐している。stopReasonフィールドについても同様の条件分岐が必要かどうか（enabled=false時にstopReasonを返すか）がIssue本文に明記されていない。トースト重複防止設計（S5-F004）では「enabled: true -> false遷移時にstopReasonをチェック」とあるため、enabled=false時にstopReasonが返却される必要がある。

**推奨対応**:
Issue本文に「autoYesレスポンスのstopReasonフィールドは `autoYesState?.stopReason` をそのまま返す（enabled/disabledに関わらず常に返却）」と明記する。

---

### S7-F005: auto-yes/route.ts POSTハンドラーのsetAutoYesEnabled()呼び出しでstopPattern引数の扱いが未特定

**カテゴリ**: 互換性
**場所**: `src/app/api/worktrees/[id]/auto-yes/route.ts` (line 136)

**問題**:
setAutoYesEnabled()のシグネチャに第4引数 `stopPattern?: string` を追加する場合、route.ts (line 136) の呼び出し `setAutoYesEnabled(params.id, body.enabled, body.enabled ? duration : undefined)` に第4引数を追加する必要がある。enabled=false時にstopPatternを渡すかどうかの判断がIssueに未明記。S5-F001のspread operator化設計により、enabled=false時はsetAutoYesEnabled()が既存stateのstopPatternを保持するため、明示的にstopPatternを渡す必要はない。

**推奨対応**:
`setAutoYesEnabled(params.id, body.enabled, body.enabled ? duration : undefined, body.enabled ? stopPattern : undefined)` とし、enabled=true時のみstopPatternを渡す方針をIssueに明記する。

---

### S7-F006: fetchCurrentOutput()のuseCallback依存配列にshowToast追加の必要性

**カテゴリ**: 影響範囲
**場所**: `src/components/worktree/WorktreeDetailRefactored.tsx` (lines 1009-1045, 1352)

**問題**:
トースト重複防止の設計（S5-F004）では、fetchCurrentOutput()内でautoYes.enabled遷移を検出してshowToast()を呼び出す。しかし、fetchCurrentOutput()のuseCallback依存配列は `[worktreeId, actions, state.prompt.visible]` であり、showToastが含まれていない。showToast関数をfetchCurrentOutput内で使用する場合、依存配列に追加する必要がある。

**推奨対応**:
fetchCurrentOutput()の依存配列へのshowToast追加をIssueの実装タスクに明記する。showToastはuseToast()の戻り値で通常stable referenceのため、レンダリング頻度への実質的影響は最小限。代替案として、autoYesEnabledのuseEffect監視でトースト表示ロジックを分離する方法もある。

---

## Nice to Have（あれば良い）

### S7-F007: auto-yes-persistence.test.tsへのstopPattern永続化テストの具体的なテストケース構造

テストケースの概要（setAutoYesEnabled -> vi.resetModules() -> getAutoYesState()?.stopPattern検証）をIssue本文に追記することを推奨。

### S7-F008: globalThis型宣言はAutoYesState型変更で自動反映される

追加変更不要。Impact scope的に影響なし確認済み。

### S7-F009: handleAutoYesToggle()のfetch body拡張

Issue本文に既に記載済み。追加対応不要。

---

## 追加確認事項: 影響ファイルの網羅性

以下のファイルについて影響確認を実施した。

| ファイル | 影響有無 | 根拠 |
|---------|---------|------|
| `src/lib/auto-yes-manager.ts` | **変更必要** | Issue記載済み |
| `src/config/auto-yes-config.ts` | **変更必要** | Issue記載済み（MAX_STOP_PATTERN_LENGTH追加） |
| `src/components/worktree/AutoYesConfirmDialog.tsx` | **変更必要** | Issue記載済み |
| `src/components/worktree/AutoYesToggle.tsx` | **変更必要** | Issue記載済み |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | **変更必要** | Issue記載済み |
| `src/app/api/worktrees/[id]/current-output/route.ts` | **変更必要** | Issue記載済み |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | **変更必要** | Issue記載済み |
| `locales/ja/autoYes.json` | **変更必要** | Issue記載済み |
| `locales/en/autoYes.json` | **変更必要** | Issue記載済み |
| `src/hooks/useAutoYes.ts` | 変更不要 | Issue記載済み（stopPatternはサーバーサイド管理） |
| `src/lib/auto-yes-resolver.ts` | 変更不要 | Issue記載済み（Stop条件チェックはresolveAutoAnswer前に実行） |
| `src/lib/session-cleanup.ts` | 変更不要 | Issue記載済み（stopAutoYesPollingの冪等性） |
| `src/lib/prompt-detector.ts` | 変更不要 | 確認済み（独立モジュール） |
| `src/lib/prompt-answer-sender.ts` | 変更不要 | 確認済み（独立モジュール） |
| `src/lib/prompt-response-body-builder.ts` | 変更不要 | 確認済み（独立モジュール） |
| `src/lib/prompt-key.ts` | 変更不要 | 確認済み（独立モジュール） |
| `src/lib/cli-patterns.ts` | 変更不要 | 確認済み（stripAnsi/detectThinkingは既存使用） |
| `src/lib/cli-session.ts` | 変更不要 | 確認済み（captureSessionOutputは既存使用） |
| `tests/unit/lib/auto-yes-manager.test.ts` | **テスト追加必要** | Issue記載済み |
| `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | **テスト修正+追加必要** | **S7-F002で指摘：既存テスト3ケースがexact matchで壊れる** |
| `tests/unit/components/worktree/AutoYesToggle.test.tsx` | **テスト修正+追加必要** | **S7-F003で指摘：既存テスト2ケースがexact matchで壊れる可能性** |
| `tests/integration/auto-yes-persistence.test.ts` | **テスト追加必要** | Issue記載済み |
| `tests/unit/config/auto-yes-config.test.ts` | テスト追加推奨 | MAX_STOP_PATTERN_LENGTH定数のテスト |
| `tests/unit/hooks/useAutoYes.test.ts` | 変更不要 | 確認済み（S3-F014） |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 変更不要 | 確認済み（S3-F012） |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/lib/auto-yes-manager.ts`: setAutoYesEnabled()のdisableパス（S7-F001）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx`: onConfirm引数検証（S7-F002）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/tests/unit/components/worktree/AutoYesToggle.test.tsx`: onToggle引数検証（S7-F003）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/app/api/worktrees/[id]/current-output/route.ts`: stopReasonフィールド返却条件（S7-F004）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/app/api/worktrees/[id]/auto-yes/route.ts`: setAutoYesEnabled呼び出し修正（S7-F005）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/src/components/worktree/WorktreeDetailRefactored.tsx`: fetchCurrentOutput依存配列（S7-F006）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-314/CLAUDE.md`: プロジェクト設計パターン参照元
