# Architecture Review Report: Issue #246 整合性レビュー (Stage 2)

## Executive Summary

Issue #246「スマホにて再開時Error loading worktreeとなる」の設計方針書について、設計書記載と実装コードの整合性レビューを実施した。

**結果: 条件付き承認 (Score: 4/5)**

設計書は全体として実装コードとの整合性が高く、行番号・定数値・関数シグネチャ・ファイル構成の大部分が正確に記載されている。ただし、useAutoYesの`lastServerResponseTimestamp`保護機構に関する記載が実装の現状と整合していない点、およびWorktreeList.tsxのerror状態に関する記載が不正確な点について修正が必要である。

---

## Review Details

### レビュー対象

| 項目 | 内容 |
|------|------|
| Issue | #246 スマホにて再開時Error loading worktreeとなる |
| 設計書 | `dev-reports/design/issue-246-visibility-recovery-design-policy.md` |
| フォーカス | 整合性 (設計書 vs 実装コード) |
| ステージ | Stage 2 |
| レビュー日 | 2026-02-13 |

### レビュー対象ファイル

| ファイル | 目的 |
|---------|------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` (2006行) | 主要な変更対象コンポーネント |
| `src/components/worktree/WorktreeList.tsx` (531行) | 副次的な変更対象コンポーネント |
| `src/hooks/useAutoYes.ts` (97行) | 安全性評価で参照されるフック |
| `src/hooks/useWorktreeUIState.ts` (314行) | 状態管理で参照されるフック |
| `src/app/api/worktrees/[id]/current-output/route.ts` | APIレスポンス構造の確認 |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | テストファイルの存在確認 |

---

## 整合性マトリクス

### 正確に一致した項目

| 設計項目 | 設計書の記載 | 実装状況 | 検証結果 |
|---------|------------|---------|---------|
| handleRetry()の位置 | L1434-1442 | L1434-1442にuseCallback定義 | 一致 |
| error useState | L939 | L939に`const [error, setError] = useState<string \| null>(null)` | 一致 |
| loading useState | L938 | L938に`const [loading, setLoading] = useState(true)` | 一致 |
| IDLE_POLLING_INTERVAL_MS | 5000ms、L91 | L91に`const IDLE_POLLING_INTERVAL_MS = 5000` | 一致 |
| ポーリングのloading/errorガード | L1480 | L1480に`if (loading \|\| error) return;` | 一致 |
| WorktreeList.tsxのsetIntervalにガードなし | ガードなし | L123-128にガードなしのsetInterval | 一致 |
| fetchWorktrees(true)サイレント更新 | silentパラメータで制御 | L65のfetchWorktrees(silent=false)とL125のfetchWorktrees(true) | 一致 |
| handleRetryのuseCallback依存配列 | メモ化されている | L1442に[fetchWorktree, fetchMessages, fetchCurrentOutput] | 一致 |
| DUPLICATE_PREVENTION_WINDOW_MS | 3000ms | useAutoYes.ts L19に`const DUPLICATE_PREVENTION_WINDOW_MS = 3000` | 一致 |
| ファイル総行数 | 2006行 | wc -lで2006行 | 一致 |
| APIエンドポイント4種 | 設計書Section 7-1に記載 | 全route.tsファイルの存在を確認 | 一致 |
| debounce関数の存在 | src/lib/utils.tsに存在 | L25にexport function debounce定義 | 一致 |
| ErrorDisplay使用箇所 | error時にhandleRetryと共に使用 | L1536に`<ErrorDisplay message={error} onRetry={handleRetry} />` | 一致 |
| handleRetryの依存配列 | fetchWorktree, fetchMessages, fetchCurrentOutput | L1442に正確に一致 | 一致 |

### 不一致・部分一致の項目

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| lastServerResponseTimestamp保護機構 | Section 6-2: 「サーバー側重複防止」として有効と評価 | CurrentOutputResponseインターフェース(L68-81)に未定義。useAutoYes呼び出し(L1424-1431)に未渡し | **不一致**: APIレスポンスには含まれるが、フロントエンドで利用されていない |
| clearErrorの行番号 | Section 5-2: 「useWorktreeUIState.ts L270」 | L270はアクションクリエータ定義。reducerのCLEAR_ERRORはL118-119 | **部分一致**: L270はアクションクリエータとして正確だが、「useReducer」と対比した記載が曖昧 |
| WorktreeList.tsxのerror状態 | Section 4-4: 「error状態が発生しない」 | L35にerror useState、L75にsetError、L422-426にerror表示UI | **不正確**: error状態は発生するが、ポーリング停止には至らない |

---

## Findings

### Must Fix (1件)

#### [IC-001] handleRetryフロー記載の分岐条件の明示不足

- **設計書箇所**: Section 4-2
- **影響度**: Low
- **説明**: 設計書ではhandleRetry()のフローを番号付きリスト(1-6)で記載しているが、ステップ3(fetchWorktree)の結果に応じてステップ4,5が条件分岐する点が番号付きリストのフォーマット上で明示されていない。実装(L1437-1441)では`if (worktreeData)`の分岐が存在する。
- **実装コード参照**:
  ```typescript
  // WorktreeDetailRefactored.tsx L1434-1442
  const handleRetry = useCallback(async (): Promise<void> => {
    setError(null);
    setLoading(true);
    const worktreeData = await fetchWorktree();
    if (worktreeData) {
      await Promise.all([fetchMessages(), fetchCurrentOutput()]);
    }
    setLoading(false);
  }, [fetchWorktree, fetchMessages, fetchCurrentOutput]);
  ```
- **推奨対応**: Section 4-2のフロー記載で条件分岐を明示する。

### Should Fix (2件)

#### [IC-002] useAutoYesへのlastServerResponseTimestamp未渡しの記載漏れ

- **設計書箇所**: Section 6-2 安全性評価表
- **影響度**: Medium
- **説明**: 設計書はuseAutoYesの保護機構として`lastServerResponseTimestamp`を列挙し「サーバー側でも保護」と評価しているが、実装上このパラメータはWorktreeDetailRefactored.tsxからuseAutoYesに渡されていない。APIの`/api/worktrees/:id/current-output`レスポンスにはこのフィールドが含まれる(route.ts L133)が、フロントエンドの`CurrentOutputResponse`インターフェース(L68-81)に定義がなく、`fetchCurrentOutput`内でも受け取っていない。
- **実装コード参照**:
  ```typescript
  // WorktreeDetailRefactored.tsx L1424-1431 - lastServerResponseTimestamp未渡し
  const { lastAutoResponse } = useAutoYes({
    worktreeId,
    cliTool: activeCliTab,
    isPromptWaiting: state.prompt.visible,
    promptData: state.prompt.data,
    autoYesEnabled,
  });
  ```
  ```typescript
  // CurrentOutputResponse interface L68-81 - lastServerResponseTimestampフィールドなし
  interface CurrentOutputResponse {
    isRunning: boolean;
    isGenerating?: boolean;
    isPromptWaiting?: boolean;
    promptData?: PromptData;
    content?: string;
    fullOutput?: string;
    realtimeSnippet?: string;
    thinking?: boolean;
    autoYes?: { enabled: boolean; expiresAt: number | null; };
  }
  ```
- **推奨対応**: Section 6-2の安全性評価表で、`lastServerResponseTimestamp`の有効範囲を「APIレスポンスに含まれるがフロントエンドで未接続」と注記する。または、本Issue対応でフロントエンド側の接続を行うかどうかを判断し記載する。

#### [IC-004] WorktreeList.tsxのerror状態に関する記載の不正確さ

- **設計書箇所**: Section 4-4 比較表
- **影響度**: Medium
- **説明**: 比較表で「復帰時のエラーリセット | 不要（error状態が発生しない）」と記載しているが、WorktreeList.tsxにはerror状態管理が存在する(L35, L75, L422-426)。正確にはerror状態は発生し得るが、setIntervalのポーリングがerror状態に関わらず継続するため、visibilitychange復帰時にエラーリセットの追加は不要、という論理が正しい。
- **実装コード参照**:
  ```typescript
  // WorktreeList.tsx L35 - error stateは存在する
  const [error, setError] = useState<string | null>(null);

  // WorktreeList.tsx L74-75 - エラー設定も存在する
  } catch (err) {
    setError(handleApiError(err));
  }

  // WorktreeList.tsx L123-128 - setIntervalにerrorガードなし
  useEffect(() => {
    const interval = setInterval(() => {
      fetchWorktrees(true); // Silent update
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchWorktrees]);
  ```
- **推奨対応**: Section 4-4の記載を「不要（error状態は発生し得るが、ポーリングがerrorに関わらず継続するため復帰時のリセットは不要）」に修正する。

### Consider (2件)

#### [IC-005] WorktreeList.tsxへのvisibilitychange追加時のWebSocket二重発火の設計根拠補足

- **設計書箇所**: Section 4-3
- **影響度**: Low
- **説明**: WorktreeList.tsxはWebSocket broadcast受信時にもfetchWorktrees(true)を呼び出す(L103-106)。visibilitychange復帰時のfetchWorktrees(true)呼び出しとの二重発火について、timestampガードなしの設計根拠が弱い。
- **推奨対応**: Section 4-3の設計根拠に「軽量GETリクエストの冪等性により二重発火しても安全」と補足する。

#### [IC-006] initialLoadCompletedRefとvisibilitychange復帰の相互作用の記載

- **設計書箇所**: 該当記載なし
- **影響度**: Low
- **説明**: WorktreeDetailRefactored.tsxのL959に`initialLoadCompletedRef`が存在し、handleRetry()はこのrefをリセットしない。visibilitychange復帰でhandleRetry()を呼ぶ場合にinitialLoadCompletedRefがtrueのままであることは意図した動作だが、設計書ではこの相互作用について言及がない。
- **推奨対応**: 将来のメンテナンス性のため、設計書に注記を追加することを検討。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 設計書の記載不正確による実装時の誤解 | Low | Low | P3 |
| セキュリティ | lastServerResponseTimestamp未接続による二重応答リスク | Low | Low | P3 |
| 運用リスク | 設計書と実装の乖離による保守性低下 | Low | Medium | P2 |

**総合リスク評価**: 低い。設計書の主要な技術的記載（行番号、定数値、関数構造、コンポーネント関係）は高い精度で実装と整合している。発見された不整合はいずれも軽微であり、設計の方向性や安全性に影響を与えるものではない。

---

## Summary of Verification Results

### 定数・関数・型の存在確認

| 要素 | 設計書参照 | 実装確認 | 結果 |
|------|-----------|---------|------|
| `IDLE_POLLING_INTERVAL_MS` | 5000ms | WorktreeDetailRefactored.tsx L91 | 存在確認済 |
| `ACTIVE_POLLING_INTERVAL_MS` | 2000ms | WorktreeDetailRefactored.tsx L88 | 存在確認済 |
| `DUPLICATE_PREVENTION_WINDOW_MS` | 3000ms | useAutoYes.ts L19 | 存在確認済 |
| `handleRetry()` | L1434-1442 | WorktreeDetailRefactored.tsx L1434-1442 | 存在確認済、内容一致 |
| `fetchWorktree()` | API呼び出し | WorktreeDetailRefactored.tsx L984-998 | 存在確認済 |
| `fetchMessages()` | API呼び出し | WorktreeDetailRefactored.tsx L1002-1013 | 存在確認済 |
| `fetchCurrentOutput()` | API呼び出し | WorktreeDetailRefactored.tsx L1017-1053 | 存在確認済 |
| `fetchWorktrees(silent)` | サイレント更新 | WorktreeList.tsx L65-81 | 存在確認済 |
| `clearError` action | useWorktreeUIState.ts | L270(アクションクリエータ)、L118-119(reducer) | 存在確認済 |
| `debounce()` | src/lib/utils.ts | L25 | 存在確認済 |
| `CurrentOutputResponse` | interface | WorktreeDetailRefactored.tsx L68-81 | 存在確認済 |
| `ErrorDisplay` | component | WorktreeDetailRefactored.tsx L540-L550 | 存在確認済 |
| `initialLoadCompletedRef` | ref | WorktreeDetailRefactored.tsx L959 | 存在確認済 |
| `RECOVERY_THROTTLE_MS` | 新規追加予定 | 未実装（設計書の新規定数） | 未実装は想定通り |

### 設計パターンの既存コードとの一貫性

| パターン | 設計書の主張 | 実装での検証 | 一貫性 |
|---------|------------|------------|--------|
| useEffect + cleanup | 既存パターンと一貫 | L1449-1476(初期ロード)、L1479-1493(ポーリング)で確認 | 一貫 |
| useCallback + 依存配列 | handleRetryはuseCallbackでメモ化 | L1434, L1442で確認 | 一貫 |
| ローカルuseState | error/loadingはローカルstate | L938-939で確認 | 一貫 |
| Promise.all並列取得 | fetchMessages + fetchCurrentOutput | L1439で確認 | 一貫 |
| fetchWorktrees(true) silent | バックグラウンド更新 | WorktreeList.tsx L65, L125で確認 | 一貫 |

---

## Approval Status

**Status: 条件付き承認 (Conditionally Approved)**

**Score: 4/5**

設計書は全体として高品質であり、実装コードとの整合性は高い。行番号、定数値、関数シグネチャ、コンポーネント関係の大部分が正確に記載されている。以下の条件を満たした上で実装に進むことを推奨する:

1. **Should Fix [IC-002]**: Section 6-2のlastServerResponseTimestampに関する記載を実装の現状と整合させる
2. **Should Fix [IC-004]**: Section 4-4のWorktreeList.tsxのerror状態に関する記載を修正する

Must Fix [IC-001]は影響度がLowであり、実装の理解を妨げるレベルではないため、実装前の修正は必須ではないが推奨する。

---

*レビュー実施日: 2026-02-13*
*レビュー対象: Issue #246 設計方針書 (Stage 1レビュー反映済み版)*
*レビュー種別: 整合性 (Consistency)*
