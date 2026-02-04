# Issue #153 レビューレポート

**レビュー日**: 2026-02-04
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |
| **合計** | **6** |

**総合評価**: Good

Issue #153は技術的に正確で、問題の根本原因分析と推奨される解決策が適切に記載されています。
行番号、コードスニペット、動作説明のすべてが実際のソースコードと一致しており、整合性は高いです。

---

## 検証結果

### 行番号の正確性

| Issue記載 | 実際のコード | 検証結果 |
|-----------|-------------|---------|
| `auto-yes-manager.ts:78-81` | Map宣言（78-81行目） | 一致 |
| `auto-yes-manager.ts:312-314` | scheduleNextPoll内setTimeout | 一致 |
| `auto-yes-manager.ts:358-360` | startAutoYesPolling内setTimeout | 一致 |

### 根本原因分析の正確性

Issue記載の「インメモリMapがモジュール再読み込みで再初期化される」という分析は技術的に正確です。
実際のコードでは、モジュールスコープで以下のように宣言されています:

```typescript
// src/lib/auto-yes-manager.ts:78-81
const autoYesStates = new Map<string, AutoYesState>();
const autoYesPollerStates = new Map<string, AutoYesPollerState>();
```

Next.jsの開発サーバーでファイル変更時にホットリロードが発生すると、このモジュールが再評価され、新しいMapインスタンスが作成されます。
一方、旧モジュールで開始されたsetTimeoutコールバックはNode.jsのイベントループに残り、旧Mapへの参照を保持したまま動作を継続します。

### 推奨解決策の妥当性

案1（globalThis）はNext.jsでの状態保持の標準的なパターンであり、技術的に妥当です。

---

## Should Fix（推奨対応）

### SF-1: テスト計画に自動テストが含まれていない

**カテゴリ**: 完全性
**場所**: ## テスト計画 セクション

**問題**:
手動検証手順のみが記載されており、自動テスト（ユニットテスト）の実装方針が不明確です。

**証拠**:
- テスト計画には「手動検証手順（開発環境）」と「手動検証手順（本番環境）」のみ記載
- 既存の`clearAllAutoYesStates()`と`clearAllPollerStates()`関数（173-194行目）がテスト用に用意されている

**推奨対応**:
ユニットテストの追加を検討し、globalThis使用時のテストリセット機構の活用方針を明記してください。
例: 「各テストケースのbeforeEachでclearAllAutoYesStates()とclearAllPollerStates()を呼び出し、状態をリセットする」

---

### SF-2: 案1のデメリット記述の補足不足

**カテゴリ**: 技術的妥当性
**場所**: ## 推奨される改善策 > 案1 セクション

**問題**:
「テスト時に状態リセットの考慮が必要」とデメリットに記載されていますが、既存のクリア関数によりこのデメリットは軽減されます。

**証拠**:
```typescript
// src/lib/auto-yes-manager.ts:173-176
export function clearAllAutoYesStates(): void {
  autoYesStates.clear();
}

// src/lib/auto-yes-manager.ts:191-194
export function clearAllPollerStates(): void {
  stopAllAutoYesPolling();
  autoYesPollerStates.clear();
}
```

**推奨対応**:
「既存のテスト用クリア関数がglobalThis移行後も使用可能であるため、テストへの影響は最小限」という補足を追加してください。

---

### SF-3: 再現手順の曖昧さ

**カテゴリ**: 明確性
**場所**: ## 再現手順 セクション

**問題**:
「しばらく待つ」という表現が曖昧で、開発モードと本番モードでトリガー条件が異なることが明確でありません。

**証拠**:
- 開発モード: ファイル変更時のホットリロードがトリガー
- 本番モード: ワーカー再起動やコールドスタートがトリガー（タイミングは予測困難）

**推奨対応**:
再現手順を以下のように明確化:

**開発環境:**
```
3. `src/lib/auto-yes-manager.ts` に空白行を追加して保存（ホットリロード発生）
```

**本番環境:**
```
3. 数十分〜数時間待機（Next.jsワーカー再起動を待つ）
```

---

## Nice to Have（あれば良い）

### NTH-1: 案2（DB永続化）の詳細スキーマ案

**カテゴリ**: 完全性
**場所**: ## 推奨される改善策 > 案2 セクション

**問題**:
将来的にDB永続化を採用する可能性があるなら、参考情報としてスキーマ案があると有用です。

**推奨対応**:
以下のようなスキーマ案を参考情報として追記:
```sql
ALTER TABLE worktrees ADD COLUMN auto_yes_enabled INTEGER DEFAULT 0;
ALTER TABLE worktrees ADD COLUMN auto_yes_expires_at INTEGER;
```

---

### NTH-2: ESLint `no-var` 無効化の説明

**カテゴリ**: 完全性
**場所**: ## 推奨される改善策 > 案1 コードスニペット

**問題**:
`// eslint-disable-next-line no-var` コメントの理由が説明されていません。

**推奨対応**:
「TypeScriptの`declare global`ブロック内では`const`や`let`は使用できず、`var`が必須」という補足を追加。

---

### NTH-3: CLAUDE.mdへの参照追加

**カテゴリ**: ドキュメント参照
**場所**: ## 関連Issue セクション

**問題**:
CLAUDE.mdの「Issue #138: サーバー側Auto-Yesポーリング」セクションへの参照がありません。

**推奨対応**:
「詳細設計は `CLAUDE.md` の関連セクション、および `dev-reports/design/issue-138-server-side-auto-yes-polling-design-policy.md` を参照」という補足を追加。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/auto-yes-manager.ts:78-81` | インメモリMap宣言（問題の根本原因） |
| `src/lib/auto-yes-manager.ts:312-314` | scheduleNextPoll内のsetTimeout |
| `src/lib/auto-yes-manager.ts:358-360` | startAutoYesPolling内のsetTimeout |
| `src/lib/auto-yes-manager.ts:173-194` | テスト用クリア関数 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | Auto-Yes APIエンドポイント |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 状態取得API |
| `src/hooks/useAutoYes.ts` | クライアント側フック |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | Issue #138の設計概要 |
| `dev-reports/design/issue-138-server-side-auto-yes-polling-design-policy.md` | 詳細設計書 |

---

## 結論

Issue #153は全体として高品質な記述がなされています。行番号、コードスニペット、技術分析のすべてが正確であり、推奨解決策も妥当です。

Must Fixに該当する重大な問題はありません。Should Fixの3点を対応することで、Issueの明確性と完全性がさらに向上します。

**推奨アクション**:
1. テスト計画に自動テストの方針を追記
2. 再現手順の曖昧さを解消
3. 案1のデメリット記述を補足
