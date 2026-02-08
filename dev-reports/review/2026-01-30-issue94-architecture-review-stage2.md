# Architecture Review Report - Issue #94 File Upload Feature

## Review Overview

| Item | Value |
|------|-------|
| Issue Number | #94 |
| Review Stage | Stage 2 - Consistency Review (整合性レビュー) |
| Review Date | 2026-01-30 |
| Reviewer | architecture-review-agent |
| Design Document | `dev-reports/design/issue-94-file-upload-design-policy.md` |

---

## Summary

| Severity | Count |
|----------|-------|
| must_fix | 2 |
| should_fix | 5 |
| nice_to_have | 3 |
| **Total** | **10** |

### Overall Assessment

設計書は既存コードベースとの整合性を概ね保っているが、型定義の拡張箇所とAPIレスポンス形式において重要な不整合がある。特に FileOperationErrorCode 型の拡張と FileOperationResult の filename フィールドについては、実装前に設計を明確化する必要がある。

---

## Must Fix (2 items)

### CONS-001: Type Definition Consistency

**Category**: Type Definition Consistency

**Description**:
設計書の isValidNewName() 拡張でオプション引数を追加する提案があるが、既存の FileOperationResult インターフェースに size プロパティを追加する際の型定義が不完全。createErrorResult() 関数は FileOperationErrorCode 型のみを受け付けるが、設計書で追加予定の INVALID_EXTENSION, INVALID_MIME_TYPE, FILE_TOO_LARGE は FileOperationErrorCode 型に追加されていない状態で ERROR_CODE_TO_HTTP_STATUS マッピングにのみ言及している。

**Location**: `src/lib/file-operations.ts:35-45`, design doc section 3.1

**Existing Code Reference**:
```typescript
// src/lib/file-operations.ts:35-45
export type FileOperationErrorCode =
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_PATH'
  | 'INVALID_NAME'
  | 'DIRECTORY_NOT_EMPTY'
  | 'FILE_EXISTS'
  | 'PROTECTED_DIRECTORY'
  | 'DELETE_LIMIT_EXCEEDED'
  | 'DISK_FULL'
  | 'INTERNAL_ERROR';
```

**Suggestion**:
FileOperationErrorCode 型の拡張と ERROR_CODE_TO_HTTP_STATUS マッピングの両方を同時に更新することを実装チェックリストに明記する。また、createErrorResult() 関数が新しいエラーコードを受け付けられることを確認するテストケースを追加する。

---

### CONS-002: API Pattern Consistency

**Category**: API Pattern Consistency

**Description**:
設計書では新しいアップロードAPIのレスポンスに filename フィールドを含めると記載(section 3.1)しているが、既存の FileOperationResult インターフェースには filename プロパティが存在しない。writeBinaryFile() 関数の戻り値設計(section 3.3)では FileOperationResult を返すとしているが、filename を含める設計との整合性が取れていない。

**Location**: design doc section 3.1 response format vs section 3.3 writeBinaryFile()

**Existing Code Reference**:
```typescript
// src/lib/file-operations.ts:22-30
export interface FileOperationResult {
  success: boolean;
  path?: string;
  content?: string;
  error?: {
    code: string;
    message: string;
  };
}
```

**Suggestion**:
APIルート側で filename を追加してレスポンスを構築するか、FileOperationResult に filename?: string を追加する。どちらの方針か明記し、既存の createFileOrDirectory() 等との一貫性を保つ。

---

## Should Fix (5 items)

### CONS-003: Interface Pattern Consistency

**Category**: Interface Pattern Consistency

**Description**:
設計書の UploadableExtensionValidator インターフェースは maxFileSize を必須プロパティとしているが、既存の ExtensionValidator では maxFileSize?: number とオプショナルになっている。パターン統一を謳いながら(CONSISTENCY-001)、オプショナル/必須の違いがある。

**Location**: `src/config/editable-extensions.ts:20-27` vs design doc section 3.2

**Suggestion**:
アップロードでは全拡張子でサイズ制限が必須という設計判断は妥当。ただし、将来的に editable-extensions.ts もサイズ制限必須に統一するか、意図的な違いであることを設計書に明記する。

---

### CONS-004: Context Menu Consistency

**Category**: Context Menu Consistency

**Description**:
設計書では ContextMenu.tsx にアップロードメニュー項目を追加すると記載しているが、既存の ContextMenuProps インターフェースには onUpload コールバックが定義されていない。FileTreeViewProps には onUpload を追加する計画があるが、ContextMenuProps への追加が明記されていない。

**Location**: `src/components/worktree/ContextMenu.tsx:24-43`, design doc section 3.4

**Existing Code Reference**:
```typescript
// src/components/worktree/ContextMenu.tsx:24-43
export interface ContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  targetPath: string | null;
  targetType: 'file' | 'directory' | null;
  onClose: () => void;
  onNewFile?: (parentPath: string) => void;
  onNewDirectory?: (parentPath: string) => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
  // onUpload is missing!
}
```

**Suggestion**:
ContextMenuProps インターフェースに `onUpload?: (targetPath: string) => void` を追加することを実装チェックリストに明記する。

---

### CONS-005: Test Pattern Consistency

**Category**: Test Pattern Consistency

**Description**:
設計書のテスト設計(section 7.1)では test.each() を使用したパラメタライズドテストパターンを採用しているが、既存の editable-extensions.test.ts では個別の it() を使用している。テストパターンの統一性が異なる。

**Location**: `tests/unit/config/editable-extensions.test.ts` vs design doc section 7.1

**Suggestion**:
新規テストファイルでは test.each() パターンを採用して問題ないが、将来的な保守性のため同一ディレクトリ内でのテストパターン統一を検討する。もしくは既存パターンに合わせて個別 it() で記述する。

---

### CONS-006: Configuration Consistency

**Category**: Configuration Consistency

**Description**:
next.config.js の現在の bodySizeLimit は 2mb だが、設計書では 6mb に変更すると記載。5MB のファイルサイズ制限に対して 6mb の bodySizeLimit は妥当だが、既存設定との大きな乖離(3倍)があることの影響説明がない。

**Location**: `next.config.js:9-11` vs design doc section 4.5

**Existing Code**:
```javascript
// next.config.js
experimental: {
  serverActions: {
    bodySizeLimit: '2mb', // Current: 2mb, Design: 6mb
  },
},
```

**Suggestion**:
bodySizeLimit 変更の影響範囲(メモリ使用量、既存APIへの影響)を設計書に追記する。また、ファイルアップロードAPIのみに適用するための route segment config 使用を検討する。

---

### CONS-007: Naming Consistency

**Category**: Naming Consistency

**Description**:
設計書では UPLOADABLE_EXTENSION_VALIDATORS という命名を使用しているが、既存の EXTENSION_VALIDATORS との命名パターンが異なる(UPLOADABLE_ プレフィックス)。EDITABLE_EXTENSIONS と UPLOADABLE_EXTENSIONS は同パターンだが、VALIDATORS の方は異なる。

**Location**: `src/config/editable-extensions.ts:32` vs design doc section 3.2

**Suggestion**:
命名の一貫性のため UPLOADABLE_VALIDATORS に統一するか、既存を EDITABLE_EXTENSION_VALIDATORS にリネームするか検討。現状は許容範囲だが、将来の混乱を避けるため統一ルールを明記する。

---

## Nice to Have (3 items)

### CONS-008: Hook Type Consistency

**Category**: Hook Type Consistency

**Description**:
設計書では useContextMenu.ts にアップロードアクション型を追加すると記載しているが、現在の useContextMenu.ts は ContextMenuState 型を types/markdown-editor.ts からインポートしており、アクション型は定義されていない。追加すべき型の詳細が不明確。

**Suggestion**:
アップロードアクション型の具体的な定義を設計書に追記するか、型追加が不要であれば影響範囲から削除する。

---

### CONS-009: Import Path Consistency

**Category**: Import Path Consistency

**Description**:
設計書の writeBinaryFile() 実装例では isPathSafe のインポートパスが明記されていないが、既存の file-operations.ts では './path-validator' から相対インポートしている。新規追加コードでも同じパスを使用することを確認する必要がある。

**Suggestion**:
設計書のコード例にインポート文を追加するか、既存のインポートパターンを参照するよう注記を追加する。

---

### CONS-010: Error Message Consistency

**Category**: Error Message Consistency

**Description**:
設計書のエラーメッセージ(section 5.2)は日本語で記載されているが、既存の ERROR_MESSAGES は英語で統一されている。APIレスポンスのエラーメッセージをどちらの言語で返すか明確でない。

**Existing Code**:
```typescript
// src/lib/file-operations.ts:50-61
const ERROR_MESSAGES: Record<FileOperationErrorCode, string> = {
  FILE_NOT_FOUND: 'File not found',
  PERMISSION_DENIED: 'Permission denied',
  // ... all in English
};
```

**Suggestion**:
APIレスポンスは英語のエラーメッセージを返し、UIでの表示時に日本語に変換する設計とする。設計書のエラーメッセージがUI表示用であることを明記する。

---

## Reviewed Files

The following files were reviewed for consistency analysis:

| File | Purpose |
|------|---------|
| `src/config/editable-extensions.ts` | Extension validation pattern reference |
| `src/lib/file-operations.ts` | File operation interface and error handling |
| `src/lib/path-validator.ts` | Path validation utilities |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | Existing file API patterns |
| `src/components/worktree/ContextMenu.tsx` | Context menu props and structure |
| `src/components/worktree/FileTreeView.tsx` | File tree props definition |
| `src/hooks/useContextMenu.ts` | Hook type definitions |
| `src/types/markdown-editor.ts` | Type definitions for editor |
| `next.config.js` | Configuration settings |
| `tests/unit/config/editable-extensions.test.ts` | Test pattern reference |
| `tests/unit/lib/file-operations.test.ts` | Test pattern reference |

---

## Recommendations

### Priority 1: Must Fix Before Implementation
1. **CONS-001**: Update FileOperationErrorCode type definition and ensure createErrorResult() compatibility
2. **CONS-002**: Clarify filename handling in API response vs FileOperationResult

### Priority 2: Address During Implementation
3. **CONS-004**: Add onUpload to ContextMenuProps
4. **CONS-006**: Document bodySizeLimit change impact
5. **CONS-003, CONS-007**: Document intentional pattern differences

### Priority 3: Consider for Future
6. **CONS-005, CONS-008, CONS-009, CONS-010**: Minor consistency improvements

---

*Generated by architecture-review-agent on 2026-01-30*
