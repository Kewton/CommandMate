# Security Identifiers

This document is the Single Source of Truth for security identifier mappings in CommandMate.

## Identifier Mapping Table

The following 9 identifiers were unified to the `[SEC-NNN]` format in Issue #574.

| Old Identifier | New Identifier | File | Description |
|---------------|---------------|------|-------------|
| `[SEC-SF-002]` | `[SEC-010]` | `src/lib/file-operations.ts` | Error response without absolute paths |
| `[SEC-SF-003]` | `[SEC-011]` | `src/lib/file-operations.ts` | Rename path validation |
| `[SEC-SF-004]` | `[SEC-012]` | `src/lib/file-operations.ts` | Recursive delete safety |
| `[MF-001]` | `[SEC-013]` | `src/lib/file-operations.ts` | Common validation helper for file operations |
| `[SF-S2-005]` | `[SEC-014]` | `src/lib/file-operations.ts` | Protected directory check (destination) |
| `[S4-001]` | `[SEC-015]` | `src/lib/security/ip-restriction.ts` | X-Forwarded-For trust warning |
| `[S4-002]` | `[SEC-016]` | `src/lib/security/ip-restriction.ts` | DoS prevention: CIDR entry count limit |
| `[S4-005]` | `[SEC-017]` | `src/lib/security/ip-restriction.ts` | Input validation: entry length limit |
| `[S4-006]` | `[SEC-018]` | `src/lib/security/ip-restriction.ts` | CM_TRUST_PROXY value validation |

## Existing SEC Numbers (unchanged)

These identifiers already follow the `[SEC-NNN]` format and were not modified:

| Identifier | File | Description |
|-----------|------|-------------|
| `[SEC-004]` | `src/lib/file-operations.ts` | Filename security validation |
| `[SEC-005]` | `src/lib/file-operations.ts` | Upload error messages without details |
| `[SEC-006]` | `src/lib/file-operations.ts` | Symlink validation for move destination |
| `[SEC-007]` | `src/lib/file-operations.ts` | MOVE_INTO_SELF check |
| `[SEC-008]` | `src/lib/file-operations.ts` | Final destination path validation |
| `[SEC-009]` | `src/lib/file-operations.ts` | Pre-check existence + TOCTOU defense |
| `[SEC-394]` | `src/lib/security/path-validator.ts` | Symlink traversal prevention |

## Security Identifier Criteria

When adding new identifiers, use the following rules to determine whether an identifier should use the `[SEC-NNN]` format.

### Use `[SEC-NNN]` for (security-related):

- Identifiers that directly describe defense, detection, or response to security threats (e.g., symlink attack rejection, input sanitization, unauthorized configuration warnings)
- Identifiers that mark defense points to be reviewed during security audits
- Identifiers within `src/lib/security/` modules that meet the above criteria

### Do NOT use `[SEC-NNN]` for (non-security):

- Design pattern or responsibility separation descriptions (e.g., Facade pattern, responsibility separation)
- Module cache, constant definitions, initialization processing, and other infrastructure/architecture descriptions
- Compatibility constraint descriptions with other modules
- Generic functionality in modules outside `src/lib/security/` (e.g., logger.ts)

## Number Assignment Rules

- New SEC numbers start from `[SEC-010]` to avoid collision with existing numbers
- Use 3-digit zero-padded format: `[SEC-NNN]`
- Assign numbers sequentially; do not reuse numbers from retired identifiers
