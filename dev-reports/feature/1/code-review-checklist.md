# コードレビューチェックリスト
# myCodeBranchDesk - コードレビュー & リファクタリングガイド

**作成日**: 2025-11-17
**対象**: Issue #1 - 初版開発
**目的**: コード品質の維持・向上

---

## 目次

1. [レビュープロセス](#レビュープロセス)
2. [Phase別レビューポイント](#phase別レビューポイント)
3. [共通チェック項目](#共通チェック項目)
4. [リファクタリングガイド](#リファクタリングガイド)
5. [レビューコメント例](#レビューコメント例)

---

## レビュープロセス

### レビューのタイミング

```
実装完了
    ↓
セルフレビュー（このチェックリスト使用）
    ↓
リファクタリング
    ↓
テスト実行（すべてpass）
    ↓
コミット
    ↓
PR作成（他者レビュー）
    ↓
フィードバック対応
    ↓
マージ
```

### レビューの心構え

#### レビュアー
- ✅ 建設的なフィードバック
- ✅ 代替案の提示
- ✅ コードの意図を理解する努力
- ❌ 単なる批判
- ❌ スタイルの押し付け

#### 被レビュアー
- ✅ フィードバックを歓迎
- ✅ 質問・不明点の明確化
- ✅ 学びの機会として活用
- ❌ 防御的な態度
- ❌ フィードバックの無視

---

## Phase別レビューポイント

### Phase 2: データレイヤー

#### チェック項目

**データベーススキーマ**
- [ ] テーブル名は複数形で統一されているか
- [ ] カラム名はsnake_caseか
- [ ] 適切なINDEXが設定されているか
- [ ] 外部キー制約が適切か
- [ ] NOT NULL制約が適切か

**型定義**
- [ ] interfaceとtypeの使い分けが適切か
- [ ] オプショナルプロパティ（?）が適切か
- [ ] enumの使用が適切か
- [ ] 型エクスポートが適切か

**CRUD操作**
- [ ] SQL injectionのリスクはないか（プリペアドステートメント使用）
- [ ] エラーハンドリングが適切か
- [ ] トランザクションが必要な箇所で使われているか
- [ ] リソースリーク（DB接続閉じ忘れ）はないか

**テスト**
- [ ] すべてのCRUD操作にテストがあるか
- [ ] エッジケースがカバーされているか
- [ ] テストデータがクリーンアップされるか

---

### Phase 3: Worktree管理

#### チェック項目

**パース処理**
- [ ] 正規表現が適切か
- [ ] エッジケース（空文字、特殊文字）が処理されるか
- [ ] エラーハンドリングが適切か

**ID生成**
- [ ] URLセーフな文字のみ使用しているか
- [ ] 一意性が保証されるか
- [ ] 衝突時の対処があるか

**git連携**
- [ ] コマンド実行のエラーハンドリングがあるか
- [ ] 存在しないディレクトリへの対処があるか
- [ ] パス traversal 対策があるか

**テスト**
- [ ] 実際のgit出力でテストされているか
- [ ] モックが適切に使われているか

---

### Phase 4: tmux統合

#### チェック項目

**セキュリティ**
- [ ] コマンドインジェクションのリスクはないか
- [ ] ユーザー入力のエスケープが適切か
- [ ] 環境変数の検証があるか

**エラーハンドリング**
- [ ] tmuxが存在しない場合の対処があるか
- [ ] セッションが存在しない場合の対処があるか
- [ ] タイムアウト処理があるか

**リソース管理**
- [ ] セッションリークはないか
- [ ] プロセスゾンビ対策があるか
- [ ] メモリリークはないか

**テスト**
- [ ] モックを使用して外部依存を排除しているか
- [ ] 統合テストで実際のtmuxを使用しているか

---

### Phase 5: API Routes

#### チェック項目

**リクエスト処理**
- [ ] バリデーションが適切か
- [ ] 型チェックがあるか
- [ ] エラーレスポンスが統一されているか

**セキュリティ**
- [ ] 認証ミドルウェアが適用されているか
- [ ] 入力サニタイゼーションがあるか
- [ ] レート制限が必要な箇所にあるか（将来的に）

**パフォーマンス**
- [ ] N+1クエリはないか
- [ ] 不要なDB問い合わせはないか
- [ ] ページネーションが実装されているか

**レスポンス**
- [ ] 一貫したレスポンス形式か
- [ ] 適切なHTTPステータスコードか
- [ ] エラーメッセージがユーザーフレンドリーか

**テスト**
- [ ] 正常系がテストされているか
- [ ] 異常系がテストされているか
- [ ] 境界値がテストされているか

---

### Phase 6: WebSocket

#### チェック項目

**接続管理**
- [ ] 接続数の制限があるか（将来的に）
- [ ] メモリリークはないか
- [ ] 切断時のクリーンアップがあるか

**メッセージ処理**
- [ ] JSON parseエラー処理があるか
- [ ] 不正なメッセージ形式への対処があるか
- [ ] メッセージサイズ制限があるか（将来的に）

**ブロードキャスト**
- [ ] 対象クライアントのフィルタリングが正しいか
- [ ] 送信エラー処理があるか
- [ ] パフォーマンスボトルネックはないか

**テスト**
- [ ] 接続・切断がテストされているか
- [ ] メッセージ送受信がテストされているか
- [ ] 複数クライアントがテストされているか

---

### Phase 7: 認証・セキュリティ

#### チェック項目

**認証**
- [ ] トークン検証が正しいか
- [ ] タイミング攻撃対策があるか（定数時間比較）
- [ ] トークンがログに出力されないか

**セキュリティヘッダー**
- [ ] CSPが設定されているか（将来的に）
- [ ] X-Frame-Optionsが設定されているか
- [ ] CORS設定が適切か

**環境変数**
- [ ] 必須変数のチェックがあるか
- [ ] デフォルト値が適切か
- [ ] .env.exampleが最新か

**テスト**
- [ ] 認証成功ケースがテストされているか
- [ ] 認証失敗ケースがテストされているか
- [ ] 環境変数の組み合わせがテストされているか

---

### Phase 8-10: UI実装

#### チェック項目

**コンポーネント設計**
- [ ] 適切な粒度に分割されているか
- [ ] Props型定義があるか
- [ ] デフォルトPropsが適切か

**状態管理**
- [ ] useState/useReducerの使い分けが適切か
- [ ] 不要な再レンダリングはないか
- [ ] useCallbackでメモ化すべき箇所があるか

**パフォーマンス**
- [ ] React.memoが必要な箇所で使われているか
- [ ] useEffectの依存配列が適切か
- [ ] 無限ループのリスクはないか

**アクセシビリティ**
- [ ] セマンティックHTMLが使われているか
- [ ] ARIA属性が適切か
- [ ] キーボード操作が可能か

**レスポンシブ**
- [ ] モバイル表示が崩れないか
- [ ] タッチ操作に対応しているか
- [ ] ビューポートが適切か

**テスト**
- [ ] レンダリングテストがあるか
- [ ] ユーザー操作がテストされているか
- [ ] エラー状態がテストされているか

---

## 共通チェック項目

### 1. コード品質

#### 可読性
- [ ] 変数名・関数名が意図を明確に表しているか
- [ ] マジックナンバーが定数化されているか
- [ ] ネストが深すぎないか（3階層以下）
- [ ] 関数が単一責任になっているか

**悪い例**:
```typescript
function f(a: string) {
  if (a.length > 0) {
    if (a.includes('/')) {
      return a.replace(/\//g, '-').toLowerCase();
    }
  }
  return a;
}
```

**良い例**:
```typescript
/**
 * ブランチ名をURLセーフなIDに変換
 */
function generateWorktreeId(branchName: string): string {
  if (!branchName) {
    return branchName;
  }

  return branchName
    .replace(/\//g, '-')
    .toLowerCase();
}
```

---

#### DRY原則（Don't Repeat Yourself）
- [ ] 重複コードがないか
- [ ] 共通処理が関数化されているか
- [ ] ユーティリティ関数が適切に使われているか

**リファクタリング例**:

```typescript
// ❌ 重複あり
const user1 = await fetch('/api/users/1').then(r => r.json());
const user2 = await fetch('/api/users/2').then(r => r.json());

// ✅ 共通化
async function fetchUser(id: number) {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

const user1 = await fetchUser(1);
const user2 = await fetchUser(2);
```

---

#### SOLID原則

**Single Responsibility（単一責任）**
- [ ] 1つの関数/クラスが1つの責任のみ持つか

**Open/Closed（開放/閉鎖）**
- [ ] 拡張に開いていて、修正に閉じているか

**Liskov Substitution（リスコフの置換）**
- [ ] サブタイプが基本型と置換可能か

**Interface Segregation（インターフェース分離）**
- [ ] インターフェースが適切に分離されているか

**Dependency Inversion（依存性逆転）**
- [ ] 具象ではなく抽象に依存しているか

---

### 2. TypeScript

#### 型定義
- [ ] `any`が使われていないか
- [ ] 型アサーション（as）の使用が最小限か
- [ ] ジェネリクスが適切に使われているか
- [ ] nullableな値の処理が適切か

**改善例**:

```typescript
// ❌ 悪い例
function getData(): any {
  return fetch('/api/data');
}

// ✅ 良い例
interface ApiData {
  id: string;
  name: string;
}

async function getData(): Promise<ApiData> {
  const response = await fetch('/api/data');
  return response.json();
}
```

---

### 3. エラーハンドリング

- [ ] try-catchが適切に使われているか
- [ ] エラーメッセージが明確か
- [ ] エラーログが出力されているか
- [ ] ユーザーに適切なエラーが表示されるか

**改善例**:

```typescript
// ❌ 悪い例
async function createSession(name: string) {
  await exec(`tmux new-session -d -s ${name}`);
}

// ✅ 良い例
async function createSession(name: string): Promise<void> {
  try {
    await exec(`tmux new-session -d -s "${name}"`);
  } catch (error) {
    console.error(`Failed to create tmux session: ${name}`, error);
    throw new AppError(
      500,
      `Failed to create session: ${(error as Error).message}`,
      'TMUX_SESSION_CREATE_FAILED'
    );
  }
}
```

---

### 4. セキュリティ

- [ ] SQLインジェクション対策があるか
- [ ] コマンドインジェクション対策があるか
- [ ] XSS対策があるか
- [ ] CSRF対策があるか（APIトークン認証なので不要な場合も）
- [ ] 認証・認可が適切か
- [ ] 機密情報がログに出力されないか

---

### 5. パフォーマンス

- [ ] 不要な計算が繰り返されていないか
- [ ] メモリリークのリスクはないか
- [ ] 大量データの処理が最適化されているか
- [ ] ページネーションが必要な箇所にあるか

---

### 6. テスト

- [ ] テストカバレッジが目標を満たしているか
- [ ] テストが独立しているか
- [ ] テストが明確な意図を持っているか
- [ ] テストが高速か

---

### 7. ドキュメント

- [ ] JSDocコメントがあるか（public関数）
- [ ] 複雑なロジックにコメントがあるか
- [ ] READMEが更新されているか
- [ ] 型定義がドキュメント代わりになっているか

**良い例**:

```typescript
/**
 * git worktreeをスキャンしてWorktreeオブジェクトのリストを返す
 *
 * @param rootDir - スキャン対象のルートディレクトリ
 * @returns Worktreeオブジェクトの配列
 * @throws {AppError} gitリポジトリでない場合
 *
 * @example
 * ```typescript
 * const worktrees = await scanWorktrees('/path/to/repo');
 * console.log(worktrees[0].id); // "main"
 * ```
 */
export async function scanWorktrees(rootDir: string): Promise<Worktree[]> {
  // 実装
}
```

---

## リファクタリングガイド

### リファクタリングのタイミング

- ✅ テストが通っている時
- ✅ 重複コードを見つけた時
- ✅ 関数が長すぎる時（> 50行）
- ✅ ネストが深い時（> 3階層）
- ❌ テストが壊れている時
- ❌ 新機能実装中

---

### リファクタリングパターン

#### 1. 関数の抽出

**Before**:
```typescript
async function sendMessage(worktreeId: string, message: string) {
  const sessionName = `cw_${worktreeId}`;

  const exists = await hasSession(sessionName);
  if (!exists) {
    const worktree = await getWorktreeById(worktreeId);
    await exec(`tmux new-session -d -s "${sessionName}" -c "${worktree.path}"`);
    await exec(`tmux send-keys -t "${sessionName}" "export CLAUDE_HOOKS_STOP='...'" C-m`);
    await exec(`tmux send-keys -t "${sessionName}" "claude" C-m`);
  }

  await exec(`tmux send-keys -t "${sessionName}" "${message}" C-m`);
}
```

**After**:
```typescript
async function sendMessage(worktreeId: string, message: string) {
  const sessionName = `cw_${worktreeId}`;

  await ensureSessionExists(sessionName, worktreeId);
  await sendKeys(sessionName, message);
}

async function ensureSessionExists(sessionName: string, worktreeId: string) {
  const exists = await hasSession(sessionName);
  if (!exists) {
    await createSession(sessionName, worktreeId);
  }
}
```

---

#### 2. マジックナンバーの定数化

**Before**:
```typescript
async function getMessages(worktreeId: string, limit?: number) {
  const messages = await db.getMessages(worktreeId, limit || 50);
  return messages;
}
```

**After**:
```typescript
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;

async function getMessages(worktreeId: string, limit?: number) {
  const safeLimit = Math.min(
    limit || DEFAULT_MESSAGE_LIMIT,
    MAX_MESSAGE_LIMIT
  );

  return db.getMessages(worktreeId, safeLimit);
}
```

---

#### 3. 条件式の明確化

**Before**:
```typescript
if (process.env.MCBD_BIND === '0.0.0.0' && !process.env.MCBD_AUTH_TOKEN) {
  throw new Error('Auth token required');
}
```

**After**:
```typescript
const isPublicBinding = process.env.MCBD_BIND === '0.0.0.0';
const hasAuthToken = Boolean(process.env.MCBD_AUTH_TOKEN);

if (isPublicBinding && !hasAuthToken) {
  throw new AppError(
    500,
    'MCBD_AUTH_TOKEN is required when MCBD_BIND=0.0.0.0',
    'AUTH_TOKEN_REQUIRED'
  );
}
```

---

#### 4. 早期リターン

**Before**:
```typescript
function generateWorktreeId(branchName: string): string {
  if (branchName) {
    if (branchName.length > 0) {
      return branchName.replace(/\//g, '-').toLowerCase();
    } else {
      return '';
    }
  } else {
    return '';
  }
}
```

**After**:
```typescript
function generateWorktreeId(branchName: string): string {
  if (!branchName || branchName.length === 0) {
    return '';
  }

  return branchName.replace(/\//g, '-').toLowerCase();
}
```

---

### リファクタリングチェックリスト

実施前:
- [ ] すべてのテストが通っているか
- [ ] 変更対象のコードがバージョン管理されているか
- [ ] リファクタリングの目的が明確か

実施後:
- [ ] すべてのテストが通っているか
- [ ] 新しいテストを追加したか（必要に応じて）
- [ ] コードレビューを受けたか
- [ ] ドキュメントを更新したか（必要に応じて）

---

## レビューコメント例

### 建設的なコメント

✅ **良い例**:
```
この関数は複数の責任を持っているように見えます。
セッション作成とメッセージ送信を分離することで、
テストしやすくなり、再利用性も高まると思います。

提案:
- ensureSessionExists() を抽出
- sendKeys() を抽出
```

❌ **悪い例**:
```
この関数は長すぎます。リファクタリングしてください。
```

---

✅ **良い例**:
```
ここでSQL injectionのリスクがあります。
プリペアドステートメントを使用することをお勧めします。

例:
```typescript
db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
```
```

❌ **悪い例**:
```
セキュリティリスクがあります。修正してください。
```

---

## Phase完了時のセルフチェック

各Phase完了後、以下を確認:

- [ ] すべてのテストが通っているか
- [ ] コードカバレッジが目標を満たしているか
- [ ] Lint/Formatエラーがないか
- [ ] このチェックリストの項目をクリアしているか
- [ ] ドキュメントが更新されているか
- [ ] リファクタリングが完了しているか
- [ ] コミットメッセージが適切か

---

## まとめ

### レビューの3原則

1. **品質重視**: 動くだけでなく、保守しやすいコードを目指す
2. **建設的**: 問題だけでなく、解決策も提示する
3. **継続的改善**: 完璧は目指さず、段階的に改善する

### 次のステップ

- Phase 1開始前にこのチェックリストを確認
- 各Phase完了時にセルフレビュー実施
- 定期的にチェックリストを見直し・更新

---

**作成者**: Claude (SWE Agent)
**最終更新**: 2025-11-17
