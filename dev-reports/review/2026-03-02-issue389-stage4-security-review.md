# Issue #389: MarkdownEditor Auto-Save - Stage 4 Security Review

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #389 |
| Stage | 4 - Security Review (OWASP Top 10) |
| Review Date | 2026-03-02 |
| Status | **Approved** |
| Score | 5/5 |
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 9 |

auto-save機能の設計は、セキュリティ観点で高品質である。既存のセキュリティインフラストラクチャ（認証ミドルウェア、パスバリデーション、コンテンツバリデーション、XSSサニタイズ）を完全に維持したまま機能が追加される設計となっており、新たなセキュリティリスクを導入しない。OWASP Top 10の全カテゴリについて確認を完了し、セキュリティ設計は合格と判定する。

---

## Review Scope

### Design Document
- `dev-reports/design/issue-389-auto-save-design-policy.md`

### Reviewed Files
- `src/components/worktree/MarkdownEditor.tsx` - 変更対象コンポーネント
- `src/hooks/useAutoSave.ts` - auto-saveフック（既存、変更なし）
- `src/hooks/useLocalStorageState.ts` - localStorage操作フック（既存、変更なし）
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` - ファイルAPI（既存、変更なし）
- `src/config/editable-extensions.ts` - コンテンツバリデーション（既存、変更なし）
- `src/lib/file-operations.ts` - ファイル操作ビジネスロジック（既存、変更なし）
- `src/middleware.ts` - 認証ミドルウェア（既存、変更なし）
- `src/config/auth-config.ts` - 認証設定（既存、変更なし）
- `src/types/markdown-editor.ts` - 型定義・定数（2定数追加のみ）

---

## OWASP Top 10 Security Checklist

### A01: Broken Access Control - PASS

auto-saveはsaveToApi関数経由でPUT `/api/worktrees/:id/files/:path`を呼び出す。このAPIエンドポイントは以下の多層防御が適用される:

1. **middleware.ts**: CM_AUTH_TOKEN_HASHによるトークン認証（Edge Runtime互換のXOR定数時間比較）
2. **IP制限**: CM_ALLOWED_IPSによるIPアドレス/CIDR制限（isIpRestrictionEnabled/isIpAllowed）
3. **getWorktreeAndValidatePath**: Worktree存在確認 + isPathSafe()によるパストラバーサル防止
4. **isEditableFile**: 拡張子チェック（.mdのみ）
5. **validateContent**: コンテンツバリデーション（サイズ制限、バイナリ検出）

auto-saveが追加するのはfetch呼び出しの自動化のみであり、これらのセキュリティレイヤーは全て維持される。

**確認箇所**:
- `src/middleware.ts` Line 66-119: 認証ミドルウェア
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` Line 96-123: getWorktreeAndValidatePath
- 設計書 Section 6.1: 「既存のセキュリティ制約の維持」

### A02: Cryptographic Failures - PASS

localStorageに保存されるのはauto-save設定のboolean値（true/false）のみ。キー名は`commandmate:md-editor-auto-save`であり、ファイルコンテンツ、パス情報、認証トークン等のセンシティブデータは一切保存されない。暗号化の必要性はない。

**確認箇所**:
- 設計書 Section 6.2: 「localStorage: auto-save設定のみ（boolean）を保存。センシティブデータなし」

### A03: Injection - PASS

auto-saveはsaveToApi内で`JSON.stringify({ content: valueToSave })`としてコンテンツを送信する。APIエンドポイントのPUTハンドラーでは:

1. `request.json()`でパース
2. `validateContent(ext, content)`でNULLバイト検出、制御文字警告、サイズ制限を実施
3. `updateFileContent`で`writeFile` APIを使用してファイル書き込み

表示時にはrehype-sanitize（SEC-MF-001）によるXSS防御が適用される。auto-saveが導入しても、入力バリデーションと出力サニタイズのチェーンに変更はない。

**確認箇所**:
- `src/config/editable-extensions.ts` Line 69-106: validateContent関数
- `src/components/worktree/MarkdownEditor.tsx` Line 539-541: rehypeSanitize適用

### A04: Insecure Design - PASS (with note)

デバウンス3秒により最悪ケースで1分あたり最大20回のPUT要求となる。現行APIにレート制限はないが、以下の理由から実際のDoSリスクは極めて低い:

- デバウンスにより実際の呼び出しはユーザーの入力停止後のみ
- useAutoSaveのリトライ制限（maxRetries=3、指数バックオフ: 1s, 2s, 4s）により障害時の連続呼び出しが防止
- 単一ユーザーによるファイル編集操作

**確認箇所**:
- `src/hooks/useAutoSave.ts` Line 127-154: executeSave関数のリトライロジック
- 設計書 Section 6.2, 7.1: デバウンス・リトライ設計

### A05: Security Misconfiguration - PASS

エラー時のメッセージにスタックトレースが露出しない:

- **サーバーサイド**: `console.error('Error updating file:', error)`でサーバーログに記録
- **クライアントレスポンス**: `createErrorResponse('INTERNAL_ERROR', 'Failed to update file')`で固定文字列
- **UI表示**: `'Auto-save failed. Switched to manual save.'`で固定文字列

**確認箇所**:
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` Line 320-323: catchブロック
- 設計書 Section 4.5: エラーフォールバック

### A06: Vulnerable and Outdated Components - PASS

auto-save機能では新規の外部ライブラリ依存が追加されない。使用されるのはプロジェクト内部実装のuseAutoSave/useLocalStorageStateフックと、React本体のフック、標準fetch APIのみ。

### A07: Identification and Authentication Failures - Should Fix

**[DR4-001]** auto-save動作中にセッション切れ（認証失効）が発生した場合、middleware.tsは/loginへリダイレクトを返す。fetch APIのデフォルト動作ではリダイレクトに追従し、response.json()がHTMLパースでエラーとなる。useAutoSaveのリトライが3回実行後、エラーフォールバックでauto-saveがOFFになるため、データロスは防止される。しかし、ユーザーには認証切れであることが伝わらない。

**推奨対策**: saveToApi内で`response.status === 401`または`response.redirected === true`の場合を検出し、認証切れ専用のエラーメッセージを表示すること。

**リスク評価**: データロスは既存のフォールバック機構で防止されているため、セキュリティ脆弱性ではなくユーザー体験の改善事項。

### A08: Software and Data Integrity Failures - PASS

useAutoSaveフック内では:

1. デバウンスタイマーが1つのみ管理（`timerRef.current`）
2. 新しい変更で前回のタイマーをキャンセル後、新タイマーを設定
3. executeSaveはawaitされるため、同時に2つのexecuteSaveは実行されない
4. サーバーサイドはLast Write Winsの自然な動作

単一ユーザーのauto-saveシナリオでは整合性の問題は発生しない。

**確認箇所**:
- `src/hooks/useAutoSave.ts` Line 160-165: cancelPendingSave
- `src/hooks/useAutoSave.ts` Line 180-197: debounced save effect

### A09: Security Logging and Monitoring Failures - PASS

- **サーバーサイド**: route.tsのcatchブロックで`console.error`
- **クライアントサイド**: useAutoSaveのerror stateで保持
- **ユーザー通知**: エラーフォールバックのshowToast

### A10: Server-Side Request Forgery - N/A

auto-saveは内部API（同一オリジン）のみを呼び出すため、SSRFの対象外。

---

## Project-Specific Security Practices

### localStorage値バリデーション - PASS

設計書Section 4.3で`validate: isValidBoolean`が指定されており、`useLocalStorageState`のバリデーション関数パターンに完全に準拠している。localStorage値が改ざんされた場合も、`defaultValue: false`にフォールバックされる。

**確認箇所**:
- `src/types/markdown-editor.ts` Line 259-261: isValidBoolean関数
- `src/hooks/useLocalStorageState.ts` Line 139-141: validate適用ロジック

### APIエンドポイントの認証チェック - PASS

PUT `/api/worktrees/:id/files/:path`は`src/middleware.ts`の認証ミドルウェアで保護されている。auto-saveリクエストも通常のfetchリクエストと同様にmiddleware経由で処理される。

### エラーメッセージに機密情報を含めない - PASS

上記A05で確認した通り、エラーメッセージは全て固定文字列であり、内部パス、スタックトレース、サーバー設定等の機密情報は含まれない。

---

## Risk Assessment

| Risk Category | Level | Notes |
|---------------|-------|-------|
| Technical | Low | 既存フックの再利用、新規コード最小限 |
| Security | Low | 既存セキュリティレイヤー全て維持、新たな攻撃面なし |
| Operational | Low | エラーフォールバックによるデータロス防止 |

---

## Detailed Findings

### Should Fix (1)

#### DR4-001: auto-save動作中のセッション切れ時のエラーハンドリング

| Item | Detail |
|------|--------|
| Priority | Should Fix |
| Category | A07 (Identification and Authentication Failures) |
| Risk | Low - データロスはフォールバックで防止済み |

**現状の動作**: 認証切れ時にリダイレクトレスポンスをjson()でパースしようとしてエラーとなり、3回リトライ後にauto-save OFFへフォールバック。ユーザーには汎用エラーメッセージが表示される。

**推奨対策**: saveToApi内で以下のチェックを追加:

```typescript
const response = await fetch(url, options);

// 認証切れ検出
if (response.status === 401 || response.redirected) {
  throw new Error('Session expired. Please re-login.');
}

const data = await response.json();
```

### Nice to Have (9)

| ID | Category | Title | Assessment |
|----|----------|-------|------------|
| DR4-002 | A04 | デバウンス3秒のAPI呼び出し頻度 | 単一ユーザー環境で問題なし |
| DR4-003 | A05 | エラーメッセージのスタックトレース非露出 | 既存パターンで適切に対応 |
| DR4-004 | localStorage | isValidBooleanバリデーション適用 | プロジェクト慣行に完全準拠 |
| DR4-005 | A01 | 認証・認可の迂回なし | 既存セキュリティレイヤー全て維持 |
| DR4-006 | A03 | コンテンツサニタイズの適用 | 入力・出力両方で対応済み |
| DR4-007 | A08 | 並行保存要求の整合性 | Last Write Winsで問題なし |
| DR4-008 | A09 | エラーログ記録 | サーバー・クライアント両方で対応 |
| DR4-009 | A02 | localStorage機密情報なし | boolean値のみ |
| DR4-010 | A06 | 追加ライブラリなし | 脆弱性リスクゼロ |

---

## Security Architecture Diagram

```
User Input (textarea)
    |
    v
[useAutoSave] -- debounce 3s --> [saveToApi]
    |                                |
    |                                v
    |                          [fetch PUT API]
    |                                |
    |                    +-----------+-----------+
    |                    |                       |
    |               [middleware.ts]          [Error Path]
    |                    |                       |
    |              +-----------+            [maxRetries=3]
    |              |           |                 |
    |         [Auth Check] [IP Check]      [Error State]
    |              |           |                 |
    |              v           v            [Fallback OFF]
    |         [route.ts PUT handler]             |
    |              |                        [showToast]
    |    +---------+---------+
    |    |         |         |
    |  [Path    [Editable [Content
    |   Safe]    Check]   Validate]
    |    |         |         |
    |    v         v         v
    |         [writeFile]
    |              |
    |    [setOriginalContent]
    |              |
    v              v
[isDirty = false]
```

---

## Conclusion

auto-save機能追加の設計は、セキュリティ上の懸念が極めて少ない。主な理由は:

1. **新たな攻撃面が追加されない**: 既存のPUT APIエンドポイントを同一のパスで呼び出すのみ
2. **全てのセキュリティレイヤーが維持される**: 認証、IP制限、パスバリデーション、コンテンツバリデーション、XSSサニタイズ
3. **外部ライブラリ依存なし**: 全てプロジェクト内部実装
4. **localStorage使用が最小限**: boolean値のみ、機密情報なし
5. **エラーハンドリングが適切**: フォールバック機構によるデータロス防止、固定文字列エラーメッセージ

Should Fix 1件（DR4-001: 認証切れ時のエラーメッセージ改善）は実装時に対応を推奨するが、セキュリティ脆弱性ではなくユーザー体験の改善事項であり、ブロッカーではない。

**判定: Approved (Score: 5/5)**

---

*Generated by architecture-review-agent for Issue #389*
*Stage 4: Security Review (OWASP Top 10)*
*Date: 2026-03-02*
