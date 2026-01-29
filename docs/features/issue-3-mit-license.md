# Issue #3: MITライセンスの適用

## 概要
CommandMateをMITライセンスの下でオープンソースプロジェクトとして公開する。

## 目的
- プロジェクトの利用条件を明確にする
- オープンソースコミュニティへの貢献を促進する
- 法的な保護を提供する

## 作業項目

### Phase 1: ライセンスファイルの作成

#### 1.1 LICENSEファイルの作成
- **ファイル**: `LICENSE`
- **内容**: 標準的なMITライセンステキスト
- **必要情報**:
  - Copyright year: 2025
  - Copyright holder: Kewton (または実際の著作権者名)

**テンプレート**:
```
MIT License

Copyright (c) 2025 [著作権者名]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Phase 2: package.jsonの更新

#### 2.1 licenseフィールドの追加
- **ファイル**: `package.json`
- **追加内容**:
  ```json
  {
    "license": "MIT"
  }
  ```

#### 2.2 repositoryフィールドの確認/追加
- GitHubリポジトリ情報が正しく設定されているか確認
- 必要に応じて以下を追加:
  ```json
  {
    "repository": {
      "type": "git",
      "url": "git+https://github.com/Kewton/CommandMate.git"
    },
    "bugs": {
      "url": "https://github.com/Kewton/CommandMate/issues"
    },
    "homepage": "https://github.com/Kewton/CommandMate#readme"
  }
  ```

### Phase 3: README.mdの更新

#### 3.1 Licenseセクションの追加
- **ファイル**: `README.md`
- **追加位置**: ファイルの末尾
- **内容**:
  ```markdown
  ## License

  This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
  ```

#### 3.2 その他のREADME改善（オプション）
- プロジェクト説明の追加
- インストール手順
- 使用方法
- 貢献ガイドライン
- 謝辞

### Phase 4: 追加ドキュメント（オプション）

#### 4.1 CONTRIBUTING.mdの作成
- 貢献方法のガイドライン
- コーディング規約
- プルリクエストのプロセス

#### 4.2 CODE_OF_CONDUCT.mdの作成
- コミュニティ行動規範
- 標準的なContributor Covenantを採用することを推奨

### Phase 5: GitHubリポジトリの設定

#### 5.1 リポジトリ設定の確認
- リポジトリの可視性: Public
- Licenseラベルの表示確認（GitHubが自動的に検出）

#### 5.2 Aboutセクションの更新
- 簡潔なプロジェクト説明
- トピックタグの追加
- Websiteリンク（該当する場合）

### Phase 6: ソースコードヘッダー（オプション）

#### 6.1 ライセンスヘッダーの追加判断
MITライセンスでは通常不要だが、以下の場合に検討:
- 企業プロジェクトの場合
- 明示的な著作権表示が必要な場合

**ヘッダー例**:
```typescript
/**
 * Copyright (c) 2025 [著作権者名]
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
```

**対象ファイル**:
- src/**/*.ts
- src/**/*.tsx
- 主要なJavaScriptファイル

## 実装順序

1. **優先度: 高**
   - [ ] LICENSEファイルの作成
   - [ ] package.jsonのlicenseフィールド追加
   - [ ] README.mdのLicenseセクション追加

2. **優先度: 中**
   - [ ] package.jsonのrepository情報確認/追加
   - [ ] README.mdの全体的な改善
   - [ ] GitHubリポジトリのAbout設定

3. **優先度: 低（オプション）**
   - [ ] CONTRIBUTING.mdの作成
   - [ ] CODE_OF_CONDUCT.mdの作成
   - [ ] ソースコードヘッダーの追加

## チェックリスト

### 実装前の確認
- [ ] 著作権者名の確認（個人名 or 組織名）
- [ ] 既存の依存ライブラリのライセンス互換性確認
- [ ] プロジェクトメンバー全員の合意取得（該当する場合）

### 実装中
- [ ] LICENSEファイル作成
- [ ] package.json更新
- [ ] README.md更新
- [ ] コミットとプッシュ

### 実装後の確認
- [ ] GitHubでLicenseバッジが表示されることを確認
- [ ] package.jsonのlicenseフィールドがnpmで正しく表示される
- [ ] README.mdのレンダリング確認

## 注意事項

### ライセンス選択の妥当性
- **MITライセンスの特徴**:
  - 非常に寛容なライセンス
  - 商用利用可能
  - 改変・再配布可能
  - 著作権表示の保持のみ要求
  - 保証なし（AS IS）

### 依存ライブラリの確認
主要な依存ライブラリのライセンス:
- Next.js: MIT
- React: MIT
- TypeScript: Apache-2.0
- Tailwind CSS: MIT
- better-sqlite3: MIT

**結論**: すべての主要依存ライブラリがMITまたは互換性のあるライセンスのため、問題なし。

### 既存コードの著作権
- Claude Codeで生成されたコード部分については、生成時の規約に従う
- ユーザーが作成した部分は当然著作権を持つ
- 共同開発の場合は共同著作権者として明記可能

## 実装例

### LICENSEファイル
```
MIT License

Copyright (c) 2025 Kewton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### package.json差分
```json
{
  "name": "mycodebranch-desk",
  "version": "0.1.0",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Kewton/CommandMate.git"
  },
  "bugs": {
    "url": "https://github.com/Kewton/CommandMate/issues"
  },
  "homepage": "https://github.com/Kewton/CommandMate#readme"
}
```

### README.md追加セクション
```markdown
## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Next.js](https://nextjs.org/)
- UI components styled with [Tailwind CSS](https://tailwindcss.com/)
- Developed with assistance from [Claude Code](https://claude.com/claude-code)
```

## 推奨コミットメッセージ

```
feat: add MIT License to project (Issue #3)

- Add LICENSE file with MIT License text
- Update package.json with license field and repository info
- Add License section to README.md
- Ensure all dependencies are MIT-compatible

This makes CommandMate officially an open-source project
under the permissive MIT License, allowing free use, modification,
and distribution while maintaining copyright notices.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

## タイムライン

### 推奨実装時間
- Phase 1-3（必須項目）: 30分
- Phase 4-6（オプション項目）: 1-2時間

### 即座に実装可能
すべての必須項目は即座に実装可能。依存関係や技術的な障壁なし。

## 質問事項（実装前に確認）

1. **著作権者名**: 「Kewton」で良いか？それとも本名？
2. **開始年**: 2025年で良いか？プロジェクト開始時期に合わせるか？
3. **オプション機能**: CONTRIBUTING.mdやCODE_OF_CONDUCT.mdも作成するか？
4. **README改善**: プロジェクト説明、インストール手順なども追加するか？

## 次のステップ

実装準備が完了したら:
1. 上記の質問事項を確認
2. Phase 1-3の必須項目を実装
3. テストとして一度コミット
4. GitHubでライセンス表示を確認
5. 必要に応じてPhase 4-6を実装
