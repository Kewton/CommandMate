# Issue #153: Auto-Yes UIとバックグラウンドの状態不整合 - 設計方針書

## 1. 概要

Auto-Yesモードを有効化後、バックグラウンドでは正常動作するがUIは「オフ」と表示される問題の修正。インメモリ状態管理の脆弱性（モジュール再読み込み時の状態リセット）に対処する。

**優先度**: 高（本番環境でも発生確認済み）

## 2. 問題の詳細

### 2.1 現象

| 項目 | 実際の状態 |
|------|-----------|
| サーバーログ | `[Auto-Yes Poller] Sent response` ✅ 動作中 |
| GET `/auto-yes` API | `{ enabled: false }` ❌ |
| GET `/current-output` API | `{ autoYes: { enabled: false }, lastServerResponseTimestamp: null }` ❌ |
| UIトグル | オフ ❌ |

### 2.2 根本原因

`auto-yes-manager.ts` はモジュールスコープの `Map` で状態を管理しているため、モジュール再読み込み時に状態がリセットされる。

**該当コード**: `src/lib/auto-yes-manager.ts:78-81`

```typescript
const autoYesStates = new Map<string, AutoYesState>();
const autoYesPollerStates = new Map<string, AutoYesPollerState>();
```

**発生トリガー**:

| 環境 | 原因 |
|------|------|
| 開発環境 | Next.jsホットリロードによるモジュール再読み込み |
| 本番環境 | Next.jsワーカー再起動、メモリ圧力、APIルートのコールドスタート |

### 2.3 問題の動作フロー

```
1. ユーザーがAuto-Yesを有効化
   → setAutoYesEnabled() が autoYesStates Map に状態を格納
   → startAutoYesPolling() が autoYesPollerStates Map にポーラー状態を格納
   → setTimeout() がNode.jsイベントループにタイマーを登録

2. モジュール再読み込み発生
   → auto-yes-manager.ts モジュールが再読み込み
   → 新しい空の Map インスタンスが作成（78-81行目）
   → 旧 setTimeout は旧 Map への参照を保持したまま継続

3. UIがGET /api/worktrees/:id/auto-yes を呼び出し
   → 新モジュールの getAutoYesState() が呼ばれる
   → 新しい空の Map を参照 → enabled: false を返却
```

## 3. 設計方針

### 3.1 採用案: globalThisによる状態永続化

**選択肢の比較**:

| 方式 | メリット | デメリット | 推奨度 |
|------|---------|-----------|--------|
| **globalThis (採用)** | 実装コスト低（〜20行）、開発・本番両環境で有効 | テスト時状態リセット考慮必要（既存clear関数で対応可） | ★★★ |
| DB永続化 | 最も信頼性が高い、サーバー再起動後も状態復元可能 | 実装コスト高（マイグレーション + CRUD） | ★★ |
| クリーンアップ機構 | 孤児ポーラー問題を解決 | 状態不整合の根本解決にはならない | ★ |

**決定理由**:
- 費用対効果が最も高い
- 既存のクリア関数（`clearAllAutoYesStates`, `clearAllPollerStates`）がglobalThis移行後も使用可能
- エクスポートされる関数インターフェースは変更不要

#### 3.1.1 既存クリア関数のglobalThis対応（NTH-004）

既存の `clearAllAutoYesStates()` と `clearAllPollerStates()` 関数は、globalThis移行後も変更なしで正常動作する。これは、これらの関数が内部で `autoYesStates.clear()` / `autoYesPollerStates.clear()` を呼び出しており、globalThis上のMapインスタンスへの参照を維持したままコンテンツをクリアするため。

```typescript
// 既存実装（auto-yes-manager.ts L173-175, L191-194）
export function clearAllAutoYesStates(): void {
  autoYesStates.clear(); // globalThis.__autoYesStates への参照を維持したままクリア
}

export function clearAllPollerStates(): void {
  autoYesPollerStates.clear(); // globalThis.__autoYesPollerStates への参照を維持したままクリア
}
```

この動作により、テストの `beforeEach` でクリア関数を呼び出すだけで状態を初期化でき、globalThisへの直接アクセス（`delete globalThis.__autoYesStates`）は不要。

### 3.2 実装方針

#### 3.2.1 変更対象

- `src/lib/auto-yes-manager.ts` のみ（約20行の変更）

#### 3.2.2 変更内容

**Before**:
```typescript
const autoYesStates = new Map<string, AutoYesState>();
const autoYesPollerStates = new Map<string, AutoYesPollerState>();
```

**After**:
```typescript
/**
 * globalThisを使用してNext.jsのホットリロード/ワーカー再起動に対応
 *
 * 背景:
 * - 開発環境: ホットリロードでモジュールが再読み込みされると、モジュールスコープの変数は再初期化される
 * - 本番環境: APIルートのコールドスタートやワーカー再起動で同様の現象が発生
 * - しかし、Node.jsのイベントループにスケジュールされたsetTimeoutは継続動作する
 *
 * 対策:
 * - globalThisに状態を格納することで、モジュール再読み込み後も同一のMapインスタンスを参照
 * - nullish coalescing (??) で初回のみMapを作成し、以降は既存インスタンスを使用
 */
declare global {
  // eslint-disable-next-line no-var
  // TypeScriptのglobal宣言ではconstではなくvarが必要
  var __autoYesStates: Map<string, AutoYesState> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());

const autoYesPollerStates = globalThis.__autoYesPollerStates ??
  (globalThis.__autoYesPollerStates = new Map<string, AutoYesPollerState>());
```

#### 3.2.3 命名規則の検討（SF-002）

**現在の設計**: `__autoYesStates` / `__autoYesPollerStates`

**将来の拡張を考慮した代替案**:

プロジェクト全体でglobalThis変数を使用する場合、グローバル名前空間の衝突を防ぐため、プロジェクト固有のプレフィックスを検討する:

| 命名パターン | 例 | メリット | デメリット |
|-------------|-----|---------|-----------|
| 現在の設計 | `__autoYesStates` | シンプル、可読性良好 | 他ライブラリとの衝突リスク |
| プロジェクトプレフィックス | `__cm_autoYesStates` | 明確な名前空間分離 | やや冗長 |
| 一元管理ユーティリティ | `createPersistentMap('autoYesStates')` | DRY、型安全 | 実装コスト増 |

**推奨**: 本Issueでは現在の設計（`__autoYesStates`）を採用し、将来のglobalThis使用箇所の拡大時（セクション6.1のフォローアップIssue）で命名規則を統一する。その際、`__cm_` プレフィックスまたは `createPersistentMap` ユーティリティの導入を検討する。

### 3.3 影響範囲

#### 3.3.1 変更影響

| カテゴリ | 影響 |
|---------|------|
| 変更対象ファイル | `src/lib/auto-yes-manager.ts` のみ |
| 関数インターフェース | 変更なし（全関数のシグネチャは維持） |
| 呼び出し元 | 変更不要 |
| 既存テスト | 既存クリア関数が引き続き動作 |
| メモリ | 同等フットプリント（想定worktree数100未満で無視できる程度） |

#### 3.3.2 影響レベル

**低** - 内部状態格納メカニズムのみの変更

### 3.4 関連機能への影響

| 機能 | 影響 |
|------|------|
| Issue #138 サーバー側ポーリング | 直接恩恵を受ける（この修正の対象） |
| useAutoYes クライアントフック | 変更不要（API経由で正しい状態を取得） |
| GET /auto-yes API | 変更不要（内部でgetAutoYesState()を呼び出し） |
| GET /current-output API | 変更不要（内部でgetAutoYesState(), getLastServerResponseTimestamp()を呼び出し） |
| POST /auto-yes API | 変更不要（内部でsetAutoYesEnabled(), startAutoYesPolling()を呼び出し） |
| session-cleanup.ts | 変更不要（stopAutoYesPolling()の動作は同一） |
| server.ts graceful shutdown | 変更不要（stopAllAutoYesPolling()の動作は同一） |

## 4. テスト方針

### 4.1 自動テスト

既存のテスト用クリア関数を活用した回帰テスト:

```typescript
// tests/unit/lib/auto-yes-manager.test.ts
import {
  clearAllAutoYesStates,
  clearAllPollerStates,
  setAutoYesEnabled,
  getAutoYesState
} from '@/lib/auto-yes-manager';

beforeEach(() => {
  clearAllAutoYesStates();
  clearAllPollerStates();
});

describe('globalThis state management', () => {
  test('状態がglobalThisに正しく格納される', () => {
    setAutoYesEnabled('test-worktree', true);
    expect(globalThis.__autoYesStates).toBeInstanceOf(Map);
    expect(globalThis.__autoYesStates?.has('test-worktree')).toBe(true);
  });

  test('クリア関数がglobalThis上のMapをクリアする', () => {
    setAutoYesEnabled('test-worktree', true);
    clearAllAutoYesStates();
    expect(globalThis.__autoYesStates?.size).toBe(0);
  });

  test('モジュール再読み込み後も状態が維持される（シミュレーション）', () => {
    setAutoYesEnabled('test-worktree', true);

    // モジュール再読み込みをシミュレート: 新しいMapを作成しない
    const statesAfterReload = globalThis.__autoYesStates ?? new Map();
    expect(statesAfterReload.has('test-worktree')).toBe(true);
  });
});
```

#### 4.1.1 統合テストでのモジュール再読み込みシミュレーション（推奨）

**ステータス**: 推奨（Stage 3レビュー SF-004により、オプションから推奨に昇格）

**理由**: このテストは根本原因（モジュール再読み込み時の状態リセット）に対する修正を直接検証するため、実装を推奨する。

より現実的なモジュール再読み込みシナリオをテストする場合、Vitest（または Jest）の `vi.isolateModules` / `vi.resetModules` を使用できる:

```typescript
// tests/integration/auto-yes-persistence.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

describe('モジュール再読み込み耐性', () => {
  beforeEach(() => {
    // globalThis上の状態をクリア
    delete globalThis.__autoYesStates;
    delete globalThis.__autoYesPollerStates;
  });

  test('モジュール再読み込み後も状態が維持される', async () => {
    // 1. 初回モジュール読み込みで状態を設定
    const { setAutoYesEnabled } = await import('@/lib/auto-yes-manager');
    setAutoYesEnabled('test-worktree', true);

    // 2. モジュールキャッシュをリセット
    vi.resetModules();

    // 3. モジュール再読み込み後、状態が維持されていることを確認
    const { getAutoYesState } = await import('@/lib/auto-yes-manager');
    const state = getAutoYesState('test-worktree');
    expect(state?.enabled).toBe(true);
  });
});
```

**注意**: この統合テストは根本原因の修正を検証する重要なテストである。基本的なユニットテストと併せて実装することを推奨する。

**型安全性に関する注意（NTH-006）**: テストで `globalThis.__autoYesStates` にアクセスする際は、明示的な型ガードを使用することを推奨する:

```typescript
expect(globalThis.__autoYesStates).toBeInstanceOf(Map);
// 型ガード後にMapメソッドにアクセス
```

#### 4.1.2 本番環境シナリオのテスト（NTH-003）

開発環境のホットリロードと本番環境のワーカー再起動では、モジュール再読み込みの挙動が異なる可能性がある。より厳密なテストを行う場合、`NODE_ENV=production` でのテスト実行を検討する:

```typescript
// tests/integration/auto-yes-persistence.production.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

describe('本番環境シナリオ: モジュール再読み込み耐性', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete globalThis.__autoYesStates;
    delete globalThis.__autoYesPollerStates;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('本番環境でもモジュール再読み込み後に状態が維持される', async () => {
    const { setAutoYesEnabled } = await import('@/lib/auto-yes-manager');
    setAutoYesEnabled('test-worktree', true);

    vi.resetModules();

    const { getAutoYesState } = await import('@/lib/auto-yes-manager');
    const state = getAutoYesState('test-worktree');
    expect(state?.enabled).toBe(true);
  });
});
```

**注意**: このテストは基本的な動作検証完了後、本番環境での問題報告があった場合に追加する。現時点ではオプションとして位置付ける。

### 4.2 手動テスト

#### 開発環境

1. `npm run dev` でサーバー起動
2. Worktree詳細画面でAuto-Yesを有効化
3. `src/lib/auto-yes-manager.ts` に空白行を追加して保存（ホットリロード発生）
4. UIのトグル状態が「オン」のままであることを確認
5. サーバーログで `[Auto-Yes Poller]` のログが継続していることを確認

#### 本番環境

1. `npm run build && npm start` でサーバー起動
2. Worktree詳細画面でAuto-Yesを有効化
3. 数十分〜数時間待機
4. UIのトグル状態が「オン」のままであることを確認

## 5. セキュリティ考慮事項

### 5.1 既存のセキュリティ対策（維持）

| 対策 | 詳細 |
|------|------|
| worktreeID形式検証 | `WORKTREE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/`（コマンドインジェクション防止） |
| 同時ポーラー数制限 | `MAX_CONCURRENT_POLLERS = 50`（DoS防止） |
| ログへの機密情報非出力 | プロンプト内容をログに出力しない |

### 5.2 追加リスク評価

| リスク | 評価 |
|--------|------|
| globalThisへの外部アクセス | 低: Node.js内部のみ、ブラウザからアクセス不可 |
| 状態の競合 | 低: JavaScriptはシングルスレッド、nullish coalescingで安全初期化 |
| メモリリーク | 低: 既存のクリーンアップ機構（stopAutoYesPolling, stopAllAutoYesPolling）が継続動作 |

### 5.3 OWASP Top 10 (2021) コンプライアンス評価（Stage 4レビュー結果）

Stage 4セキュリティレビューにおいて、OWASP Top 10 (2021) の全カテゴリに対する評価を実施。globalThisベースの状態管理導入による新たなセキュリティリスクは確認されなかった。

| カテゴリ | ステータス | 備考 |
|---------|-----------|------|
| A01 アクセス制御の不備 | Pass | validateWorktreeExists()による適切なアクセス制御 |
| A02 暗号化の失敗 | N/A | 本モジュールで暗号化操作なし |
| A03 インジェクション | Pass | WORKTREE_ID_PATTERN検証、resolveAutoAnswer()は安全な静的値のみ返却 |
| A04 安全でない設計 | Pass | MAX_CONCURRENT_POLLERS、AUTO_YES_TIMEOUT_MS、指数バックオフによる保護 |
| A05 セキュリティ設定のミス | Pass | 安全なデフォルト設定（Auto-Yesはデフォルト無効） |
| A06 脆弱なコンポーネント | N/A | 外部依存追加なし（globalThisはネイティブ機能） |
| A07 認証の失敗 | N/A | 認証はCM_AUTH_TOKENで上位レイヤーにて対応 |
| A08 データの整合性 | Pass | サーバーサイドのみ、シングルスレッド実行モデルで競合なし |
| A09 ログとモニタリングの失敗 | Pass | 適切なセキュリティログ記録、機密情報非出力 |
| A10 SSRF | N/A | ローカルtmuxセッションのみ操作、外部リクエストなし |

**追加セキュリティチェック結果**:
- 競合状態: Pass（JavaScriptシングルスレッド + nullish coalescingによるアトミック初期化）
- DoS保護: Pass（複数の保護メカニズム実装済み）
- 入力検証: Pass（worktreeID、enabledブール値、CLIツールIDのホワイトリスト検証）
- tmuxコマンドインジェクション: Pass（セッション名検証、sendKeys()のエスケープ処理）

**総合評価**: セキュア - 既存のセキュリティ対策が維持され、新たな脆弱性は導入されていない。

### 5.4 将来的なセキュリティ改善（低優先度）

**NTH-SEC-002: Auto-Yes有効化APIへのレート制限検討**

Stage 4レビューにより、以下の防御強化策が提案された:

- **対象**: `POST /api/worktrees/:id/auto-yes` エンドポイント
- **背景**: MAX_CONCURRENT_POLLERSによるDoS保護は存在するが、APIエンドポイント自体にはレート制限がない
- **リスク**: 悪意あるクライアントがAuto-Yesの有効/無効を高速に切り替えることによるCPUオーバーヘッド
- **リスクレベル**: 低（CommandMateはローカル開発ツールであり、信頼されないクライアントに公開される想定ではない）
- **対応方針**: 現時点では対応不要。外部クライアントに公開する場合はレート制限ミドルウェアの導入を検討する

## 6. 検討事項（将来対応）

以下のファイルも同様のインメモリMap管理パターンを使用しており、同様の問題が発生する可能性がある:

| ファイル | 該当行 | リスクレベル | 状態 |
|---------|--------|-------------|------|
| `src/lib/response-poller.ts` | L36, L41 | Medium | フォローアップ対象 |
| `src/lib/claude-poller.ts` | L26, L31 | Medium | フォローアップ対象 |

**Stage 3レビュー（SF-003）により特定された詳細**:
- `response-poller.ts`: `const activePollers = new Map<string, NodeJS.Timeout>();` (L36), `const pollingStartTimes = new Map<string, number>();` (L41)
- `claude-poller.ts`: `const activePollers = new Map<string, NodeJS.Timeout>();` (L26), `const pollingStartTimes = new Map<string, number>();` (L31)

これらのモジュールも `auto-yes-manager.ts` と同様の脆弱性を持つ。モジュール再読み込み時に孤児ポーラーが発生したり、重複ポーリングが起きる可能性がある。本Issue修正後、これらにも同様のglobalThisパターンを適用すべきか検討する。

### 6.1 DRY改善のためのフォローアップ（SF-001）

**推奨**: 本Issue修正完了後、以下のフォローアップIssueを作成する:

- **Issue タイトル**: `refactor: globalThis状態管理パターンの共通ユーティリティ化`
- **内容**:
  - `response-poller.ts` と `claude-poller.ts` も同様のインメモリMap管理パターンを使用している可能性を調査
  - 共通のユーティリティ関数（例: `createPersistentMap<K,V>()`）を抽出してDRYを促進
  - globalThisパターンの使用を一元化し、保守性を向上

```typescript
// 将来検討: src/lib/persistent-state.ts
export function createPersistentMap<K, V>(globalKey: string): Map<K, V> {
  const key = `__${globalKey}` as keyof typeof globalThis;
  return (globalThis[key] as Map<K, V> | undefined) ??
    ((globalThis as Record<string, unknown>)[key] = new Map<K, V>()) as Map<K, V>;
}

// 使用例
// const autoYesStates = createPersistentMap<string, AutoYesState>('autoYesStates');
```

### 6.2 クラスタモード・マルチプロセス環境の制限事項（NTH-005）

**Stage 3レビューにより追加**

globalThisベースの状態管理はプロセスローカルであり、以下の環境では追加の考慮が必要:

| 環境 | 影響 | 対応策 |
|------|------|--------|
| Node.js クラスタモード | 各ワーカーが独立したglobalThisを持つため、状態は共有されない | 単一ワーカー運用を推奨、または外部ストア（Redis等）の導入を検討 |
| サーバーレス（Vercel, Lambda） | コールドスタート時に新プロセスが起動し、状態はリセットされる | サーバーレスでの長期ポーリングは非推奨 |
| 単一サーバー・単一プロセス | 正常動作（globalThisは永続化される） | 推奨構成 |

**CommandMateの現在の運用モード**: 単一サーバー・単一プロセス（`npm start` / `commandmate start`）であるため、クラスタモードの影響は受けない。将来的にクラスタモードやサーバーレスデプロイを検討する場合、Redisなどの外部状態ストアの導入を検討する。

**CLAUDE.mdへの追記（実装完了時に対応 - NTH-SEC-001）**:

Stage 4セキュリティレビュー（NTH-SEC-001）により、本制限事項をCLAUDE.mdに明記することが推奨された。実装完了時にCLAUDE.mdの「Issue #153」セクションに以下の警告を追加する:

- globalThisベースの状態管理はプロセスローカルであり、マルチプロセス環境には適さない
- Node.jsクラスタモードやサーバーレス環境では状態が正しく共有されない
- CommandMateは単一プロセス運用を前提とした設計

### 6.3 ドキュメント更新（NTH-001）

**推奨**: 実装完了後、CLAUDE.mdの「最近の実装機能」セクションに以下を追記:

- Issue #153の概要と解決策
- globalThisパターンの採用理由
- Next.jsプロジェクトでのモジュール再読み込み問題への対処法としてのglobalThis使用ガイドライン

## 7. 受け入れ条件

- [ ] Auto-Yesを有効化後、モジュール再読み込みが発生してもUI状態が正しく表示されること
- [ ] UIからOFFにした場合、バックグラウンドポーラーも確実に停止すること
- [ ] `lastServerResponseTimestamp`が正しく更新されること
- [ ] 開発環境・本番環境の両方で問題が発生しないことを確認
- [ ] 既存の自動テストがすべてパスすること

## 8. 関連ドキュメント

- Issue #153: https://github.com/Kewton/CommandMate/issues/153
- Issue #138: サーバー側Auto-Yesポーリング実装
- CLAUDE.md「Issue #138: サーバー側Auto-Yesポーリング」セクション
- Issue #61 設計方針書: `dev-reports/design/issue-61-auto-yes-mode-design-policy.md`

## 9. 変更履歴

| 日付 | 変更内容 |
|------|---------|
| 2026-02-04 | 初版作成 |
| 2026-02-04 | Stage 1レビュー指摘対応: SF-001（DRYフォローアップIssue追記）、NTH-001（ドキュメント更新推奨追記）、NTH-002（統合テストオプション追記） |
| 2026-02-04 | Stage 2レビュー指摘対応: SF-002（セクション3.2.3 命名規則の検討追加）、NTH-003（セクション4.1.2 本番環境シナリオテスト追加）、NTH-004（セクション3.1.1 クリア関数のglobalThis対応説明追加） |
| 2026-02-04 | Stage 3レビュー指摘対応: SF-003（セクション6 類似パターン詳細化: response-poller.ts L36,41, claude-poller.ts L26,31を明記）、SF-004（セクション4.1.1 モジュール再読み込みテストをオプションから推奨に昇格）、NTH-005（セクション6.2 クラスタモード/マルチプロセス制限事項を追加）、NTH-006（セクション4.1.1 テストでの型安全性注記追加） |
| 2026-02-04 | Stage 4セキュリティレビュー指摘対応: OWASP Top 10コンプライアンス評価結果追加（セクション5.3）、NTH-SEC-001（セクション6.2 CLAUDE.md追記推奨の詳細化）、NTH-SEC-002（セクション5.4 Auto-Yes APIレート制限の将来検討追加） |
