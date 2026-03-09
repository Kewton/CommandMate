# Issue #457 設計方針書 Stage 3 影響分析レビュー

| 項目 | 内容 |
|------|------|
| Issue | #457 |
| レビューステージ | Stage 3（影響分析レビュー） |
| レビュー日 | 2026-03-09 |
| 対象文書 | dev-reports/design/issue-457-readme-repositioning-design-policy.md |

---

## レビューサマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 0 |
| should_fix | 3 |
| nice_to_have | 5 |

**総合評価**: 設計方針書の変更内容はCI/CDやビルドプロセスに影響を与えず、プロジェクト内部のリンク破損リスクも低い。should_fixが3件あるが、いずれも致命的ではなく設計方針書への注記追加で対応可能。既存ユーザーへの影響はBeta段階のプロジェクトとして許容範囲内。

---

## 指摘事項

### F1 [should_fix] アンカーリンク互換性（互換性）

**概要**: Issue-Driven Developmentセクションが「Optional Workflow Layer」にリネーム・移動されると、GitHubが自動生成するアンカー `#issue-driven-development` が消失する。

**分析結果**: Grepによるプロジェクト全体の調査では、`#issue-driven-development` へのリンクはプロジェクト内に存在しないことを確認した。ただし、外部サイト（ブログ記事、Stack Overflow回答、社内Wiki等）からの参照が存在する可能性は排除できない。

**提案**: Optional Workflow Layerセクションに旧セクション名を保持するHTMLアンカー（`<a id="issue-driven-development"></a>`）の設置を検討するか、Beta段階のリスクとして許容するか、設計方針書に方針を記載する。

**該当箇所**: 設計方針書セクション2-1、README.md L42-63

---

### F2 [should_fix] package.json keywordsの意図しない削除（SEO影響）

**概要**: 設計方針書セクション2-3のkeywords変更で、`issue-driven-development` の削除に加えて `ai-coding` と `coding-agent` も変更後リストから除外されている。この2つのキーワードの削除は設計方針書内で明示的に言及されておらず、意図的な削除なのか見落としなのかが不明。

**分析結果**:
- 変更前: `claude-code`, `codex-cli`, `issue-driven-development`, **`ai-coding`**, `git-worktree`, **`coding-agent`**, `session-manager`, `tmux`, `cli`, `developer-tools`
- 変更後: `claude-code`, `codex-cli`, `gemini-cli`, `agent-cli`, `git-worktree`, `cli-orchestration`, `session-manager`, `tmux`, `cli`, `developer-tools`
- `ai-coding` は新ポジショニング（エージェントCLIの制御）でも依然として関連性が高いキーワード
- `coding-agent` も同様に、agent CLIを管理するツールとして検索ユーザーが使用する可能性がある

**提案**: `ai-coding` と `coding-agent` の削除が意図的かどうかを設計方針書に明記する。残すことを推奨する。

**該当箇所**: 設計方針書セクション2-3

---

### F3 [should_fix] セクション移動後のリンクテキスト調整（互換性）

**概要**: README.md L63およびdocs/ja/README.md L63にある参照リンク（workflow-examples等へのリンク）は、Issue-Driven Developmentセクション内に配置されている。セクションがOptional Workflow Layerとして移動・リネームされた際、リンクの相対パスは壊れないが、リンクテキストの文脈が変わる。

**分析結果**: 英語版の「For details, see the issues, dev reports, and workflow examples」はIssue-Driven Development固有のコンテキストで書かれている。Optional Workflow Layerに移動後も内容的には成立するが、「オプショナル」という性質を反映した文言調整が望ましい。

**提案**: セクション移動に伴うリンクテキストの微調整を設計方針書に注記する。例：「These optional workflows are documented in ...」

**該当箇所**: 設計方針書セクション2-1、2-2

---

### F4 [nice_to_have] CLAUDE.mdとの整合性（ドキュメント波及）

**概要**: CLAUDE.mdのプロジェクト概要「Git worktree管理とClaude CLI/tmuxセッション統合ツール」は既にcontrol plane的な表現であり、新ポジショニングと整合する。

**分析結果**: 設計方針書セクション3で「変更不要」と判断されており、この判断は妥当。対応不要。

---

### F5 [nice_to_have] npm descriptionの中間状態リスク（ユーザー影響）

**概要**: npmパッケージページではpackage.jsonのdescriptionがパッケージ名の直下に表示される。descriptionとREADMEが異なるタイミングで更新されると不整合が生じる。

**分析結果**: 設計方針書セクション8の実装順序では、README変更（ステップ1-2）の後にpackage.json変更（ステップ3）が行われる。npm publishは全変更コミット後に行われるため、中間状態リスクは低い。対応不要。

---

### F6 [nice_to_have] CI/CDへの影響確認（CI/CD影響）

**概要**: 変更対象ファイル（README.md、docs/ja/README.md、package.json、src/app/page.tsx、CHANGELOG.md）がビルド・テスト・リントに影響しないか確認。

**分析結果**:
- `README.md`, `docs/ja/README.md`, `CHANGELOG.md`: ビルド対象外
- `package.json`: description/keywordsフィールドはビルド・テスト・リントに未使用
- `src/app/page.tsx`: JSX内テキスト変更のみ、レイアウト・ロジック変更なし

CI/CDへの影響はない。対応不要。

---

### F7 [nice_to_have] docs/en/concept.mdとの将来的な乖離（ドキュメント波及）

**概要**: concept.mdはプロダクトのビジョンを記述するドキュメント。本Issue #457のスコープ外として除外されているが、将来的にトーンが新ポジショニングと乖離する可能性がある。

**提案**: 設計方針書セクション3の「変更しないもの」にdocs/en/concept.mdを追加し、将来タスクとしての認識を明示する。

---

### F8 [nice_to_have] CHANGELOG経緯追跡（その他）

**概要**: CHANGELOG.md L76にIssue #433のリポジショニング記録「README repositioned around issue-driven AI development messaging」が存在する。Issue #457は逆方向の変更だが、設計方針書セクション2-6のCHANGELOGテンプレートで#457への参照があり、経緯追跡は十分可能。対応不要。

---

## 影響範囲マトリクス

### 直接的な影響

| ファイル/リソース | 影響内容 | リスク | 設計方針書での対応状況 |
|------------------|---------|--------|---------------------|
| README.md | セクション移動、コピー変更 | 低 | セクション2-1で詳細記載 |
| docs/ja/README.md | セクション移動、コピー変更 | 低 | セクション2-2で詳細記載 |
| package.json | description/keywords変更 | 低 | セクション2-3で記載（keywords要確認） |
| src/app/page.tsx | テキスト変更のみ | 低 | セクション2-4で記載 |
| CHANGELOG.md | エントリ追加 | 低 | セクション2-6で記載 |
| GitHub About | 手動更新 | 中 | セクション2-7で記載 |

### 間接的な影響（スコープ外だが認識が必要）

| ファイル/リソース | 影響内容 | 対応方針 |
|------------------|---------|---------|
| docs/en/concept.md | トーンの将来的な乖離 | 将来タスク |
| docs/user-guide/quick-start.md | issue-driven前提の構成 | 将来タスク（設計方針書で認識済み） |
| docs/user-guide/workflow-examples.md | issue-driven前提の構成 | 将来タスク |
| npm検索結果 | keywords変更による発見性の変化 | F2で指摘 |
| 外部リンク | #issue-driven-developmentアンカー消失 | F1で指摘 |

---

## 結論

本設計方針書は影響範囲の特定と管理において概ね適切に設計されている。must_fixの指摘はなく、3件のshould_fixはいずれも設計方針書への注記追加で対応可能な軽微なものである。特にpackage.json keywordsの`ai-coding`/`coding-agent`削除の意図確認（F2）は、npm検索でのディスカバリに影響するため優先的に確認すべきである。
