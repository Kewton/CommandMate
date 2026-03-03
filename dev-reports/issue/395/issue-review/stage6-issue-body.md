## Summary

The `/proxy/*` feature serves externally configured local applications under the same origin as CommandMate. This causes a major origin-boundary collapse:

- Upstream HTML/JavaScript from the external app executes under the CommandMate origin
- That JavaScript can call CommandMate APIs (`/api/*`) with same-origin privileges
- Request credentials such as cookies and authorization headers are forwarded to the upstream app
- Upstream `Set-Cookie` headers are returned to the browser and can set cookies for the CommandMate origin

As a result, any proxied app effectively gains the ability to act as the CommandMate web app.

## Severity

Critical

## Affected Surface

- `/proxy/[...path]`
- External app registration and proxying
- Worktree external apps (Issue #136) also use the same proxy path and will automatically receive the fixes applied in this Issue

## Root Cause

1. `handleProxy()` resolves an external app by `pathPrefix` and forwards the request.
2. `proxyHttp()` forwards nearly all request headers except a small hop-by-hop allowlist.
3. This includes sensitive headers such as:
   - `Cookie`
   - `Authorization`
   - `X-Forwarded-For`
   - `X-Forwarded-Host`
   - `X-Forwarded-Proto`
   - `X-Real-IP`
4. `proxyHttp()` also returns nearly all upstream response headers to the browser except a small hop-by-hop denylist.
5. This includes `Set-Cookie`.
6. The proxy forwards full upstream HTML/JS/CSS content under the same origin path `/proxy/...`.

The browser therefore treats the proxied application as part of the CommandMate site.

**Note on X-Forwarded-\* headers:** These headers are not in `HOP_BY_HOP_REQUEST_HEADERS` and are therefore forwarded to upstream apps. If the upstream app trusts these headers, it enables host header injection and IP spoofing attacks.

## Impact

### Existing Security Controls and Their Limitations

The following controls exist but do **not** fully mitigate the vulnerability:

- **CSP (`next.config.js`):** `Content-Security-Policy` is configured with `default-src 'self'` which restricts external resource loading. However, `script-src` includes `'unsafe-inline' 'unsafe-eval'`, so **inline script execution is possible**. External script loading is restricted to `self`, but a proxied app can embed inline scripts directly. Additionally, `connect-src 'self' ws: wss:` restricts direct data exfiltration to external domains, but the proxied app can send data back to its own backend via `self`-scoped requests (since `/proxy/*` is same-origin).
- **Authentication middleware (`middleware.ts`):** When `CM_AUTH_TOKEN_HASH` is configured, `/proxy/*` is not in `AUTH_EXCLUDED_PATHS`, so unauthenticated users cannot access proxy routes. However, this does not mitigate the threat from authenticated users or compromised sessions.
- **Critical unknown:** It is unclear whether `next.config.js` `headers()` (CSP, X-Frame-Options, etc.) are applied to responses from Route Handlers that return `new Response()` directly (as `proxyHttp()` does). If these headers are **not** applied, proxied content has no CSP or X-Frame-Options protection, significantly increasing the severity. See Validation Notes item 6.

### 1. Same-origin privilege escalation

Any proxied external app can run JavaScript that calls:

- `/api/worktrees/...`
- `/api/repositories/...`
- `/api/external-apps/...`

with same-origin privileges.

This means a buggy, compromised, or malicious proxied app can:
- read worktree data
- trigger clone operations
- modify files
- call terminal/CLI endpoints
- exfiltrate API responses to its own backend

Under the current CSP (`script-src 'unsafe-inline' 'unsafe-eval'`), inline JavaScript in proxied HTML can invoke these APIs. While `connect-src 'self' ws: wss:` prevents direct outbound requests to external domains, data can be exfiltrated by sending it back to the proxied app's backend (which is accessed via the same-origin `/proxy/*` path).

### 2. Credential disclosure to upstream apps

User cookies and authorization headers are forwarded to the upstream local app.

This allows the proxied app to receive:
- authentication cookies for CommandMate
- bearer tokens if present
- any other non-hop-by-hop credentials attached by the browser

Even though `HttpOnly` cookies cannot be read by frontend JS directly, they are still automatically attached by the browser to same-origin requests and the proxy forwards them server-side.

### 3. Cookie injection into the primary origin

Because upstream response headers are largely passed through, a proxied app can return:

```http
Set-Cookie: cm_auth_token=attacker-value; Path=/; HttpOnly
```

or other cookies scoped to the CommandMate origin. This allows:
- cookie shadowing
- session confusion
- unexpected auth state changes
- poisoning of app behavior dependent on cookies

### 4. CSRF-like API abuse without cross-origin protections

This is stronger than normal CSRF because the proxied page is same-origin, so standard browser same-origin restrictions do not protect CommandMate at all.

## Preconditions

- An external app is registered
- The app is reachable
- The user visits `/proxy/{pathPrefix}/...`
- When `CM_AUTH_TOKEN_HASH` is configured, the user must be authenticated to access `/proxy/*` paths (middleware enforces this). This means in auth-enabled environments, the attacker must be an authenticated user or must have compromised an authenticated session.

This may occur intentionally by a user, or indirectly if the proxied app embeds redirects/navigation.

## Affected Code

### Files requiring modification

- `src/lib/proxy/handler.ts` -- Add SENSITIVE_REQUEST_HEADERS stripping logic to `proxyHttp()`, add SENSITIVE_RESPONSE_HEADERS (Set-Cookie, CSP-related) stripping from upstream responses, remove `directUrl` field and sanitize `message` field (remove internal URL information) from `proxyWebSocket()` 426 response (see S3-003)
- `src/lib/proxy/config.ts` -- Add `SENSITIVE_REQUEST_HEADERS` and `SENSITIVE_RESPONSE_HEADERS` constants (see Implementation Notes for design)
- `src/components/external-apps/ExternalAppForm.tsx` -- Add security warning banner to the registration/edit form (see Recommended Direction)

### Files requiring NO modification (scope clarification)

- `src/middleware.ts` -- **No changes required.** `/proxy/*` is not included in `AUTH_EXCLUDED_PATHS`, so proxy routes already require authentication when `CM_AUTH_TOKEN_HASH` is configured.
- `src/lib/external-apps/validation.ts` -- **No changes required in this Issue's scope.** The vulnerability is caused by header forwarding, not by input validation deficiencies. Future proxy configuration options (e.g., header forwarding policy, trust level settings) may extend this module, but that is out of scope.
- `src/app/api/external-apps/route.ts` -- Registration API itself is not the cause of the vulnerability. No code changes required.
- `src/app/proxy/[...path]/route.ts` -- Delegates to `handler.ts`; no direct changes needed.

### Test files

- `tests/unit/proxy/handler.test.ts` -- **Existing tests require modification.** The current "should forward request headers" test (L83-105) implicitly expects `Authorization` to be forwarded, which will conflict with the new stripping logic. Additionally, new tests must be added:
  - Verify `Cookie`, `Authorization`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` are stripped from forwarded requests
  - Verify safe headers (`Content-Type`, `Accept`, etc.) continue to be forwarded (regression test)
  - Verify `Set-Cookie` is stripped from upstream responses
  - Verify CSP-related headers (`Content-Security-Policy`, `X-Frame-Options`) are stripped from upstream responses to prevent overriding `next.config.js` settings

### Key source references

- `src/app/proxy/[...path]/route.ts:22`
- `src/app/proxy/[...path]/route.ts:83`
- `src/lib/proxy/handler.ts:61`
- `src/lib/proxy/handler.ts:75`
- `src/lib/proxy/handler.ts:86`
- `src/lib/proxy/handler.ts:143-166` (proxyWebSocket directUrl)
- `src/lib/proxy/handler.ts:155` (message field containing directWsUrl)
- `src/app/api/external-apps/route.ts:48`

## Why Existing Host Restrictions Are Not Sufficient

`targetHost` is restricted to `localhost` / `127.0.0.1`, but that only limits network destination. It does not protect the browser-side origin boundary.

A local app can still be:
- compromised
- started by an untrusted process
- serving developer content not intended to run with CommandMate privileges
- reflecting user input into script execution

Running it under the CommandMate origin is the core problem.

## Example Attack Scenario

1. User registers a local app on `localhost:4000`
2. User opens `/proxy/my-app/`
3. The proxied app returns JavaScript
4. Browser executes it as `https://commandmate-host/proxy/my-app/...`
5. JS calls:
   - `fetch('/api/worktrees/123/files/README.md')`
   - `fetch('/api/worktrees/123/terminal', { method: 'POST', ... })`
6. Requests succeed with the user's authenticated session
7. JS exfiltrates results to the attacker-controlled app backend on the local port

**Note:** Under the current CSP, inline scripts (step 3-5) can execute because `script-src` allows `'unsafe-inline'`. Data exfiltration (step 7) is possible via same-origin requests to `/proxy/my-app/exfil` which the proxy forwards to `localhost:4000/exfil`.

## Recommended Direction

- Do not serve untrusted upstream HTML/JS under the primary app origin
- Isolate external apps on a separate origin/subdomain/port
- Strip credential-bearing request headers (`Cookie`, `Authorization`, etc.) unless explicitly required
- Strip `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Real-IP` from forwarded requests (or set them explicitly to prevent upstream spoofing)
- Strip `Set-Cookie` from upstream responses
- Consider a strict allowlist of safe forwarded headers
- If same-origin proxying must remain, it should be treated as fully trusted code execution, with clear warnings and stronger access boundaries
- **iframe sandboxing (intermediate mitigation):** Render proxied content within a `sandbox` attribute-bearing `<iframe>` and restrict the iframe's ability to call `/api/*` via CSP `frame-src`. This is not a complete solution and must be combined with header stripping, but it provides a practical defense-in-depth layer while maintaining same-origin proxying.
- **Header constants in config.ts (S3-002):** Add `SENSITIVE_REQUEST_HEADERS` (`Cookie`, `Authorization`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`) and `SENSITIVE_RESPONSE_HEADERS` (`Set-Cookie`, `Content-Security-Policy`, `X-Frame-Options`) as constants in `src/lib/proxy/config.ts`, and reference them from `handler.ts` header forwarding loops. This follows the existing `HOP_BY_HOP_*` constants pattern for consistency and maintainability.
- **CSP header stripping from upstream responses (S3-007):** In `proxyHttp()`, explicitly strip `Content-Security-Policy` and `X-Frame-Options` from upstream response headers before constructing the proxy response. This ensures that `next.config.js` security headers are applied reliably, regardless of whether upstream apps attempt to override them. This addresses Validation Notes item 6 defensively.
- **Restrictive CSP header injection option (S3-010):** *Out of scope for this Issue.* Consider in a separate Issue: adding the ability for `proxyHttp()` to inject a restrictive CSP header on responses (e.g., `Content-Security-Policy: default-src 'self'; script-src 'none'`) to completely block script execution in proxied content. This provides a strong defense-in-depth layer alongside iframe sandboxing. However, since this may break legitimate external app functionality, it should be configurable on a per-app basis (e.g., a `restrictCsp` boolean on the external app registration).
- **UI security warning (S3-004):** Add a security warning banner to `ExternalAppForm.tsx` (the registration/edit form) stating: "Proxied apps run under the CommandMate origin and can access CommandMate APIs. Only register trusted applications." This makes the same-origin risk explicit to users at registration time.
- **proxyWebSocket() directUrl and message sanitization (S3-003):** Remove the `directUrl` field from the `proxyWebSocket()` 426 rejection response to prevent leaking internal network information (`ws://{host}:{port}{path}`). Additionally, sanitize the `message` field to remove the interpolated `directWsUrl` value (L155: `Configure your WebSocket client to connect directly to ${directWsUrl}`). Replace with a generic message such as `"WebSocket connections are not supported through the proxy Route Handler"`. This ensures no internal URL information is leaked in any field of the response body.

## Implementation Notes

### config.ts design (S3-002)

The sensitive header constants should be added to `src/lib/proxy/config.ts` alongside the existing `HOP_BY_HOP_REQUEST_HEADERS` and `HOP_BY_HOP_RESPONSE_HEADERS`:

```typescript
export const SENSITIVE_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

export const SENSITIVE_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'content-security-policy',
  'x-frame-options',
]);
```

In `handler.ts`, the header forwarding loop should check both `HOP_BY_HOP_*` and `SENSITIVE_*` sets.

### Test modification plan (S3-001)

Existing test `tests/unit/proxy/handler.test.ts` "should forward request headers" (L83-105) must be updated to reflect the new stripping behavior. Specifically:

1. **Modify existing forwarding test:** Remove expectation that `Authorization` is forwarded; add assertion that it is stripped
2. **Add request header stripping tests:** Verify `Cookie`, `Authorization`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` are not present in the upstream request
3. **Add safe header regression tests:** Verify `Content-Type`, `Accept`, `User-Agent`, etc. are still forwarded
4. **Add response header stripping tests:** Verify `Set-Cookie`, `Content-Security-Policy`, `X-Frame-Options` are stripped from the proxy response
5. **Add directUrl and message removal test:** Verify `proxyWebSocket()` 426 response does not contain `directUrl` field and does not contain internal URL information in the `message` field

## Validation Notes

Dynamic verification should confirm:
1. `Cookie` is forwarded to upstream
2. Upstream can emit `Set-Cookie` and browser accepts it
3. Upstream JS can successfully invoke CommandMate `/api/*` endpoints from `/proxy/*`
4. `Set-Cookie: cm_auth_token=xxx; Path=/; HttpOnly` from upstream can overwrite the existing authentication cookie
5. Under the current CSP (`script-src 'unsafe-inline'`), inline JavaScript in proxied HTML can execute and call `/api/*`
6. Whether `next.config.js` security headers (CSP, X-Frame-Options, etc.) are applied to proxy route responses (Route Handlers returning `new Response()` directly). **If not applied, the severity increases significantly** as proxied content would have no CSP protection, and `proxyHttp()` must explicitly set security headers.
7. `proxyWebSocket()` 426 rejection response includes `directUrl` containing internal network information (`ws://{host}:{port}{path}`); verify whether this leaks sensitive infrastructure details

## Acceptance Criteria

- [ ] `SENSITIVE_REQUEST_HEADERS` and `SENSITIVE_RESPONSE_HEADERS` constants added to `src/lib/proxy/config.ts`
- [ ] `proxyHttp()` strips sensitive request headers (`Cookie`, `Authorization`, `X-Forwarded-*`, `X-Real-IP`) before forwarding to upstream
- [ ] `proxyHttp()` strips sensitive response headers (`Set-Cookie`, `Content-Security-Policy`, `X-Frame-Options`) from upstream responses
- [ ] `proxyWebSocket()` 426 response no longer includes `directUrl` field and `message` field does not contain internal URL information
- [ ] `ExternalAppForm.tsx` displays a security warning banner about same-origin risks
- [ ] Existing tests in `tests/unit/proxy/handler.test.ts` updated to reflect new stripping behavior
- [ ] New tests added for request header stripping, response header stripping, safe header forwarding, and directUrl/message removal verification
- [ ] CLAUDE.md `handler.ts` and `config.ts` module descriptions updated with Issue #395 security hardening details

---

*Review history: Stage 1 review applied on 2026-03-03 (S1-001, S1-002, S1-003, S1-004, S1-007, S1-009). Stage 3 impact review applied on 2026-03-03 (S3-001, S3-002, S3-003, S3-004, S3-005, S3-006, S3-007, S3-008, S3-010). Stage 5 review applied on 2026-03-03 (S5-001, S5-002, S5-005, S5-008).*