# Stage 4 セキュリティレビュー: Issue #166 - Codexカスタムスキル読込対応

**レビュー日**: 2026-03-14
**対象設計書**: `dev-reports/design/issue-166-codex-skills-loader-design-policy.md`
**ステージ**: 4/4（セキュリティレビュー）

---

## 総合評価

設計書のセキュリティ設計は全体として堅実である。既存の`loadSkills()`実装で実績のあるセキュリティパターンを忠実に踏襲しており、既存コードとの一貫性が確保されている。Must Fixの指摘はなく、セキュリティ観点からIssue #166の設計は承認可能と判断する。

| 重要度 | 件数 |
|--------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

---

## セキュリティチェック結果

### 1. パストラバーサル防御

| チェック項目 | 判定 | 詳細 |
|------------|------|------|
| `entry.name.includes('..')`による防御 | OK | Node.jsの`fs.readdirSync()`はOSレベルのディレクトリエントリ名を返すため、URLエンコード(`%2F`等)された文字列が`entry.name`に現れることはない。十分な防御。 |
| `resolvedPath.startsWith()`による検証 | OK | `path.resolve(skillsDir) + path.sep`の結合により、`skills-evil`のようなプレフィックス一致攻撃も防止。 |

### 2. symlink防御

| チェック項目 | 判定 | 詳細 |
|------------|------|------|
| `resolvedPath`ベースの検証 | WARNING | レキシカル(文字列)ベースの検証であり、`realpathSync()`によるsymlink解決を行っていない。既存`loadSkills()`と同一パターンだが、理論上はsymlinkを通じたskillsDir外ファイルの読み込みが可能。ただし読み込みはテキスト内容のみでコード実行パスがないため実質的リスクは低い。 |

### 3. ファイル内容のサニタイズ

| チェック項目 | 判定 | 詳細 |
|------------|------|------|
| `safeParseFrontmatter()`のJSエンジン無効化 | OK | `---js`/`---javascript`デリミタによる`eval()`攻撃を確実に防止。 |
| SKILL.md body部分のリスク | OK | body部分は読み込まれない（name/descriptionのみ抽出）。UIでの表示はReactのJSXエスケープにより保護。 |

### 4. ホームディレクトリアクセス

| チェック項目 | 判定 | 詳細 |
|------------|------|------|
| `os.homedir()`の信頼性 | OK | サーバーサイド実行のためクライアントからの操作経路なし。HOME環境変数が改ざんされている環境はそもそも全体的に侵害されている。 |
| `~/.codex/skills/`の悪意ある内容リスク | OK | テキスト読み込みのみ、コード実行パスなし、サイズ/件数制限あり。 |

### 5. 既存コードとの一貫性

| チェック項目 | 判定 | 詳細 |
|------------|------|------|
| `loadSkills()`との同等セキュリティ | OK | 全セキュリティパターン（`..`拒否、resolvedPath検証、parseSkillFile共用、MAX_SKILLS_COUNT制限）が同一。 |

---

## 指摘事項

### D4-001 [Should Fix] symlink防御がpath.resolve()ベースでありrealpathSync()を使用していない

**カテゴリ**: セキュリティ

`loadCodexSkills()`のsymlink防御は`path.resolve(skillsDir, entry.name)`で解決したパスがskillsDir配下であることを検証しているが、これはレキシカル(文字列)ベースの検証である。skillsDir配下にシンボリックリンクが存在し、そのリンク先がskillsDir外のファイルを指している場合、resolvedPathはskillsDir内のパスとして検証を通過するが、`fs.statSync()`/`fs.readFileSync()`はsymlinkを追跡して外部ファイルを読み込む。

既存の`path-validator.ts`には`resolveAndValidateRealPath()`関数が存在し、`realpathSync()`でsymlink解決後に検証を行うより堅牢なパターンが実装されている。

**ただし**:
- 既存`loadSkills()`も同一パターンで稼働中
- 読み込まれるのはテキスト内容のみ（コード実行なし）
- 実質的な攻撃面は限定的

**推奨対応**: Issue #166のスコープでは既存パターンを踏襲する判断は妥当。改善する場合は`loadSkills()`と`loadCodexSkills()`の両方を同時に修正すべきであり、別Issueとして切り出すことを推奨する。

---

### D4-002 [Nice to Have] グローバルスキルのfilePathが不自然な相対パスになる

**カテゴリ**: セキュリティ（情報漏洩）

`parseSkillFile()`は`path.relative(process.cwd(), skillPath)`でfilePathを計算する。グローバルスキル(`~/.codex/skills/`)の場合、`../../.codex/skills/xxx/SKILL.md`のような`..`を含む相対パスが生成され、サーバー側のディレクトリ構造に関する情報が漏洩する可能性がある。

設計書D2-004で既にUIでの使用制限が明記されているため、実装時にAPIレスポンスにfilePathが露出しないことを確認すれば十分。

---

### D4-003 [Nice to Have] readdirSyncのエラーハンドリングが未記載

**カテゴリ**: セキュリティ（堅牢性）

`loadCodexSkills()`の`fs.readdirSync()`が権限エラー等で例外を投げた場合のハンドリングが設計書のコード例に含まれていない。APIルート側のcatch句で捕捉されるため実害はないが、try-catchを追加してlogger.errorで記録し空配列を返すパターンが望ましい。

---

## 既存セキュリティ基盤との比較

| セキュリティ対策 | path-validator.ts | loadSkills() (既存) | loadCodexSkills() (設計) |
|--------------|------------------|--------------------|-----------------------|
| `..`パス拒否 | `isPathSafe()` | `entry.name.includes('..')` | `entry.name.includes('..')` |
| URLデコード対策 | `decodeURIComponent()` | 不要(readdirSync) | 不要(readdirSync) |
| NULLバイト検出 | `\x00`チェック | なし | なし |
| symlink解決 | `realpathSync()` | `path.resolve()`のみ | `path.resolve()`のみ |
| ファイルサイズ制限 | - | 64KB | 64KB |
| 件数制限 | - | 100 | 100 |
| JSエンジン無効化 | - | `safeParseFrontmatter()` | `safeParseFrontmatter()` |

`loadCodexSkills()`は`loadSkills()`と完全に同一のセキュリティレベルを維持している。`path-validator.ts`が持つ`realpathSync()`ベースのsymlink防御は未採用だが、これは既存設計との一貫性を優先した妥当な判断である。

---

## 結論

Issue #166の設計書はセキュリティ観点から承認可能である。Must Fixの指摘はなく、唯一のShould Fix（D4-001）は既存コードに共通する課題であり、別Issueとしての改善を推奨する。
