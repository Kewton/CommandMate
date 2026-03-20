# Issue #168 Stage 4: セキュリティレビュー

| 項目 | 値 |
|------|-----|
| Issue | #168 セッション履歴保持（kill-session後の履歴閲覧） |
| ステージ | 4 - セキュリティレビュー |
| レビュー日 | 2026-03-20 |
| 設計書 | dev-reports/design/issue-168-session-history-retention-design-policy.md |
| must_fix | 1件 |
| should_fix | 4件 |
| nice_to_have | 4件 |

---

## 総合評価

Issue #168 のセキュリティ設計は全体として適切である。物理削除から論理削除への変更に伴うセキュリティ上の重大な脆弱性は検出されなかった。既存の認証ミドルウェア（middleware.ts）がアーカイブメッセージへのアクセスも保護し、SQLクエリはパラメータバインディングを使用している。OWASP Top 10 の各項目に対して重大な脆弱性は検出されなかった。

---

## OWASP Top 10 カバレッジ

| OWASP カテゴリ | 評価 |
|---------------|------|
| A01: Broken Access Control | 検証済み - 既存認証ミドルウェアで保護、worktree ID 絞り込み担保 |
| A02: Cryptographic Failures | 該当なし - 暗号処理の追加・変更なし |
| A03: Injection | 検証済み - パラメータバインディング使用、ACTIVE_FILTER は固定文字列 |
| A04: Insecure Design | 検証済み - エラーメッセージに機密情報を含まない |
| A05: Security Misconfiguration | 検証済み - ON DELETE CASCADE によるデータライフサイクル管理 |
| A06: Vulnerable Components | 該当なし - 新規依存なし |
| A07: XSS | 検証済み - localStorage値の厳密比較、DOM操作なし |
| A08: Data Integrity | 検証済み - Mass Assignment防止（Omit型） |
| A09: Logging & Monitoring | 既存ロガー使用 - 変更なし |
| A10: SSRF | 該当なし - 外部リクエスト生成なし |

---

## 指摘事項一覧

### must_fix (1件)

#### SEC4-007: ACTIVE_FILTER 定数のテストカバレッジ確保

- **OWASP**: A03:2021 - Injection
- **場所**: 設計書セクション 4 (DB関数設計), src/lib/db/chat-db.ts
- **説明**: `ACTIVE_FILTER = 'AND archived = 0'` をSQL文字列に直接連結する方式を採用している。この定数はモジュールレベルで固定定義されており、ユーザー入力が混入する経路はない。しかし、使用箇所が11箇所以上に及ぶため、定数値の誤変更が広範囲に影響する。better-sqlite3 のパラメータバインディングと組み合わせる方式であるため、直接的なSQL Injectionリスクは現時点では存在しない。
- **推奨対応**: `ACTIVE_FILTER` 定数が正しい値であることを検証する単体テストを追加する。例: `expect(ACTIVE_FILTER).toBe('AND archived = 0')`。将来的にフィルタ条件が複雑化する場合は、クエリビルダーパターンへの移行を検討する。

---

### should_fix (4件)

#### SEC4-001: includeArchived パラメータの非正規値テスト

- **OWASP**: A03:2021 - Injection
- **場所**: src/app/api/worktrees/[id]/messages/route.ts (設計書セクション 3.2)
- **説明**: `includeArchivedParam === 'true'` の厳密比較によりSQL Injectionリスクはない。ただし、`'TRUE'`, `'1'`, `'yes'` 等の非正規値が `false` として処理されることをテストで明示すべき。
- **推奨対応**: テストケースに非正規値のバリエーションテストを追加する。

#### SEC4-003: 論理削除によるデータ保持のプライバシー影響

- **OWASP**: 該当なし（プライバシー設計）
- **場所**: 設計書セクション 7 (セキュリティ設計), セクション 8 (パージ戦略)
- **説明**: 現行のkill-sessionはメッセージを物理削除するため、ユーザーはセッション終了時にデータが消えることを期待している可能性がある。論理削除への変更により、ユーザーが削除したと思っているデータがDB内に残存する。特に機密情報（APIキー、パスワード等）を含むメッセージが保持される可能性がある。
- **推奨対応**: UIトグルの近くにアーカイブメッセージが保持されている旨の説明テキストを追加する。将来的にはパージ機能（IA3-005）と連動させてユーザーが明示的にアーカイブを物理削除できる機能を検討する。

#### SEC4-006: localStorage の showArchived に対するXSS影響評価

- **OWASP**: A07:2021 - Cross-Site Scripting
- **場所**: 設計書セクション 5.2 (localStorage永続化)
- **説明**: `localStorage.getItem(STORAGE_KEY) === 'true'` の厳密比較で実質的に安全。XSS攻撃でlocalStorageが改ざんされてもBoolean値として安全にパースされる。JSON.parseによる任意コード実行のリスクもない。try-catchによるlocalStorageアクセス保護も設計済み。
- **推奨対応**: storageイベントリスナーで他タブからの変更を検知する場合は同様の厳密比較を適用すること。

#### SEC4-009: 404エラーレスポンスのworktree ID露出

- **OWASP**: A01:2021 - Broken Access Control
- **場所**: src/app/api/worktrees/[id]/messages/route.ts L24-27
- **説明**: `Worktree '${params.id}' not found` というエラーメッセージにworktree IDが含まれている。既存の問題であり Issue #168 固有ではない。認証済みリクエストのみがこのエンドポイントに到達できるため、影響は限定的。
- **推奨対応**: Issue #168 の範囲外。将来的にエラーメッセージの一般化を検討。

---

### nice_to_have (4件)

#### SEC4-002: アクセス制御の確認

- **評価**: 既存の認証ミドルウェアで適切に保護されている。includeArchivedパラメータの追加は新たな認証バイパスを生まない。worktree IDによる絞り込みはgetWorktreeByIdチェックで担保されている。対応不要。

#### SEC4-004: Mass Assignment 防止

- **評価**: createMessageの引数型が `Omit<ChatMessage, 'id' | 'archived'>` に変更されるため、API経由でarchivedフィールドを直接操作不可。archivedを変更するAPIはkill-session APIのみで認証必須。対応不要。

#### SEC4-005: エラーメッセージの情報漏洩チェック

- **評価**: エラーレスポンスは一般的なメッセージのみ。includeArchivedパラメータの有無によってエラーメッセージが変わることはない。対応不要。

#### SEC4-008: ON DELETE CASCADE によるデータ保護

- **評価**: worktree削除時にアーカイブ済みメッセージも含めて全メッセージが物理削除される。適切な設計。対応不要。

---

## セキュリティチェックリスト

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| SQL Injection: includeArchived パラメータ | PASS | 厳密比較、ユーザー入力をSQLに埋め込まない |
| Broken Access Control: 他worktreeのアーカイブアクセス | PASS | getWorktreeById でworktree存在確認、認証ミドルウェア |
| Data Exposure: 削除されたはずのデータ | WARN | 論理削除によりデータ残存。ユーザー通知推奨 |
| Mass Assignment: archived フィールド操作 | PASS | Omit型で外部操作防止 |
| Information Disclosure: エラーメッセージ | PASS | 一般的なエラーメッセージのみ |
| Data Retention: プライバシー | WARN | パージ機能なし（YAGNI）。将来的に検討 |
| Input Validation: パラメータ型チェック | PASS | === 'true' 厳密比較 |
| localStorage XSS | PASS | Boolean 厳密比較、try-catch保護 |

---

## 結論

本設計に対してOWASP Top 10に基づくセキュリティレビューを実施した結果、重大な脆弱性は検出されなかった。must_fixの1件（ACTIVE_FILTER定数のテストカバレッジ）は予防的措置であり、現時点で悪用可能な脆弱性ではない。should_fixの4件のうち、SEC4-003（プライバシー影響）は中長期的なユーザー信頼に関わるため、パージ機能の将来計画と合わせて対応を検討すべきである。全体として、設計書のセキュリティセクション（セクション7）に記載された対策は妥当であり、実装時にこのレビューの指摘事項を反映することで、安全な実装が可能である。
