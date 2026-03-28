# Issue #565 設計方針書 整合性レビュー (Stage 2)

**日付**: 2026-03-28
**対象**: `dev-reports/design/issue-565-copilot-tui-design-policy.md`
**レビュー種別**: 整合性レビュー（設計方針書 vs 実装コード / 内部整合性 / Issue整合性）

---

## レビューサマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 2 |
| should_fix | 5 |
| nice_to_have | 3 |
| **合計** | **10** |

---

## must_fix (2件)

### DR2-003: accumulateTuiContent呼び出し時にOpenCode用extractTuiContentLinesが常に使用される問題が設計に未記載

**カテゴリ**: コード整合性

現在の`accumulateTuiContent`（`tui-accumulator.ts` L150-178）は内部で`extractTuiContentLines()`をハードコードで呼び出している。`response-poller.ts` L605-608ではCopilotに対しても`accumulateTuiContent()`を呼んでいるが、これはOpenCode用の`normalizeOpenCodeLine()`と`OPENCODE_SKIP_PATTERNS`を使ってコンテンツ抽出を行う。CopilotのTUI出力がOpenCodeのパターンで処理されており、正しくコンテンツ抽出できていない。

設計方針書セクション4.1.3でシグネチャ拡張を提案しているが、現状の誤動作を明示的に記載していない。実装者がこの前提を理解せずに着手する可能性がある。

**改善提案**: セクション4.1.3の「Before/After」の直前に、現在の問題状態を明記する。

**影響セクション**: 4.1.3 accumulateTuiContent シグネチャ拡張

---

### DR2-010: 蓄積コンテンツがレスポンス保存時に使用されるフローが設計方針書に未記載

**カテゴリ**: Issue整合性

Issueの事象1（レスポンス本文が保存されない）の解決には、TuiAccumulatorで蓄積したコンテンツがレスポンス保存時に使用される必要がある。設計方針書のデータフロー図やcheckForResponse()の設計変更には、蓄積コンテンツ（`getAccumulatedContent()`）をレスポンス本文として使用するフローが記載されていない。

現在のcheckForResponse() L704-710を見ると、copilotの場合`cleanCopilotResponse(result.response)`で処理しているが、`result.response`はextractResponse()の戻り値であり、tmuxの現在表示行から抽出したもの。蓄積されたTUI全体コンテンツはどこでresult.responseに代入されるのか、そのフローが設計に明記されていない。

事象1の根本解決にはこの統合フローが不可欠であり、設計の最重要欠落箇所である。

**改善提案**: セクション2.2のデータフローまたは新規セクションに、Copilotの場合`result.response`を`getAccumulatedContent(pollerKey)`で置換するフロー、あるいはextractResponse()内でTuiAccumulator蓄積コンテンツを使用する方式の設計判断を記載する。

**影響セクション**: 2.2 データフロー, 4.1 全体

---

## should_fix (5件)

### DR2-001: extractResponse L518のCopilotスキップ条件が未設計

**カテゴリ**: コード整合性

extractResponse() L518の一般プロンプト検出（`if (cliToolId !== 'opencode')`）でCopilotが除外されていない。Issue本文では「extractResponse L518のcopilotスキップ条件検討」と言及されているが、設計方針書にはこの判断結果が反映されていない。CopilotはL344の早期プロンプト検出でカバーされているため、L518でopencode同様にスキップする方が一貫性がある可能性がある。

**改善提案**: 設計方針書にL518の設計判断を追記する。

**影響セクション**: 4.5 isFullScreenTui分岐の整理

---

### DR2-002: COPILOT_SKIP_PATTERNSの3箇所適用の関係が未整理

**カテゴリ**: コード整合性

方針(B)（後段フィルタリング）を採用するとしているが、extractResponse内のskipPatternsフィルタリング（L414-418）がgetCliToolPatterns()から取得されるCOPILOT_SKIP_PATTERNSも使用する。DR1-003の「二重適用」の設計判断は蓄積時と保存時の2箇所のみだが、実際にはextractResponseループ内の適用を含めると3箇所になる。

**改善提案**: extractCopilotContentLines、extractResponseループ内skipPatterns、cleanCopilotResponseの3箇所の適用関係を整理し、セクション4.1.4に追記する。

**影響セクション**: 4.1.4 cleanCopilotResponse 本実装

---

### DR2-005: isFullScreenTui分岐の具体的なコード変更箇所が不明確

**カテゴリ**: Issue整合性

Issueの受け入れ条件に「isFullScreenTuiの共通フラグとCopilot固有ロジックの分岐が適切に設計されていること」が含まれている。設計方針書セクション4.5に対応表があるが、L642/L650/L684/L749の各分岐ポイントに対して具体的なコード差分が示されていない。

**改善提案**: セクション4.5の表にresponse-poller.ts内の具体的な行番号と変更内容を対応付ける。

**影響セクション**: 4.5 isFullScreenTui分岐の整理

---

### DR2-006: prompt-dedup.tsの呼び出し位置がcheckForResponse内のコードフローと不整合

**カテゴリ**: コード整合性

設計方針書セクション4.2.1のコード例では、checkForResponse()内のプロンプト保存直前にisDuplicatePromptを呼ぶとしている。しかし実際のコードフロー（L661-688）では、`promptDetection.isPrompt`判定後すぐに`createMessage()`でDB保存が実行される。設計例の擬似コードは`return false`で保存スキップとしているが、呼び出し位置がcreateMessage()の後では重複防止にならない。

**改善提案**: コード例を修正し、isDuplicatePrompt()の呼び出しがcreateMessage()（L665）の前に配置されることを明示する。

**影響セクション**: 4.2.1 content hashベース重複チェック

---

### DR2-008: Copilotレスポンス完了検出の設計判断が不足

**カテゴリ**: Issue整合性

Issue本文の「推奨4: Copilotレスポンス完了検出」では(A)現在のhasPrompt && !isThinkingで十分か、(B)isCopilotComplete独自関数が必要かの判断を求めている。設計方針書にはこの設計判断が明記されていない。現在CopilotはextractResponse L372のisCodexOrGeminiComplete条件に含まれている。

**改善提案**: 完了検出方式の設計判断セクションを追加し、TuiAccumulatorの蓄積コンテンツ利用可否に基づく判断結果を記載する。

**影響セクション**: 新規セクション追加推奨

---

## nice_to_have (3件)

### DR2-004: セクション3.1と4.1.3のaccumulateTuiContentシグネチャ不一致

**カテゴリ**: 内部整合性

セクション3.1では`cliToolId: CLIToolType = 'opencode'`（デフォルト値付き）、セクション4.1.3では`cliToolId?: CLIToolType`（オプショナル、デフォルトなし）と記載されており、シグネチャが矛盾する。

**改善提案**: どちらかに統一する。セクション8の記載（「デフォルト値がOpenCode固定」）からセクション3.1の方が最終設計と推定されるため、セクション4.1.3を合わせる。

**影響セクション**: 3.1 Strategy統合, 4.1.3 accumulateTuiContent シグネチャ拡張

---

### DR2-007: データフロー図のLayer番号が実行順序と逆

**カテゴリ**: 内部整合性

Layer 2（accumulateTuiContent）がLayer 1（extractResponse）より先に実行される記載だが、番号付けが直感に反する。OpenCode設計からの踏襲と思われるが、注記があると読み手に親切。

**影響セクション**: 2.2 データフロー

---

### DR2-009: データフロー図の引数名「key」と「pollerKey」の不統一

**カテゴリ**: 内部整合性

セクション2.2のデータフロー図のみ`key`、他のセクションおよび実際のコードでは`pollerKey`が使用されている。

**改善提案**: データフロー図の引数名を`pollerKey`に統一する。

**影響セクション**: 2.2 データフロー

---

## 検証した行番号の一致状況

設計方針書で参照されている行番号と実際のコードの照合結果:

| 参照 | 設計記載 | 実コード | 結果 |
|------|---------|---------|------|
| extractResponse定義 | L260 | L260 | 一致 |
| 早期プロンプト検出（copilot含む） | L344 | L344 | 一致 |
| レスポンス抽出ループ | L390-421 | L390-421 | 一致 |
| accumulateTuiContent呼び出し | L605-608 | L605-608 | 一致 |
| isFullScreenTui定義 | L637 | L637 | 一致 |
| line-based重複チェック | L642 | L642 | 一致 |
| line-based重複チェック | L650 | L650 | 一致 |
| プロンプト時ポーリング停止抑制 | L684 | L684 | 一致 |
| race condition防止 | L749 | L749 | 一致 |
| send/route.ts 200ms遅延 | L262 | L262 | 一致 |
| terminal/route.ts 200ms遅延 | L88 | L88 | 一致 |
| copilot.ts テキスト入力遅延 | L272 | L272 | 一致 |
| copilot.ts メッセージ処理遅延 | L278 | L278 | 一致 |
| 一般プロンプト検出（opencode除外） | L518 | L518 | 一致 |

全参照行番号が実コードと一致していることを確認した。

---

## 関数シグネチャの一致状況

| 関数 | 設計記載 | 実コード | 結果 |
|------|---------|---------|------|
| `accumulateTuiContent` | `(pollerKey: string, rawOutput: string): void` (Before) | `(pollerKey: string, rawOutput: string): void` | 一致 |
| `resolveExtractionStartIndex` | 5引数シグネチャ | 5引数シグネチャ | 一致 |
| `cleanCopilotResponse` | placeholder記載あり | placeholder実装確認 | 一致 |
| `extractTuiContentLines` | OpenCode専用として記載 | OpenCode専用実装 | 一致 |

---

*Generated by architecture-review-agent for Issue #565 Stage 2 consistency review*
*Date: 2026-03-28*
