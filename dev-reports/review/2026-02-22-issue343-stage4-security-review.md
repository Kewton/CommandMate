# Architecture Review Report: Issue #343 - Stage 4 Security Review

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #343 - feat: スラッシュコマンドセレクターで .claude/skills も表示する |
| Stage | Stage 4: セキュリティレビュー |
| Focus | セキュリティ (OWASP Top 10 準拠確認) |
| Status | **needs_improvement** |
| Score | 2/5 |
| Reviewed | 2026-02-22 |

**総合評価**: 設計方針書のセキュリティ設計は skills ディレクトリ走査時のパストラバーサル対策に注力しており、3 層防御（isDirectory, .. 拒否, startsWith 検証）は適切である。しかし、**gray-matter ライブラリの JavaScript エンジンによるリモートコード実行 (RCE)** という CRITICAL レベルの脆弱性が存在し、これが未対策である。加えて、ファイル数/サイズの上限が設定されておらず DoS リスクがある。実装前にこれらの対策が必要である。

---

## Detailed Findings

### Must Fix (2 items)

#### S001: gray-matter の JavaScript エンジンによるリモートコード実行 (RCE)

| Property | Value |
|----------|-------|
| Severity | **CRITICAL / Must Fix** |
| OWASP | A03 (Injection) |
| Category | injection |
| Location | 設計方針書 3-2 `parseSkillFile()` |

**問題**: gray-matter@4.0.3 は frontmatter 区切り文字として `---js` および `---javascript` をサポートしており、内部の `engines.js` で `eval()` を使用して JavaScript コードを実行する。

```javascript
// node_modules/gray-matter/lib/engines.js (L37-44)
engines.javascript = {
  parse: function parse(str, options, wrap) {
    try {
      if (wrap !== false) {
        str = '(function() {\nreturn ' + str.trim() + ';\n}());';
      }
      return eval(str) || {};
    } catch (err) { /* ... */ }
  },
};
```

**攻撃シナリオ**: 悪意ある SKILL.md ファイルが以下のように作成された場合:

```markdown
---js
{name: "pwned", rce: (function(){ return require("child_process").execSync("whoami").toString().trim() })()}
---
Normal skill content
```

`parseSkillFile()` が `matter(content)` を呼び出した時点で、サーバー上で任意のコードが実行される。

**検証結果**: 実際に検証を行い、`require('child_process').execSync('whoami')` がサーバーのユーザー名を返すことを確認した。

**影響範囲**: 既存の `parseCommandFile()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/slash-commands.ts` L38-57) にも同一の脆弱性が存在する。skills は worktree パス経由で外部リポジトリから読み込まれるため、攻撃面が拡大する。

**改善案**: gray-matter の呼び出し時に `engines` オプションで JavaScript エンジンを無効化する。共通のラッパー関数を作成して両方の関数で使用する:

```typescript
// src/lib/safe-frontmatter.ts (新規)
import matter from 'gray-matter';

/**
 * Security: Disable gray-matter's JavaScript engine to prevent RCE.
 * gray-matter supports ---js/---javascript delimiters that trigger eval().
 * See: node_modules/gray-matter/lib/engines.js
 */
const SAFE_MATTER_OPTIONS = {
  engines: {
    js: {
      parse: () => { throw new Error('JavaScript engine is disabled for security'); },
      stringify: () => { throw new Error('JavaScript engine is disabled for security'); },
    },
    javascript: {
      parse: () => { throw new Error('JavaScript engine is disabled for security'); },
      stringify: () => { throw new Error('JavaScript engine is disabled for security'); },
    },
  },
};

export function safeParseFrontmatter(content: string) {
  return matter(content, SAFE_MATTER_OPTIONS);
}
```

---

#### S002: skills ディレクトリ走査およびファイル読み込みに上限がない

| Property | Value |
|----------|-------|
| Severity | **HIGH / Must Fix** |
| OWASP | A05 (Security Misconfiguration) |
| Category | dos |
| Location | 設計方針書 3-2 `loadSkills()` |

**問題**: `loadSkills()` の for ループに走査するディレクトリ数の上限がなく、`parseSkillFile()` の `readFileSync` にファイルサイズの上限がない。

**攻撃シナリオ**:
1. 攻撃者が worktree リポジトリの `.claude/skills/` 配下に 10,000 個のサブディレクトリを作成
2. 各ディレクトリに 100MB の SKILL.md を配置
3. API リクエスト `/api/worktrees/[id]/slash-commands` がタイムアウトまたはメモリ枯渇

**Stage 3 の I005 との関係**: Stage 3 で「YAGNI に基づき現時点では対応不要」と記録されているが、worktree パスは外部リポジトリを指すためセキュリティ観点からは上限値の設定が必要である。

**改善案**: 以下の定数を定義し適用する:

```typescript
/** Maximum number of skill subdirectories to scan */
const MAX_SKILLS_COUNT = 100;

/** Maximum file size for SKILL.md (64KB) */
const MAX_SKILL_FILE_SIZE = 64 * 1024;
```

---

### Should Fix (5 items)

#### S003: loadSlashCommands() のパストラバーサル対策が loadSkills() と非対称

| Property | Value |
|----------|-------|
| Severity | Should Fix |
| OWASP | A01 (Broken Access Control) |
| Category | path_traversal |
| Location | `/Users/maenokota/share/work/github_kewton/commandmate-issue-343/src/lib/slash-commands.ts` L75-84 |

**問題**: `loadSkills()` には 3 層防御が設計されているが、既存の `loadSlashCommands()` には同等の防御がない。`readdirSync` で取得したファイル名に対して `path.join(commandsDir, file)` で結合するのみ。

**改善案**: 共通のパス検証ヘルパー関数を抽出し、両関数で使用する。

---

#### S004: SKILL.md ファイル自体がシンボリックリンクである場合の検証不足

| Property | Value |
|----------|-------|
| Severity | Should Fix |
| OWASP | A01 (Broken Access Control) |
| Category | symlink |
| Location | 設計方針書 3-2 `parseSkillFile()` |

**問題**: 3 層防御はサブディレクトリレベルのシンボリックリンクを検出するが、サブディレクトリ内の SKILL.md ファイル自体がシンボリックリンク（例: `/etc/passwd` へのリンク）である場合は検出されない。

**改善案**: `parseSkillFile()` 内で `fs.lstatSync(skillPath).isSymbolicLink()` を事前チェックする。

---

#### S005: YAML ボム（Billion Laughs）攻撃の考慮不足

| Property | Value |
|----------|-------|
| Severity | Should Fix |
| OWASP | A04 (Insecure Design) |
| Category | dos |
| Location | 設計方針書 6 セキュリティ設計 |

**問題**: セキュリティ設計に YAML ボム攻撃への言及がない。js-yaml 3.x の safeLoad は一定の保護を提供するが、明示的な分析が必要。

**改善案**: S002 のファイルサイズ上限が実質的な緩和策となる旨をドキュメントに記載する。

---

#### S006: console.error() でのフルパスおよびエラースタック情報の出力

| Property | Value |
|----------|-------|
| Severity | Should Fix |
| OWASP | A08 (Software and Data Integrity Failures) |
| Category | info_disclosure |
| Location | 設計方針書 3-2 `parseSkillFile()` catch ブロック |

**問題**: エラーログにフルパス（ユーザー名含むホームディレクトリ）とスタックトレースが出力される。

**改善案**: 相対パスに限定し、error.message のみを出力する。

---

#### S007: frontmatter の name/description フィールドの長さ・文字種制限がない

| Property | Value |
|----------|-------|
| Severity | Should Fix |
| OWASP | A06 (Vulnerable and Outdated Components) |
| Category | other |
| Location | 設計方針書 3-2 `parseSkillFile()` return オブジェクト |

**問題**: frontmatter 由来の name/description が極端に長い場合の処理が未定義。

**改善案**: `truncateString()` で name を 100 文字、description を 500 文字に制限する。

---

### Nice to Have (3 items)

#### S008: XSS リスクの明示的分析と React エスケープへの依存ドキュメント化

| Property | Value |
|----------|-------|
| Severity | Nice to Have |
| OWASP | A07 |
| Category | xss |

React の JSX テキストノード描画による自動エスケープで XSS は防御されるが、設計書に明示的な分析を記載すべき。`SlashCommandList.tsx` は `{command.name}` および `{command.description}` を JSX で描画しており、`dangerouslySetInnerHTML` は使用していない。

---

#### S009: filePath フィールドの path.relative() にパス情報漏洩リスク

| Property | Value |
|----------|-------|
| Severity | Nice to Have |
| OWASP | A01 |
| Category | path_traversal |

worktree パス指定時に `path.relative(process.cwd(), skillPath)` が `../..` を含む相対パスを返し、ディレクトリ構造情報が漏洩する可能性。

---

#### S010: セキュリティ設計セクションに OWASP Top 10 マッピングが不足

| Property | Value |
|----------|-------|
| Severity | Nice to Have |
| OWASP | N/A |
| Category | other |

各対策の OWASP カテゴリマッピングを明示することで網羅性の検証が容易になる。

---

## OWASP Top 10 Compliance Checklist

| OWASP | Category | Status | Notes |
|-------|----------|--------|-------|
| A01 | Broken Access Control | Partial | 3 層防御は適切だが loadSlashCommands との非対称性 (S003)、SKILL.md シンボリックリンク未検証 (S004) |
| A02 | Cryptographic Failures | N/A | 本機能スコープ外 |
| A03 | Injection | **CRITICAL** | gray-matter JavaScript エンジン RCE (S001) |
| A04 | Insecure Design | Partial | DoS 上限未設定 (S002)、YAML ボム未考慮 (S005) |
| A05 | Security Misconfiguration | Partial | gray-matter デフォルト設定の危険性 (S001) |
| A06 | Vulnerable/Outdated Components | Partial | js-yaml 3.x、gray-matter 4.x の JavaScript エンジン |
| A07 | Auth Failures | OK | 既存認証機構で保護 |
| A08 | Software/Data Integrity | OK | ローカルファイル読み取りのみ |
| A09 | Logging/Monitoring | Partial | フルパス出力 (S006)、セキュリティイベントログ不足 |
| A10 | SSRF | N/A | 外部リクエストなし |

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Security | gray-matter RCE (S001) | **Critical** | Medium | **P0** |
| Security | DoS via unlimited traversal (S002) | High | Low | P1 |
| Security | Symlink bypass (S004) | Medium | Low | P2 |
| Technical | loadSlashCommands non-symmetric security (S003) | Medium | Low | P2 |
| Operational | Log information disclosure (S006) | Low | Medium | P3 |

---

## Improvement Recommendations

### Must Fix (P0/P1) - 実装前に必ず対処

1. **S001**: `safeParseFrontmatter()` ラッパー関数を作成し、gray-matter の JavaScript エンジンを無効化する。`parseSkillFile()` と `parseCommandFile()` の両方に適用する。
2. **S002**: `MAX_SKILLS_COUNT` と `MAX_SKILL_FILE_SIZE` の上限値を定義し、`loadSkills()` と `parseSkillFile()` で適用する。

### Should Fix (P2) - 初期リリースまでに対処推奨

3. **S003**: `loadSlashCommands()` に `loadSkills()` と同等のパス検証を追加する。
4. **S004**: SKILL.md のシンボリックリンクチェックを `parseSkillFile()` に追加する。
5. **S005**: セキュリティ設計に YAML ボム攻撃の分析を追記する。
6. **S006**: ログ出力を相対パスと error.message に限定する。
7. **S007**: name/description の長さ制限を追加する。

### Consider (P3) - 将来の検討事項

8. **S008**: XSS 防御の明示的ドキュメント化。
9. **S009**: filePath の basePath 基準化。
10. **S010**: OWASP マッピングの追加。

---

## Approval Status

**Status: needs_major_changes**

S001 (gray-matter RCE) は CRITICAL レベルの脆弱性であり、実装コードに直接影響する。設計方針書のセキュリティ設計セクションに gray-matter の安全な使用方法を明記し、`safeParseFrontmatter()` ラッパーの設計を追加した上で、実装を進める必要がある。S002 (DoS 上限値) も合わせて設計に組み込むことで、セキュリティリスクを許容可能なレベルに低減できる。

---

*Generated: 2026-02-22*
*Reviewer: Architecture Review Agent (Stage 4 Security)*
