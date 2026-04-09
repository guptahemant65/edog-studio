# Feature 10: Token Inspector

> **Phase:** V1.1
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS)
> **Spec:** docs/specs/features/F10-token-inspector.md
> **Design Ref:** docs/specs/design-spec-v2.md §10

### Problem

Token expiry causes cryptic failures. Engineers currently decode JWTs manually (jwt.ms) to check scopes, expiry, and audience. When a token expires mid-session, they lose context on what went wrong.

### Objective

A right-side drawer (320px) showing decoded JWT claims, expiry progress bar, scope pills, with force-refresh and copy actions. Auto-opens when token expires.

### Owner

**Primary:** Zara Okonkwo (JS JWT decoding + drawer)
**Reviewers:** Elena Voronova (token refresh flow), Mika Tanaka (CSS drawer)

### Inputs

- Tokens from `/api/flt/config` (bearer + MWC when connected)
- IPC command: `POST /api/command/refresh-token`

### Outputs

- **Files modified:**
  - `src/frontend/js/topbar.js` — Token countdown click → open drawer
  - `src/frontend/css/token-inspector.css` — Drawer slide-in, JWT section styling
  - `src/frontend/index.html` — Add token inspector drawer markup (or build dynamically)

### Technical Design

**JS — in `topbar.js` or new `token-inspector.js`:**

```
class TokenInspector {
  constructor(drawerEl, apiClient)

  open()                               // Slide drawer in from right
  close()                              // Slide drawer out
  renderToken(tokenStr, type)          // Decode + display: header, payload, signature
  renderClaims(claims)                 // Key-value table from payload
  renderExpiryBar(exp, iat)            // Progress bar green → amber → red
  renderScopes(scp)                    // Scope pills
  handleRefresh()                      // POST /api/command/refresh-token
  handleCopy()                         // Copy raw token to clipboard

  _decodeJwt(token)                    // base64url decode header + payload (no verification)
}
```

### Acceptance Criteria

- [ ] Clicking token countdown in top bar opens Token Inspector drawer from right
- [ ] Drawer shows JWT sections: header (dimmed), payload (highlighted), signature (dimmed)
- [ ] Claims table shows: sub, aud, iss, exp, iat, name, roles/scopes
- [ ] Expiry progress bar with color: green (>10min), amber (5-10min), red (<5min)
- [ ] Scope list displayed as small pills
- [ ] "Refresh Token" button triggers force refresh via IPC
- [ ] "Copy Token" button copies raw token string to clipboard
- [ ] When connected: shows both Bearer and MWC tokens with tab selector
- [ ] When token expires: drawer auto-opens with warning state (red background tint)
- [ ] Drawer closes on Escape key or clicking outside
- [ ] Drawer width is 320px per spec

### Dependencies

- **Feature 5 (Top Bar):** Token countdown must exist as click target
- **Feature 2 (Deploy):** IPC channel needed for refresh command

### Risks

Minimal. JWT decoding is client-side base64, well-understood. Refresh command uses existing IPC channel.

### Moonshot Vision

V2+: Token diff (show what changed after refresh). Token timeline (history of all tokens this session). Scope-to-feature mapping (show which UI features each scope enables).

