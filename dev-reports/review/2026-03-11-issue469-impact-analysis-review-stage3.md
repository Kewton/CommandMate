# Issue #469 設計方針書 Stage 3 影響分析レビュー

| 項目 | 値 |
|------|-----|
| Issue | #469 |
| Stage | 3 - 影響分析レビュー |
| 対象 | dev-reports/design/issue-469-file-auto-update-design-policy.md |
| レビュー日 | 2026-03-11 |
| レビュー観点 | 影響範囲（既存機能への波及効果、レンダリング、テスト影響） |

---

## サマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 2 |
| should_fix | 4 |
| nice_to_have | 2 |
| **総合評価** | **good** |

設計方針書は全体として影響範囲を十分に考慮しており、主要な波及経路（isDirtyフラグ、304応答、ポーリングライフサイクル）が網羅されている。ただし、MARPファイル編集時のonDirtyChange未伝搬という見落としと、memo化コンポーネントへの再レンダリング影響の分析不足が確認された。

---

## 指摘事項

### F1 [must_fix] MarpEditorWithSlidesでのonDirtyChange未伝搬によるisDirty不整合

**影響範囲**: FilePanelContent.tsx

**詳細**: FilePanelContent.tsx内のMarkdownWithSearchコンポーネントにはonDirtyChangeの伝搬が設計されているが、MarpEditorWithSlides（行319-383）も内部でMarkdownEditorを使用している（行373-378）。MarpEditorWithSlidesにはonDirtyChangeの伝搬が設計方針書に記載されていない。MARPファイルをエディタモードで編集した場合、isDirtyがtrueに設定されず、ポーリングによる上書きが発生するリスクがある。

**改善提案**: MarpEditorWithSlidesコンポーネントにもonDirtyChangeプロパティを追加し、MarkdownEditorへ中継する設計を追記する。設計方針書セクション4-5にMarpEditorWithSlidesのケースを明記すること。

**対象セクション**: 4-5. MarkdownEditor onDirtyChange 実装パターン

---

### F2 [must_fix] FilePanelContentのmemo化がポーリングによるtab.isDirty変更で無効化される影響

**影響範囲**: FilePanelContent.tsx, useFileTabs.ts

**詳細**: FilePanelContentはmemo化されており（行617）、tab propの浅い比較で再レンダリングが判定される。isDirtyフィールドの追加により、FileTab型のオブジェクト参照はSET_DIRTYディスパッチのたびに新しいオブジェクトになる。MarkdownEditorのisDirty状態が変化するたびにtab propが変わり、FilePanelContent全体が再レンダリングされる。特にCodeViewerのhljs.highlightはuseMemoで保護されているが、MarpPreviewのiframe srcDocやMarkdownEditorのReactMarkdownなど重いコンポーネントへの波及を確認する必要がある。

**改善提案**: FilePanelContentのmemo比較関数でisDirtyを除外する、またはisDirtyをtab propの外に分離してFilePanelContentPropsに独立propとして追加することを検討する。問題がなければ設計方針書に「memo再レンダリングの影響は限定的」と根拠を明記すること。

**対象セクション**: 4-4. isDirtyフラグの管理（useFileTabs拡張）

---

### F3 [should_fix] 304応答がFilePanelContentの既存auto-fetchエラーハンドリングに与える影響

**影響範囲**: FilePanelContent.tsx, files/[...path]/route.ts

**詳細**: FilePanelContent.tsxの既存auto-fetch（行646-678）では、response.okがfalseの場合にresponse.json()を呼んでerrorDataを取得する。useFileContentPollingでは304応答を正しくハンドリングするが、仮にauto-fetchの初回ロード時にIf-Modified-Sinceヘッダが誤って付与されるシナリオでは、304応答（response.okはfalse）のボディが空のためresponse.json()がJSONパースエラーをスローする可能性がある。

**改善提案**: useFileContentPollingのlastModifiedRefの初期値がnullであり初回リクエストにはIf-Modified-Sinceが付与されない設計であることを設計方針書に明記する。防衛的プログラミングとして、既存auto-fetchの応答処理にstatus === 304の早期リターンを追加することを推奨する。

**対象セクション**: 4-6. サーバー側304応答（files API）

---

### F4 [should_fix] WorktreeDetailRefactoredへのポーリング追加がuseMemo依存配列に与える影響

**影響範囲**: WorktreeDetailRefactored.tsx

**詳細**: WorktreeDetailRefactored.tsxの左ペインレンダリング（行2237付近）はuseMemoでメモ化されており、依存配列にfileTreeRefreshが含まれている。ツリーポーリングによるsetFileTreeRefreshの発火は、このuseMemoの再計算をトリガーする。ポーリング間隔が5秒のため、12回/分の再生成が発生する。

**改善提案**: FileTreeViewはleftPaneTab === 'files'時のみレンダリングされ、NotesAndLogsPaneはleftPaneTab === 'memo'時のため同時レンダリングはない。この点をパフォーマンス設計（セクション8）に明記し、ポーリングが非Filesタブ時にはenabled=falseで停止されることをフロー図に追加する。SearchBarコンポーネントのmemo化有効性も確認すること。

**対象セクション**: 8. パフォーマンス設計

---

### F5 [should_fix] タブ切替時のlastModifiedRefリセットによるフル転送発生

**影響範囲**: FilePanelTabs.tsx, useFileContentPolling.ts（新規）

**詳細**: useFileContentPollingがFilePanelContentのライフサイクル単位で動作するため、タブ切替時にFilePanelContentがkey={activeTab.path}でマウント/アンマウントされ（FilePanelTabs.tsx行139）、lastModifiedRefがリセットされる。タブ切替後の最初のポーリングでは必ず200応答（フルボディ転送）が発生する。

**改善提案**: 5タブ各5秒間隔での切替でも影響は軽微のため現行設計で許容可能。将来lastModifiedをFileTab型に保持してタブ間で共有する拡張性をセクション12に記載することを推奨する。

**対象セクション**: 4-3. ファイル内容ポーリング

---

### F6 [should_fix] onDirtyChangeの動作を検証する新規テストが未計画

**影響範囲**: MarkdownEditor.tsx, markdown-editor.ts, MarkdownEditor.test.tsx

**詳細**: EditorProps型にonDirtyChange?を追加する設計だが、既存テスト（MarkdownEditor.test.tsx）はオプショナルプロパティのため影響を受けない。しかし、onDirtyChangeコールバックの発火タイミング（編集時にtrue、保存後にfalse）を検証する新規テストが設計方針書のテスト設計（セクション9）に含まれていない。

**改善提案**: セクション9のユニットテスト一覧に「MarkdownEditor onDirtyChangeコールバック検証」テストを追加する。テスト内容: (1) onDirtyChangeが編集時にtrueで呼ばれること、(2) 保存後にfalseで呼ばれること、(3) onDirtyChange未指定時にエラーが発生しないこと。

**対象セクション**: 9. テスト設計

---

### F7 [nice_to_have] ツリーポーリングのJSON.stringify比較がサブディレクトリ内変更を検知しない可能性

**影響範囲**: WorktreeDetailRefactored.tsx

**詳細**: ツリーポーリングはルートディレクトリのみ取得してJSON.stringifyで比較する設計。CLIツールがサブディレクトリ内にファイルを作成した場合、ルートレスポンスのitemsが変化しない可能性がある（tree APIの応答形式に依存）。

**改善提案**: tree APIのレスポンス構造（フラットリストか、ルート直下のみか）を設計方針書に前提条件として明記する。ルート直下のみの場合、差分検知の限界を記載する。

**対象セクション**: 4-2. ツリーポーリング（WorktreeDetailRefactored管理）

---

### F8 [nice_to_have] FilePanelTabsのTabButtonにおけるisDirty変更の再レンダリング範囲

**影響範囲**: FilePanelTabs.tsx, useFileTabs.ts

**詳細**: TabButtonはmemo化されておりtab propの参照変化で再レンダリングされる。SET_DIRTYアクションのreducer実装で対象タブのみ新オブジェクトを生成し他タブの参照は維持する設計であれば、memo化されたTabButtonは対象タブのみ再レンダリングされる。

**改善提案**: SET_DIRTYアクションのreducer実装（セクション4-4のコード例のtab.path === action.path条件分岐）が他タブの参照を維持することを設計根拠として明記する。

**対象セクション**: 4-4. isDirtyフラグの管理（useFileTabs拡張）

---

## 実装チェックリスト（Stage 3指摘対応）

- [ ] **F1**: MarpEditorWithSlidesにonDirtyChange propを追加し、MarkdownEditorへ中継する設計をセクション4-5に追記
- [ ] **F2**: FilePanelContentのmemo再レンダリング影響を分析し、設計方針書に結論と根拠を明記
- [ ] **F3**: useFileContentPollingのlastModifiedRef初期値=nullの前提をセクション4-3に明記
- [ ] **F3**: 既存auto-fetchでの304応答ハンドリングの防衛策を記載
- [ ] **F4**: パフォーマンス設計セクションにleftPaneTabの条件分岐とポーリングenabled制御の関係を追記
- [ ] **F5**: 将来の拡張性セクションにlastModifiedのタブ間共有の可能性を記載
- [ ] **F6**: テスト設計セクションにMarkdownEditor onDirtyChangeテストを追加

---

*Generated by architecture-review-agent (Stage 3: 影響分析レビュー)*
*Date: 2026-03-11*
