# Issue #395: Proxy Security Hardening - Stage 2 整合性レビュー

## Executive Summary

Issue #395 設計方針書のStage 2（整合性レビュー）を実施した。設計方針書と既存コードの間の行番号参照、変数名、型定義、テストコード、CLAUDE.md記載との整合性を検証した。

**ステータス**: Conditionally Approved (must_fix 2件の行番号修正後に実装着手可能)

| 重要度 | 件数 |
|--------|------|
| must_fix | 2 |
| should_fix | 3 |
| nice_to_have | 4 |

---

## 検証した整合性項目

### 検証対象ファイル

| ファイル | 検証内容 |
|---------|---------|
| `src/lib/proxy/handler.ts` | 行番号、変数名、関数シグネチャ、コメント文 |
| `src/lib/proxy/config.ts` | 既存定数名、配列パターン、export構造 |
| `src/components/external-apps/ExternalAppForm.tsx` | JSX構造、挿入位置、既存パターン |
| `tests/unit/proxy/handler.test.ts` | 既存テストのアサーション内容、テスト名 |
| `src/app/proxy/[...path]/route.ts` | proxyWebSocket呼び出しシグネチャ |
| `CLAUDE.md` | handler.ts / config.ts 既存記載 |

---

## Detailed Findings

### DR2-001 [must_fix] リクエストヘッダフィルタリング行番号の不整合

**設計方針書**: Section 4-2 見出し「リクエストヘッダフィルタリング（L62-68）」

**実コード** (`src/lib/proxy/handler.ts`):
- L60: `// Clone headers, removing hop-by-hop headers` (コメント行 -- 更新対象)
- L61: `const headers = new Headers();`
- L62-68: `request.headers.forEach(...)` ループ

設計方針書のコード例はL60のコメント行から始まっているが、見出しの「L62-68」はコメント行を含んでいない。DR1-006でコメント更新を明記しているため、変更範囲はL60-68とすべき。

同様に、レスポンス側の見出し「L87-94」はコメント行L86（`// Clone response headers, removing hop-by-hop headers`）を含んでいない。変更範囲はL86-94とすべき。

**対応**: 見出しの行番号を「L60-68」「L86-94」に修正する。

---

### DR2-002 [must_fix] レスポンスヘッダフィルタリング行番号がコメント行を含んでいない

**設計方針書**: Section 4-2 見出し「レスポンスヘッダフィルタリング（L87-94）」

**実コード** (`src/lib/proxy/handler.ts`):
- L86: `// Clone response headers, removing hop-by-hop headers` (コメント行 -- DR1-006で更新対象)
- L87: `const responseHeaders = new Headers();`
- L88-94: `response.headers.forEach(...)` ループ

DR1-006の反映により、L86のコメントも更新対象に含まれることが Section 4-2 コメント更新節で明記されているが、見出しの行番号範囲がこれと矛盾する。

**対応**: 「L87-94」を「L86-94」に修正する。

---

### DR2-003 [should_fix] 既存テスト修正計画とテスト実態の齟齬

**設計方針書**: Section 6「既存テスト修正: 『should forward request headers』のAuthorization転送期待を除去」

**実テストコード** (`tests/unit/proxy/handler.test.ts` L83-105):
```typescript
it('should forward request headers', async () => {
  // ...
  const request = new Request('http://localhost:3000/proxy/test/api', {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer token123',
      'X-Custom-Header': 'custom-value',
    },
  });
  // ...
  expect(global.fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.any(Headers),
    })
  );
});
```

テストのアサーションはHeaders オブジェクトが存在することだけを検証しており、Authorizationヘッダの転送を明示的にアサートしていない。「Authorization転送期待を除去」はテストのインプットからの除去を意味するのか不明確。

**対応**: テスト修正方針を「(1) テストのインプットからAuthorization設定を除去、(2) 新規テストケースでAuthorizationストリッピングを明示的にアサート」のように具体化する。

---

### DR2-004 [should_fix] 既存WebSocketテストの更新方針が未記載

**設計方針書**: Section 6 では proxyWebSocket() の新規テストケースを記載しているが、既存テスト `should include WebSocket upgrade instructions in error response` (L194-210) の扱いが未記載。

**実テストコード**: `expect(body.message).toContain('WebSocket')` は修正後の `PROXY_ERROR_MESSAGES.UPGRADE_REQUIRED` にも「WebSocket」が含まれるためパスする。しかし、テスト名の「instructions」は修正後のレスポンス（instructionを含まない固定文字列）と矛盾する。

**対応**: 既存テストのテスト名更新または新規テストとの統合方針をテスト設計に追記する。

---

### DR2-005 [should_fix] import文の記載順序が既存コードと不整合

**設計方針書**: Section 4-2 のimport例:
```
HOP_BY_HOP_REQUEST_HEADERS, HOP_BY_HOP_RESPONSE_HEADERS,
SENSITIVE_REQUEST_HEADERS, SENSITIVE_RESPONSE_HEADERS,
PROXY_TIMEOUT, PROXY_STATUS_CODES, PROXY_ERROR_MESSAGES,
```

**実コード** (`src/lib/proxy/handler.ts` L13-19):
```
PROXY_TIMEOUT,
HOP_BY_HOP_REQUEST_HEADERS,
HOP_BY_HOP_RESPONSE_HEADERS,
PROXY_STATUS_CODES,
PROXY_ERROR_MESSAGES,
```

設計方針書の「既存」「新規」コメント区分は説明用であり、実装時は既存の順序を維持して SENSITIVE_* を適切な位置に挿入すべき。

**対応**: 実装時のimport順序に関する注記を追加するか、コード例を既存順序に合わせる。

---

### DR2-006 [nice_to_have] route.tsの暗黙的動作変更

設計方針書はroute.tsを「変更不要」としているが、proxyWebSocket()のレスポンス変更により、route.ts経由のWebSocket upgradeレスポンス内容が変わる。コード変更は不要だが動作変更はある旨の注釈があると影響範囲の理解が容易になる。

---

### DR2-007 [nice_to_have] DR1-007設計判断の行番号参照ずれ

設計方針書Section 4-3末尾「handler.ts L106 'Gateway Timeout', L119 'Bad Gateway'」と記載されているが、実コードではL107が`error: 'Gateway Timeout'`、L121が`error: 'Bad Gateway'`。

---

### DR2-008 [nice_to_have] CLAUDE.md更新内容の具体性不足

受け入れ条件#8で「CLAUDE.mdの handler.ts / config.ts 説明が更新されている」とあるが、更新後の具体的な文面が設計方針書に示されていない。既存記載との差分が明確でない。

---

### DR2-009 [nice_to_have] ExternalAppForm.tsx警告バナーの挿入位置が未特定

「フォーム上部」との記載はあるが、具体的な挿入位置（`<form>` 直下の先頭、Display Nameフィールドの前）が明記されていない。

---

## 整合性検証サマリー

| 検証項目 | 結果 | 備考 |
|---------|------|------|
| 行番号の正確性 | 一部不整合 | DR2-001, DR2-002, DR2-007 |
| 変数名・型名 | 整合 | SENSITIVE_REQUEST_HEADERS等の命名は既存パターンと整合 |
| 関数シグネチャ | 整合 | proxyWebSocket()のパラメータ維持方針は route.ts と整合 |
| 変更ファイル一覧 | 整合 | 5ファイル全て存在し、変更種別は正確 |
| テスト計画 | 一部不整合 | DR2-003, DR2-004: 既存テストの実態との齟齬 |
| 受け入れ条件 | おおむね整合 | #8のCLAUDE.md更新の具体性が不足(DR2-008) |
| 既存パターンとの一貫性 | 整合 | `as const`配列 + `.includes()`パターンは既存と一貫 |
| import/export構造 | 一部不整合 | DR2-005: import順序の不一致 |
| コンポーネント構造 | おおむね整合 | DR2-009: 挿入位置の特定が不足 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 実装ミス | 行番号不整合による誤った箇所の修正 | Medium | Low | P2 |
| テスト品質 | 既存テストとの整合が不明確でTDDサイクルが滞る | Medium | Medium | P2 |
| レビュー負荷 | import順序の差異がPRレビューで指摘される | Low | Medium | P3 |

---

## 結論

設計方針書は既存コードベースとの整合性がおおむね高く、実装可能な品質である。must_fix 2件は行番号の軽微な修正であり、対応コストは低い。should_fix 3件はテスト設計の明確化とimport順序の調整であり、TDDサイクルの効率に影響するため修正が望ましい。nice_to_have 4件は設計方針書の完全性を高めるための補足であり、実装時の判断でも対応可能。

**判定**: Conditionally Approved -- must_fix 2件の修正後に実装着手可能。

---

*Generated by architecture-review-agent for Issue #395 Stage 2*
*Review date: 2026-03-03*
