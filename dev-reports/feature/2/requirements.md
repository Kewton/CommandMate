# Issue #2: 機能強化 - 要件定義書

## 概要

MyCodeBranchDeskに以下の3つの機能を追加することで、複数リポジトリ・複数ブランチでの並行作業をより効率的に管理できるようにする。

## ユーザーストーリー

### US-1: 複数リポジトリ対応
**ユーザーとして**複数リポジトリに対応して欲しい。**なぜなら**複数のリポジトリに対して同時に作業したいからだ。

**受け入れ基準:**
- 複数のリポジトリのworktreeを同時に管理できる
- リポジトリごとにworktreeをグループ化して表示できる
- リポジトリ間の切り替えがスムーズにできる

### US-2: ブランチメモ機能
**ユーザーとして**各ブランチにメモを記入したい。**なぜなら**、並列作業している場合、どこで何をやっていたのかわからなくなりがちだからだ。

**受け入れ基準:**
- 各worktreeにメモを追加・編集・削除できる
- メモは一覧画面とdetail画面の両方で確認できる
- メモは即座に保存される

### US-3: 直近メッセージ表示
**ユーザーとして**トップページにて各カードに直近のユーザーからのメッセージを表示してほしい。**なぜなら**、そのブランチで直近何を依頼したかすぐに確認したいからだ。

**受け入れ基準:**
- worktreeカードに最新のユーザーメッセージを表示
- メッセージが長い場合は適切に省略
- メッセージがない場合は適切なフォールバック表示

## 要件分析

### 1. 複数リポジトリ対応 (US-1)

#### 現状の問題
- 現在は単一リポジトリのworktreeのみを管理
- 複数のプロジェクトを同時に作業する場合、別のインスタンスを起動する必要がある

#### 解決策
##### オプション1: 環境変数で複数リポジトリパスを指定
```bash
WORKTREE_REPOS="/path/to/repo1,/path/to/repo2,/path/to/repo3"
```

**メリット:**
- 実装が比較的シンプル
- 既存のコードへの影響が少ない

**デメリット:**
- リポジトリの追加・削除に環境変数の変更が必要
- UIでの動的な管理ができない

##### オプション2: データベースでリポジトリを管理
- リポジトリ情報をDBに保存
- UIから追加・削除・有効/無効を切り替え可能

**メリット:**
- 柔軟な管理が可能
- UIでの操作が直感的

**デメリット:**
- 実装が複雑
- データモデルの大幅な変更が必要

#### 推奨: オプション1（Phase 1）→ オプション2（Phase 2）
- Phase 1: 環境変数での複数リポジトリ対応
- Phase 2: UI での動的管理機能追加

### 2. ブランチメモ機能 (US-2)

#### データモデル変更
```typescript
export interface Worktree {
  id: string;
  name: string;
  path: string;
  repositoryPath: string;  // 新規: リポジトリのルートパス
  memo?: string;           // 新規: ユーザーメモ
  lastMessageSummary?: string;
  updatedAt?: Date;
}
```

#### DBスキーマ変更
```sql
ALTER TABLE worktrees ADD COLUMN repository_path TEXT;
ALTER TABLE worktrees ADD COLUMN memo TEXT;
```

#### UI設計
- **一覧画面**: メモのプレビュー（1行、省略表示）
- **詳細画面**: メモの全文表示 + 編集ボタン
- **編集UI**: テキストエリア + 保存・キャンセルボタン

### 3. 直近メッセージ表示 (US-3)

#### 現状
- `last_message_summary` は存在するが、役割が不明確
- 最新のユーザーメッセージを特定するロジックが必要

#### 実装方針
1. **DB クエリの最適化**
   - 最新のuser roleメッセージを効率的に取得
   - 既存の `last_message_summary` を活用または拡張

2. **表示仕様**
   - 最大100文字程度で省略
   - メッセージがない場合: "メッセージなし" または空欄
   - タイムスタンプも表示（相対時間: "2時間前"など）

## データモデル設計

### Worktree拡張
```typescript
export interface Worktree {
  id: string;
  name: string;
  path: string;
  repositoryPath: string;      // 新規
  repositoryName: string;       // 新規: リポジトリ表示名
  memo?: string;                // 新規
  lastUserMessage?: string;     // 新規: 最新のユーザーメッセージ
  lastUserMessageAt?: Date;     // 新規: 最新メッセージの日時
  lastMessageSummary?: string;  // 既存: Claudeメッセージのサマリー（非推奨）
  updatedAt?: Date;
}
```

### Repository（新規）
```typescript
export interface Repository {
  id: string;              // リポジトリパスのハッシュ
  name: string;            // 表示名（例: "MyCodeBranchDesk"）
  path: string;            // 絶対パス
  enabled: boolean;        // Phase 2で使用
  createdAt: Date;
  updatedAt: Date;
}
```

## データベーススキーマ変更

### Phase 1: 必須フィールド追加

```sql
-- worktrees テーブル拡張
ALTER TABLE worktrees ADD COLUMN repository_path TEXT;
ALTER TABLE worktrees ADD COLUMN repository_name TEXT;
ALTER TABLE worktrees ADD COLUMN memo TEXT;
ALTER TABLE worktrees ADD COLUMN last_user_message TEXT;
ALTER TABLE worktrees ADD COLUMN last_user_message_at INTEGER;

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_worktrees_repository
ON worktrees(repository_path);
```

### Phase 2: リポジトリテーブル追加（将来）

```sql
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- worktrees テーブルに外部キー追加
ALTER TABLE worktrees ADD COLUMN repository_id TEXT
  REFERENCES repositories(id) ON DELETE CASCADE;
```

## UI/UX設計

### 1. トップページ（Worktree一覧）

#### レイアウト
```
+--------------------------------------------------+
| MyCodeBranchDesk                    [+ Add Repo] |
+--------------------------------------------------+
| Repository: MySwiftAgent                    (12) |
+--------------------------------------------------+
| [Branch Card]  [Branch Card]  [Branch Card]      |
|                                                   |
| Repository: AnotherProject                   (5) |
+--------------------------------------------------+
| [Branch Card]  [Branch Card]                     |
+--------------------------------------------------+
```

#### Branchカード（拡張版）
```
+----------------------------------------+
| feature/issue-123          [Live] [•••]|
| /path/to/worktree                      |
|----------------------------------------|
| 📝 "Login APIの実装中"                   |
|----------------------------------------|
| 👤 "ログイン機能を追加して"                |
| 🕐 2時間前                               |
|----------------------------------------|
| 💬 20 messages                          |
+----------------------------------------+
```

### 2. Worktree詳細画面

#### メモセクション（新規）
```
+--------------------------------------------------+
| Information                                       |
+--------------------------------------------------+
| Branch: feature/issue-123                         |
| Path: /path/to/worktree                          |
| Repository: MySwiftAgent                          |
| Messages: 20                                      |
+--------------------------------------------------+
| Memo                                    [Edit]   |
+--------------------------------------------------+
| Login APIの実装中                                  |
| - JWTトークン認証を使用                             |
| - リフレッシュトークンも実装予定                      |
+--------------------------------------------------+
```

## API設計

### 新規/変更エンドポイント

#### 1. GET /api/repositories
```typescript
// レスポンス
{
  repositories: Repository[]
}
```

#### 2. PATCH /api/worktrees/:id
```typescript
// リクエスト
{
  memo?: string;
}

// レスポンス
{
  worktree: Worktree;
}
```

#### 3. GET /api/worktrees (拡張)
```typescript
// クエリパラメータ
{
  repository?: string;  // リポジトリパスでフィルタ
}

// レスポンス
{
  worktrees: Worktree[];
  repositories: Repository[];  // 新規
}
```

## 実装計画

### Phase 1: 基本機能実装（Issue #2対応）

#### Task 1: データモデル・DB拡張
- [ ] `Worktree` インターフェースに新規フィールド追加
- [ ] DBマイグレーションスクリプト作成
- [ ] DB CRUD 関数の更新

#### Task 2: 複数リポジトリ対応（環境変数版）
- [ ] 環境変数から複数リポジトリパスを読み込み
- [ ] worktreeスキャン時にリポジトリ情報を付与
- [ ] 一覧画面でリポジトリごとにグループ化

#### Task 3: メモ機能
- [ ] メモ編集UI実装（詳細画面）
- [ ] メモ表示UI実装（一覧・詳細）
- [ ] PATCH /api/worktrees/:id 実装

#### Task 4: 最新ユーザーメッセージ表示
- [ ] 最新ユーザーメッセージ取得ロジック実装
- [ ] 一覧カードに表示
- [ ] 相対時間表示（"2時間前"など）

#### Task 5: テスト
- [ ] ユニットテスト追加
- [ ] 統合テスト追加
- [ ] 手動テスト

### Phase 2: UI改善（将来）
- [ ] リポジトリ管理画面
- [ ] リポジトリの追加・削除UI
- [ ] リポジトリの有効/無効切り替え
- [ ] メモの検索機能

## テスト計画

### ユニットテスト

#### DB操作
- [ ] 複数リポジトリのworktree取得
- [ ] メモの保存・更新・削除
- [ ] 最新ユーザーメッセージ取得

#### API
- [ ] PATCH /api/worktrees/:id
- [ ] GET /api/worktrees （フィルタ）

### 統合テスト

- [ ] 複数リポジトリの同時管理
- [ ] メモ編集のE2Eフロー
- [ ] 最新メッセージ表示の確認

### 手動テスト

#### テストシナリオ1: 複数リポジトリ
1. 環境変数に3つのリポジトリパスを設定
2. アプリを起動
3. 全リポジトリのworktreeが表示されることを確認
4. リポジトリごとにグループ化されていることを確認

#### テストシナリオ2: メモ機能
1. worktree詳細画面を開く
2. メモを入力して保存
3. 一覧画面に戻る
4. メモのプレビューが表示されることを確認
5. 再度詳細画面を開く
6. メモが保存されていることを確認

#### テストシナリオ3: 最新メッセージ
1. worktreeにメッセージを送信
2. 一覧画面に戻る
3. カードに最新のユーザーメッセージが表示されることを確認
4. 相対時間が正しく表示されることを確認

## マイグレーション戦略

### 既存データの移行

```typescript
// マイグレーションスクリプト例
export function migrateToV2(db: Database.Database): void {
  // 1. スキーマ変更
  db.exec(`
    ALTER TABLE worktrees ADD COLUMN repository_path TEXT;
    ALTER TABLE worktrees ADD COLUMN repository_name TEXT;
    ALTER TABLE worktrees ADD COLUMN memo TEXT;
    ALTER TABLE worktrees ADD COLUMN last_user_message TEXT;
    ALTER TABLE worktrees ADD COLUMN last_user_message_at INTEGER;
  `);

  // 2. 既存データに repository_path を設定
  // worktree.path から推測してリポジトリパスを設定
  const worktrees = db.prepare('SELECT id, path FROM worktrees').all();
  for (const wt of worktrees) {
    const repoPath = findRepositoryRoot(wt.path);
    const repoName = path.basename(repoPath);
    db.prepare(`
      UPDATE worktrees
      SET repository_path = ?, repository_name = ?
      WHERE id = ?
    `).run(repoPath, repoName, wt.id);
  }

  // 3. 最新ユーザーメッセージを設定
  // 各worktreeの最新userメッセージを取得して設定
  const updateStmt = db.prepare(`
    UPDATE worktrees
    SET last_user_message = ?,
        last_user_message_at = ?
    WHERE id = ?
  `);

  for (const wt of worktrees) {
    const latestUserMsg = db.prepare(`
      SELECT content, timestamp
      FROM chat_messages
      WHERE worktree_id = ? AND role = 'user'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(wt.id);

    if (latestUserMsg) {
      updateStmt.run(
        latestUserMsg.content.substring(0, 200),
        latestUserMsg.timestamp,
        wt.id
      );
    }
  }
}
```

## リスクと制約

### リスク
1. **複数リポジトリのパフォーマンス**: worktreeが大量にある場合、スキャンに時間がかかる可能性
   - 軽減策: 非同期スキャン、キャッシング
2. **既存データの移行**: マイグレーションスクリプトの不具合
   - 軽減策: バックアップの実施、テスト環境での事前検証

### 制約
1. 環境変数での複数リポジトリ指定（Phase 1）は静的
2. リポジトリの追加・削除にはアプリの再起動が必要

## 成功基準

### Phase 1完了時
- [x] 3つのユーザーストーリーがすべて実装され、受け入れ基準を満たしている
- [x] すべてのテストがパスしている
- [x] 既存機能に影響がない（リグレッションテスト）
- [x] ドキュメントが更新されている

### ユーザー満足度
- 複数リポジトリでの並行作業がスムーズになった
- ブランチごとの作業内容を忘れなくなった
- 一覧画面から各ブランチの状況が把握できるようになった

## 参考資料

- Issue #2: https://github.com/Kewton/MyCodeBranchDesk/issues/2
- 既存のデータモデル: `src/types/models.ts`
- 既存のDB操作: `src/lib/db.ts`
