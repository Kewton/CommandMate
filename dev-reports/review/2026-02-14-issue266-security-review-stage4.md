# Architecture Review: Issue #266 - セキュリティレビュー (Stage 4)

| 項目 | 内容 |
|------|------|
| **Issue** | #266 ブラウザタブ切り替え時の入力クリア修正 |
| **レビュー対象** | 設計方針書 `issue-266-visibility-change-input-clear-design-policy.md` |
| **フォーカス** | セキュリティ (OWASP Top 10準拠確認) |
| **ステージ** | Stage 4 - セキュリティレビュー |
| **日付** | 2026-02-14 |
| **ステータス** | **Approved** |
| **スコア** | **5 / 5** |

---

## 1. エグゼクティブサマリー

Issue #266の設計方針書を、OWASP Top 10の各カテゴリに基づいてセキュリティ観点からレビューした。本変更は`WorktreeDetailRefactored.tsx`の`handleVisibilityChange`関数内部のリカバリロジックを、フルリカバリ(`handleRetry`)から軽量リカバリ(loading状態を変更しないバックグラウンドfetch)に変更するものである。

結論として、セキュリティ上の必須改善項目および推奨改善項目は検出されなかった。以下の理由により、本変更のセキュリティリスクは極めて低い。

1. **新規のユーザー入力処理が存在しない**: 変更は既存fetch関数の呼び出し条件を変更するのみ
2. **新規APIエンドポイントの追加がない**: 呼び出し先は既存の3つのGETエンドポイント
3. **データ書き込み操作がない**: 全てべき等なGETリクエスト
4. **外部通信先の追加がない**: 全てのfetchは自サーバーへの相対パスリクエスト
5. **認証/認可フローへの影響がない**: アクセス制御ロジックに変更なし

---

## 2. OWASP Top 10 チェックリスト

### A01: Broken Access Control -- PASS

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| 新規エンドポイントの認可制御 | N/A | 新規エンドポイントの追加なし |
| 既存エンドポイントの認可制御変更 | 変更なし | 既存の`GET /api/worktrees/:id`、`GET /api/worktrees/:id/messages`、`GET /api/worktrees/:id/current-output`への呼び出しパターン変更のみ |
| worktreeIdの検証 | 既存通り | APIルート側で`getWorktreeById(db, params.id)`によるDB照合を実施。存在しない場合は404を返却 |
| 水平権限昇格 | N/A | ローカル開発ツールであり、マルチユーザー認証は設計外 |

**分析**: 変更は`handleVisibilityChange`内部の既存fetch関数呼び出し条件を変更するのみ。`fetchWorktree()`、`fetchMessages()`、`fetchCurrentOutput()`の各関数が呼び出すAPIエンドポイントとパラメータに変更はない。アクセス制御に影響を与えない。

### A02: Cryptographic Failures -- N/A

本変更に暗号化関連の処理は含まれない。

### A03: Injection -- PASS

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| SQLインジェクション | 対策済み | APIルート側の`db.ts`ではbetter-sqlite3のプリペアドステートメント(`?`プレースホルダ)を使用。例: `WHERE w.id = ?`(L300)、`WHERE worktree_id = ?`(L561) |
| テンプレートリテラルインジェクション | 低リスク | `fetch(\`/api/worktrees/${worktreeId}\`)`でworktreeIdを埋め込んでいるが、worktreeIdはReact propsから受け取った値であり、Next.js App Routerのdynamic segment(`[id]`)経由でAPIルートに到達する。URLパスの一部としてのみ使用され、クエリ文字列やリクエストボディには埋め込まれない |
| OSコマンドインジェクション | N/A | 本変更にはプロセス実行処理なし |
| XSS | N/A | 本変更にはDOM操作やdangerouslySetInnerHTMLの使用なし |

**分析**: 本変更では新規のユーザー入力を受け付ける処理が追加されない。既存のfetch URL構築パターン(`/api/worktrees/${worktreeId}`)は変更前と同一であり、新たなインジェクションベクタは存在しない。

### A04: Insecure Design -- PASS

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| 脅威モデリング | 適切 | 軽量リカバリの失敗時はサイレント無視し、ポーリングによる自然回復を待つ防御的設計 |
| エラー処理の安全性 | 適切 | SF-IMP-001対策として`catch`内で`setError(null)`を呼び出し、fetchWorktree内部のsetErrorによるコンポーネントツリー崩壊を防御 |
| セキュリティ設計文書 | 記載あり | 設計方針書Section 7にセキュリティ影響なしの根拠を明記 |

**分析**: 軽量リカバリパターンは、エラー状態の判定に基づくガード条件で分岐するシンプルな設計であり、攻撃者が悪用可能な設計上の弱点は存在しない。`error`状態はReactのuseStateで管理されており、クライアントサイドのみで完結する。

### A05: Security Misconfiguration -- PASS

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| Content-Security-Policy | 設定済み | `next.config.js`にCSPヘッダーが定義。`default-src 'self'`、`frame-ancestors 'none'`等 |
| X-Frame-Options | 設定済み | `DENY`で設定済み |
| X-Content-Type-Options | 設定済み | `nosniff`で設定済み |
| X-XSS-Protection | 設定済み | `1; mode=block`で設定済み |
| Referrer-Policy | 設定済み | `strict-origin-when-cross-origin`で設定済み |
| Permissions-Policy | 設定済み | `camera=(), microphone=(), geolocation=()`で設定済み |
| 設定への影響 | なし | 本変更はセキュリティヘッダー設定に影響しない |

**分析**: プロジェクト全体のセキュリティヘッダーは`next.config.js`で適切に設定されており、本変更による影響はない。

### A06: Vulnerable and Outdated Components -- N/A

本変更では新規の依存パッケージを追加しない。既存のReact/Next.js APIのみを使用する。

### A07: Identification and Authentication Failures -- N/A

CommandMateはローカル開発ツールであり、認証機構を持たない設計となっている。本変更は認証/認可フローに影響しない。

### A08: Software and Data Integrity Failures -- PASS

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| APIレスポンスの検証 | 既存通り | `response.ok`チェック後にJSONパース。型キャストで期待する構造を定義 |
| CI/CDパイプラインの改変 | N/A | CI/CD設定への変更なし |
| 依存関係の整合性 | N/A | 新規依存なし |

**分析**: 軽量リカバリでは`Promise.all([fetchWorktree(), fetchMessages(), fetchCurrentOutput()])`を実行するが、各fetch関数のレスポンス処理ロジックは変更されない。APIレスポンスのパースと状態更新の流れは既存実装を維持する。

### A09: Security Logging and Monitoring Failures -- PASS

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| エラーログ出力 | 一部サイレント | 軽量リカバリの失敗時はサイレント無視するが、これは意図的な設計判断。ポーリングによる自然回復を前提 |
| 既存ログ出力への影響 | なし | `fetchMessages`および`fetchCurrentOutput`内の`console.error`は維持される |
| セキュリティイベントログ | N/A | セキュリティイベントに該当する処理変更なし |

**分析**: 軽量リカバリの失敗を明示的にログ出力しない設計については、セキュリティ上の懸念はない。理由として、(1)全てGETリクエストであり攻撃の兆候を示すものではない、(2)ネットワーク一時障害が主な失敗原因であり、ポーリングで自然回復する、(3)既存のfetch関数内部のconsole.errorは維持されるため、個別のfetch失敗は引き続きブラウザコンソールに記録される。

### A10: Server-Side Request Forgery (SSRF) -- N/A

本変更では新規の外部リクエスト先を追加しない。全てのfetchは自サーバーの`/api/`エンドポイントへの相対パスリクエストである。fetch URLはハードコードされたパスパターンにworktreeId(props由来)を埋め込む形式であり、ユーザー入力によるURL操作の余地はない。

---

## 3. 追加セキュリティ確認項目

### 3-1. クライアントサイド固有のセキュリティ

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| DOM操作の安全性 | PASS | `dangerouslySetInnerHTML`や直接のDOM操作は本変更に含まれない |
| イベントリスナーのリーク | PASS | `useEffect`のクリーンアップ関数で`removeEventListener`を実行。リスナーリークなし |
| 状態管理の安全性 | PASS | `error`状態の遷移は`setError(null)`と`setError(message)`の2パターンのみ。予測可能な状態遷移 |
| 非同期処理のレースコンディション | 許容範囲 | C-IMP-003で記載の通り、軽量リカバリとポーリングの並行fetchが発生しうるが、べき等GETリクエストのため安全 |

### 3-2. エラー情報露出の確認

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| スタックトレースの露出 | なし | APIルート側の`catch`ブロックでは`console.error`でサーバーログに出力し、クライアントには汎用エラーメッセージ(`Failed to fetch worktree`等)を返却 |
| HTTPステータスコードの露出 | 既存通り | `fetchWorktree`のエラーメッセージに`response.status`が含まれるが、軽量リカバリの`catch`内で`setError(null)`が呼ばれるためUIに表示されない |
| 内部パス情報の露出 | なし | APIレスポンスにサーバー内部パスは含まれない(worktree.pathはgit worktreeのパスであり、ユーザーが認識している情報) |

### 3-3. スロットリングとDoS防御

| 確認項目 | 結果 | 詳細 |
|---------|------|------|
| リクエストレート制限 | 適切 | `RECOVERY_THROTTLE_MS`(5000ms)によるスロットリングを維持。5秒以内の連続visibilitychangeイベントは無視される |
| ポーリングとの重複によるリクエスト増加 | 軽微 | 最悪ケースでも1回のvisibilitychangeで3つの追加GETリクエストが発生するのみ。ローカルサーバーへのリクエストであり影響は無視できる |

---

## 4. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティリスク | (検出なし) | Low | Low | -- |
| エラー情報露出 | 軽量リカバリ失敗時のエラーメッセージ抑制はセキュリティ上好ましい副次効果 | Low | Low | -- |
| レースコンディション | ポーリングと軽量リカバリの並行実行は既存設計から存在する許容済みリスク | Low | Medium | -- |

---

## 5. 改善推奨事項

### 5-1. 必須改善項目 (Must Fix)

なし。

### 5-2. 推奨改善項目 (Should Fix)

なし。

### 5-3. 検討事項 (Consider)

#### C-SEC-001: エラー情報露出の抑制効果

- **内容**: SF-IMP-001の対策として`catch`内で`setError(null)`を呼ぶ設計は、セキュリティ観点では好ましい副次効果がある。`fetchWorktree`失敗時のHTTPステータスコードを含むエラーメッセージがUI上に一時的にも表示されない。これは防御的設計の一例として評価できる。
- **推奨**: 現状の設計で問題なし。C-KISS-001で将来検討されている`NODE_ENV=development`時のみ`console.warn`追加と整合する方向性であり、開発時デバッグ容易性とのバランスも考慮されている。

#### C-SEC-002: レースコンディションの認識

- **内容**: C-IMP-003で記載されている通り、軽量リカバリの`fetch`とポーリングの`fetch`が同時実行される可能性がある。全てべき等なGETリクエストのためデータ整合性リスクはないが、React state更新のタイミングによって一時的に古いデータが表示される可能性がゼロではない。
- **推奨**: 対応不要。既存のポーリング設計(Issue #246のIA-002)でも同様のレースコンディションが存在しており、新規リスクではない。

---

## 6. 設計書Section 7(セキュリティ設計)の妥当性検証

設計方針書のSection 7では以下の3点を根拠にセキュリティ影響なしと結論している。

| 設計書の主張 | 検証結果 | 評価 |
|------------|---------|------|
| fetch呼び出しは既存のものと同一 | `fetchWorktree()`、`fetchMessages()`、`fetchCurrentOutput()`の呼び出しは変更前と同じ関数。呼び出し条件(errorガード)のみ変更 | 正確 |
| 新たな外部入力の処理なし | 軽量リカバリパスでは新たなユーザー入力やパラメータの処理は追加されない | 正確 |
| 認証/認可フローへの影響なし | ローカル開発ツールであり認証機構は設計外。APIエンドポイントのアクセス制御パターンに変更なし | 正確 |

**結論**: 設計書のセキュリティ評価は正確であり、追加のセキュリティ対策は不要である。

---

## 7. レビューサマリー

### 総合評価

| 項目 | 評価 |
|------|------|
| OWASP Top 10準拠 | 全項目PASS (該当するものについて) |
| Must Fix | 0件 |
| Should Fix | 0件 |
| Consider | 2件 (情報提供レベル) |
| セキュリティリスク | Low |
| ステータス | **Approved** |
| スコア | **5 / 5** |

### 承認理由

1. 本変更はクライアントサイドのReact状態管理ロジックの条件分岐変更に限定されており、新規の攻撃面(attack surface)を追加しない
2. 既存のセキュリティ対策(CSP、セキュリティヘッダー、プリペアドステートメント、エラーメッセージの汎用化)は全て維持される
3. 新規のユーザー入力処理、外部通信先、APIエンドポイントの追加がないため、OWASP Top 10のいずれのカテゴリにおいても新規リスクが発生しない
4. エラー情報の抑制(SF-IMP-001のsetError(null))は、セキュリティ観点で好ましい副次効果を持つ

---

## 8. レビュー対象ファイル一覧

| ファイル | レビュー内容 |
|---------|------------|
| `dev-reports/design/issue-266-visibility-change-input-clear-design-policy.md` | 設計方針書の全セクション |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | handleVisibilityChange、handleRetry、fetchWorktree/fetchMessages/fetchCurrentOutput |
| `src/app/api/worktrees/[id]/route.ts` | GET/PATCHルート、SQLクエリ、エラーレスポンス |
| `src/app/api/worktrees/[id]/messages/route.ts` | GETルート、入力バリデーション、SQLクエリ |
| `src/app/api/worktrees/[id]/current-output/route.ts` | GETルート、セッション出力取得 |
| `src/lib/api-client.ts` | fetchApi基盤、URL構築パターン |
| `src/lib/db.ts` | getWorktreeById、getMessages - プリペアドステートメント確認 |
| `next.config.js` | セキュリティヘッダー設定 |
