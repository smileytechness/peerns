# myapp P2P — Roadmap & Backlog

## ✅ Done (Builds #0–#5)
- Router election + peer discovery (namespace cascade L1–L5)
- Self-healing namespace monitor (auto-downgrade to L1)
- Public key in registry; contact match by pubkey > UUID
- Message status: waiting ⏳ / sent ✓ / delivered ✓✓
- Delivery acks
- File send queue (offline → flush on connect)
- Persistent connections with ECDSA identity verification
- PWA + HTTPS (LAN dev + offline caching)
- Network change detection + reconnect
- Log panel in UI
- Build number badge
- Global top bar: identity (name, PID, key fingerprint, role chip)
- Sidebar: WhatsApp-style contacts (status dot, unread badge, last message preview, last seen)
- Contact detail modal (triggered by chat header click or long-press/right-click)
- Unread counts with markRead on chat open
- deleteContact action

---

## 🔲 Next Up (ordered by priority)

### BLOCK A — UI Identity Separation ✅ (Build #5)
The sidebar currently mixes discovery/namespace info and persistent identity together.
Goal: clean, clearly separated identity panel.

**A1. Sidebar identity panel redesign**
- Section 1 — "Your Identity" (permanent, cryptographic):
  - Friendly Name
  - Persistent ID (the myapp-{hex} one — share this)
  - Key Fingerprint (SHA-256 first 8 bytes, purple)
- Section 2 — "Network" (ephemeral, discovery):
  - Public IP
  - Role (Router L1 / Peer L2 / etc.)
  - Discovery ID (smaller, less prominent — it's transient)
  - Namespace level indicator

**A2. Contact detail modal / info sheet**
Triggered by tapping a contact's name or an (ℹ) button.
Contents:
  - Friendly name (large)
  - Persistent ID (copyable)
  - Key Fingerprint (with verified ✓ badge if we have their pubkey stored)
  - Discovery ID if currently on network (ephemeral, greyed)
  - Online status + last seen
  - Ping button
  - "Open Chat" CTA

---

### BLOCK B — Chat UX improvements
From user's notes in last session.

**B1.** Unread message count badge on contact in sidebar
**B2.** Mark messages as read when chat is opened
**B3.** Open chat scrolled to bottom (newest messages visible first)
**B4.** Scroll-to-bottom button (appears when scrolled up)
**B5.** Incoming message notification (banner/toast when chat not open)
**B6.** Edit sent message — sender sends `{ type: 'edit', id, newContent }`, receiver updates + shows "edited" label; requires peer confirmation (receiver acks edit)
**B7.** Delete sent message — sender sends `{ type: 'delete', id }`, receiver removes; requires peer confirmation
**B8.** Chat header info button → opens contact detail modal (A2)
**B9.** Call/screen-share events logged as system messages in chat

---

### BLOCK C — Security & Encryption
**C1.** E2EE message encryption
  - Generate ECDH P-521 key pair (separate from ECDSA signing keys)
  - ECDH key exchange on persistent connection open
  - Derive shared AES-GCM 256 key via ECDH
  - Encrypt all `message` and `file-*` payloads with AES-GCM

**C2.** Rendezvous TOTP + shared-string rotating check-in space
  - Both sides agree on a shared secret (shown as QR or 6-digit code)
  - Discovery ID rotates every N minutes: `myapp-{HMAC(secret, floor(t/interval))}`
  - Stealth mode: no static discoverable ID

---

### BLOCK D — Discovery Extensions
**D1.** Geo-spatial discovery ("Stadium Mode")
  - Geolocation API → Geohash (7-char, ~150m)
  - Router ID: `myapp-geo-{geohash}-1`
  - Connect to own cell + neighbor cells (overlap handling)

**D2.** Self-healing floating groups
  - Group ID: `myapp-group-{uuid}-1`
  - Router election applies to groups
  - Any remaining member can become group router

---

### BLOCK E — RPC / Headless API (future)
- JSON-RPC over persistent channels
- Granular ACL scopes (fs:read:/path, media:stream:camera, etc.)
- Signed requests, verified by contact's stored pubkey

---

## Architecture Notes

**Identity layers:**
| Layer | ID | Scope |
|---|---|---|
| Cryptographic identity | Public key / fingerprint | Permanent, cross-device |
| Persistent meeting point | `myapp-{hex32}` | Long-term, device-local |
| Discovery presence | `myapp-{ip}-{uuid}` | Ephemeral, per-network |
| Stealth ID (future) | `myapp-secure-{HMAC(...)}` | Rotating, secret |

**File layout:**
- `src/lib/p2p.ts` — core engine (P2PManager class)
- `src/lib/types.ts` — shared types (PeerInfo, Contact, ChatMessage, etc.)
- `src/lib/discovery.ts` — IP detection + ID construction
- `src/lib/crypto.ts` — ECDSA key pair, sign/verify
- `src/lib/store.ts` — IndexedDB (files) + localStorage (contacts, chats)
- `src/hooks/useP2P.ts` — React hook bridging p2p events to state
- `src/components/Sidebar.tsx` — contacts + identity panel
- `src/components/ChatArea.tsx` — chat UI
- `src/App.tsx` — root, modals, call handling
- `src/lib/version.ts` — BUILD constant (bump each deploy)
