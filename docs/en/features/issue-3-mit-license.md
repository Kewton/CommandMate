[日本語版](../../features/issue-3-mit-license.md)

# Issue #3: Applying the MIT License

## Overview
Publish CommandMate as an open-source project under the MIT License.

## Purpose
- Clarify the usage terms for the project
- Encourage contributions to the open-source community
- Provide legal protection

## Work Items

### Phase 1: Creating the License File

#### 1.1 Creating the LICENSE File
- **File**: `LICENSE`
- **Content**: Standard MIT License text
- **Required Information**:
  - Copyright year: 2025
  - Copyright holder: Kewton (or the actual copyright holder name)

**Template**:
```
MIT License

Copyright (c) 2025 [Copyright Holder]

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

### Phase 2: Updating package.json

#### 2.1 Adding the license Field
- **File**: `package.json`
- **Addition**:
  ```json
  {
    "license": "MIT"
  }
  ```

#### 2.2 Verifying/Adding the repository Field
- Verify GitHub repository information is correctly set
- Add the following if needed:
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

### Phase 3: Updating README.md

#### 3.1 Adding the License Section
- **File**: `README.md`
- **Position**: End of file
- **Content**:
  ```markdown
  ## License

  This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
  ```

#### 3.2 Other README Improvements (Optional)
- Project description
- Installation instructions
- Usage guide
- Contributing guidelines
- Acknowledgments

### Phase 4: Additional Documentation (Optional)

#### 4.1 Creating CONTRIBUTING.md
- Contribution guidelines
- Coding conventions
- Pull request process

#### 4.2 Creating CODE_OF_CONDUCT.md
- Community code of conduct
- Adopting the standard Contributor Covenant is recommended

### Phase 5: GitHub Repository Settings

#### 5.1 Verifying Repository Settings
- Repository visibility: Public
- Verify License badge display (automatically detected by GitHub)

#### 5.2 Updating the About Section
- Concise project description
- Adding topic tags
- Website link (if applicable)

### Phase 6: Source Code Headers (Optional)

#### 6.1 Deciding on License Headers
Usually unnecessary for MIT License, but consider in these cases:
- Corporate projects
- When explicit copyright notices are required

**Header Example**:
```typescript
/**
 * Copyright (c) 2025 [Copyright Holder]
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
```

**Target Files**:
- src/**/*.ts
- src/**/*.tsx
- Major JavaScript files

## Implementation Order

1. **Priority: High**
   - [ ] Create LICENSE file
   - [ ] Add license field to package.json
   - [ ] Add License section to README.md

2. **Priority: Medium**
   - [ ] Verify/add repository info in package.json
   - [ ] Overall README improvement
   - [ ] GitHub repository About settings

3. **Priority: Low (Optional)**
   - [ ] Create CONTRIBUTING.md
   - [ ] Create CODE_OF_CONDUCT.md
   - [ ] Add source code headers

## Checklist

### Pre-Implementation Verification
- [ ] Confirm copyright holder name (personal or organization)
- [ ] Verify license compatibility of existing dependencies
- [ ] Obtain agreement from all project members (if applicable)

### During Implementation
- [ ] Create LICENSE file
- [ ] Update package.json
- [ ] Update README.md
- [ ] Commit and push

### Post-Implementation Verification
- [ ] Verify License badge appears on GitHub
- [ ] Verify package.json license field displays correctly on npm
- [ ] Verify README.md rendering

## Notes

### License Selection Rationale
- **MIT License Characteristics**:
  - Very permissive license
  - Commercial use allowed
  - Modification and redistribution allowed
  - Only requires preserving copyright notice
  - No warranty (AS IS)

### Dependency License Verification
Major dependency licenses:
- Next.js: MIT
- React: MIT
- TypeScript: Apache-2.0
- Tailwind CSS: MIT
- better-sqlite3: MIT

**Conclusion**: All major dependencies use MIT or compatible licenses, so there are no issues.

### Existing Code Copyright
- Code portions generated by Claude Code are subject to the terms at the time of generation
- Portions created by the user naturally hold copyright
- In case of collaborative development, co-authors can be explicitly listed

## Implementation Example

### LICENSE File
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

### package.json Diff
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

### README.md Addition
```markdown
## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Next.js](https://nextjs.org/)
- UI components styled with [Tailwind CSS](https://tailwindcss.com/)
- Developed with assistance from [Claude Code](https://claude.com/claude-code)
```

## Recommended Commit Message

```
feat: add MIT License to project (Issue #3)

- Add LICENSE file with MIT License text
- Update package.json with license field and repository info
- Add License section to README.md
- Ensure all dependencies are MIT-compatible

This makes CommandMate officially an open-source project
under the permissive MIT License, allowing free use, modification,
and distribution while maintaining copyright notices.

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Timeline

### Recommended Implementation Time
- Phase 1-3 (Required items): 30 minutes
- Phase 4-6 (Optional items): 1-2 hours

### Immediately Implementable
All required items can be implemented immediately. No dependencies or technical barriers.
