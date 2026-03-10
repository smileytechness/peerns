# PeerNS — Full Security Audit & Encryption Architecture
**Date:** March 2026  
**Scope:** p2p.ts, p2p-messaging.ts, p2p-group.ts, crypto.ts  

---

## 1. System Overview

PeerNS is a browser-based peer-to-peer communication platform using WebRTC DataChannels (via PeerJS) for direct peer connections. It supports 1:1 messaging, group chats, file transfer, and audio/video/screen calls. Identity is cryptographically established via ECDSA P-521 key pairs. Shared secrets for encryption are derived via ECDH. All persistent state is stored in `localStorage` and `IndexedDB`.

---

## 2. Current Cryptographic Architecture

### 2.1 Key Types In Use

| Key | Algorithm | Purpose | Where Generated | Where Stored |
|---|---|---|---|---|
| ECDSA private key | P-521 | Sign messages, prove identity | `generateKeyPair()` on first run | `localStorage` — **plaintext base64** |
| ECDSA public key | P-521 | Verify signatures, shared with peers | Same | `localStorage` — plaintext (acceptable) |
| ECDH private key | P-521 (re-imported) | Derive shared secrets | Derived from ECDSA private key at runtime | Memory only |
| Pairwise shared key | AES-256-GCM | Encrypt 1:1 messages | `deriveSharedKey()` per contact | Memory only (fingerprint cached to localStorage) |
| Group key | AES-256-GCM | Encrypt group messages | `generateGroupKey()` on group creation | `localStorage` — **plaintext base64** via `groupKeyBase64` |
| Group key history | AES-256-GCM (array) | Decrypt pre-rotation messages | Archived on key rotation | Memory only |

### 2.2 Key Derivation Chain (Current)

```
ECDSA P-521 keypair (localStorage, plaintext)
    │
    ├─► signData() / verifySignature()        [identity]
    │
    └─► ecdsaToECDHPrivate()                  [runtime only]
            │
            └─► deriveSharedKey(myECDH, theirECDH)
                    │
                    └─► HKDF-SHA256 → AES-256-GCM shared key  [memory only]
                                │
                                └─► encryptMessage() / decryptMessage()  [1:1 messages — redundant, see §6]

Group key (localStorage, plaintext base64)
    └─► encryptMessage() / decryptMessage()   [group messages — redundant, see §6]
    └─► encryptGroupKeyForPeer()              [key distribution, pairwise encrypted — redundant, see §6]
```

---

## 3. Full Data Inventory — At Rest

All data is stored in the browser via `localStorage` or `IndexedDB` (files via `saveFile()`).

### 3.1 localStorage Keys

| Key | Contents | Sensitivity | Currently Encrypted |
|---|---|---|---|
| `${APP_PREFIX}-sk` | ECDSA private key (base64 PKCS8) | **CRITICAL** | ❌ Plaintext |
| `${APP_PREFIX}-pk` | ECDSA public key (base64 SPKI) | Low (public) | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-pid` | PeerJS persistent ID | Medium | ❌ Plaintext |
| `${APP_PREFIX}-name` | User display name | Medium | ❌ Plaintext |
| `${APP_PREFIX}-disc-uuid` | Discovery UUID | Medium | ❌ Plaintext |
| `${APP_PREFIX}-contacts` | All contacts: names, PIDs, public keys, fingerprints, shared key fingerprints | **HIGH** | ❌ Plaintext |
| `${APP_PREFIX}-chats` | All 1:1 message history — fully decrypted content | **HIGH** | ❌ Plaintext |
| `${APP_PREFIX}-groups` | All group info: member lists, public keys, PIDs, group key base64 | **CRITICAL** | ❌ Plaintext |
| `${APP_PREFIX}-group-msgs-{id}` | All group message history — fully decrypted content | **HIGH** | ❌ Plaintext |
| `${APP_PREFIX}-lastread` | Per-contact read timestamps | Low | ❌ Plaintext |
| `${APP_PREFIX}-custom-ns` | Custom namespace names | Low | ❌ Plaintext |
| `${APP_PREFIX}-pid-history` | Historical PeerJS IDs | Low | ❌ Plaintext |
| `${APP_PREFIX}-offline` | Offline mode flag | None | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-fp-migrated` | Migration flag | None | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-ns-offline` | Namespace offline flag | None | ❌ Plaintext (acceptable) |
| `${APP_PREFIX}-credential-created` | WebAuthn setup flag (proposed) | None | N/A |

### 3.2 IndexedDB (File Storage)

| Data | Contents | Sensitivity | Currently Encrypted |
|---|---|---|---|
| File blobs | Raw file content from transfers | **HIGH** | ❌ Plaintext |
| File metadata | Name, size, timestamp, transfer ID | Medium | ❌ Plaintext |

### 3.3 Critical Finding — Group Key Exposure

The group encryption key is exported and stored plaintext in `localStorage`:

```typescript
// groupCreate() — p2p-group.ts
const groupKeyBase64 = await exportGroupKey(groupKey);
const info: GroupInfo = { ..., groupKeyBase64 };  // stored plaintext

// groupRestore() — on every app load
groupKey = await importGroupKey(info.groupKeyBase64);  // read from plaintext
```

This means anyone with localStorage access can decrypt **all past and future group messages** for every group the user belongs to, including post-rotation keys stored in `groupKeyHistory`.

---

## 4. Full Data Inventory — In Transit

All WebRTC DataChannel traffic is protected by **DTLS 1.2/1.3** at the transport layer (mandatory for WebRTC). The analysis below concerns **application-layer encryption** — i.e. protection that survives even if the transport layer were compromised.

### 4.1 PeerJS Signaling Server (`0.peerjs.com`)

**Transport:** TLS  
**Application E2E:** ❌ None — server is a trusted broker

| Data Visible to PeerJS | Notes |
|---|---|
| Your `persistentID` | Required for routing |
| Your IP address | Inherent to TCP connection |
| Who you connect to (PIDs) | Required for connection brokering |
| Timing of connections | Metadata/traffic analysis possible |

**Risk:** PeerJS can construct a social graph of who communicates with whom. Message content is not visible. This is an architectural constraint of the current design.

### 4.2 1:1 Messaging (DataChannel) — Current State
> Note: ECDH E2E encryption and group AES key paths shown below are current implementation. Both are identified as redundant in §6 and scheduled for removal in §8 Phase 5. Target state is DTLS+ECDSA for all channels.

| Message Type | Wire Contents | App-Layer Encrypted | Signed |
|---|---|---|---|
| `hello` | `friendlyname`, `publicKey`, `ts`, `signature` | ❌ No | ✅ Yes (timestamp) |
| `message` (E2E path) | `iv`, `ct`, `sig`, `ts`, `id`, `e2e:true` | ✅ AES-256-GCM (→ removing) | ✅ Yes (ciphertext) |
| `message` (fallback) | `content`, `ts`, `id` | ❌ Plaintext | ❌ No |
| `message-ack` | `id` | ❌ No (metadata only) | ❌ No |
| `message-edit` (E2E) | `id`, `iv`, `ct`, `sig`, `e2e:true` | ✅ AES-256-GCM (→ removing) | ✅ Yes |
| `message-edit` (fallback) | `id`, `content` | ❌ Plaintext | ❌ No |
| `message-delete` | `id`, `tid` | ❌ No (metadata only) | ❌ No |
| `file-start` | `tid`, `name`, `size`, `total` | ❌ Plaintext | ❌ No |
| `file-chunk` | `tid`, `index`, raw `chunk` bytes | ❌ Plaintext | ❌ No |
| `file-end` | `tid` | ❌ No | ❌ No |
| `file-ack` | `tid` | ❌ No | ❌ No |
| `call-notify` | `kind`, `from` | ❌ Plaintext | ❌ No |
| `call-received/answered/rejected` | `kind` | ❌ Plaintext | ❌ No |
| `name-update` | `name` | ❌ Plaintext | ❌ No |
| `group-invite` | `groupId`, `groupName`, `inviterName`, `inviterFP`, full `info`, encrypted group key | Partial — group key encrypted pairwise (→ removing) | ❌ No |

### 4.3 Group Messaging (DataChannel via Router) — Current State
> Note: Group AES key encryption shown below is current implementation, identified as redundant in §6 and scheduled for removal in §8 Phase 5. Target state is DTLS+ECDSA for all group channels including backfill delivery to rejoining members.

| Message Type | Wire Contents | App-Layer Encrypted | Notes |
|---|---|---|---|
| `group-checkin` | `fingerprint`, `friendlyName`, `publicKey`, `pid`, `sinceTs` | ❌ Plaintext | Discovery metadata |
| `group-message` | msg object with `iv`, `ct`, `e2e:true` OR plaintext fallback | ✅ AES-256-GCM (→ removing) | Routed via verified group router |
| `group-relay` | Same as above, opaque relay | ✅ Preserved (→ removing) | |
| `group-message-edit` | `msgId`, `iv`, `ct`, `e2e` OR plaintext | ✅ When key available (→ removing) | |
| `group-message-delete` | `msgId`, `senderFP` | ❌ Plaintext | |
| `group-file-start` | `tid`, `name`, `size`, `total`, `senderFP`, `senderName` | ❌ Plaintext | |
| `group-file-chunk` | `tid`, `index`, `data` (base64) | ❌ Plaintext | |
| `group-file-end` | `tid` | ❌ No | |
| `group-key-distribute` | `iv`, `ct` (group key encrypted pairwise) | ✅ AES-256-GCM pairwise (→ removing entire flow) | |
| `group-key-rotate` | `iv`, `ct` (new group key encrypted pairwise) | ✅ AES-256-GCM pairwise (→ removing entire flow) | |
| `group-info-update` | Full `GroupInfo` including member PIDs, public keys | ❌ Plaintext | |
| `group-backfill` | Historical messages (encrypted blobs if E2E) | ✅ Preserved encryption (→ removing, DTLS covers backfill delivery) | Rejoining member receives missed messages over verified DTLS+ECDSA session |
| `group-call-start/join/leave` | `callId`, `kind`, `fingerprint`, `pid`, `name` | ❌ Plaintext | Call metadata only |
| `group-call-signal` | Call state, participant list with PIDs | ❌ Plaintext | |

### 4.4 Namespace / Discovery (DataChannel)

All namespace traffic is intentionally plaintext — it is discovery infrastructure analogous to DNS:

| Data | Encrypted | Notes |
|---|---|---|
| Router checkin (`discoveryID`, `friendlyname`, `publicKey`) | ❌ No | By design |
| Registry broadcasts (peer lists) | ❌ No | By design |
| Ping/pong | ❌ No | Keepalive only |
| Rendezvous exchange (PID updates) | ❌ No | Contact reconnection |
| Peer slot probes | ❌ No | NAT traversal |

**Risk Level:** Low-Medium. Namespace routers see peer identities and social graph but not message content. This is architecturally necessary for the discovery model.

### 4.5 Media (WebRTC MediaConnection)

| Type | Transport Encryption | App-Layer Encryption |
|---|---|---|
| Audio calls | ✅ DTLS-SRTP (mandatory WebRTC) | ❌ None |
| Video calls | ✅ DTLS-SRTP | ❌ None |
| Screen share | ✅ DTLS-SRTP | ❌ None |
| Group calls | ✅ DTLS-SRTP | ❌ None |

---

## 5. Threat Model Summary

### 5.1 Network Attacker (passive interception)
- **1:1 messages:** ✅ Protected — DTLS per-session encryption + ECDSA identity verification (current ECDH layer identified as redundant, see §6)
- **Group messages:** ✅ Protected — DTLS per-hop + ECDSA verified peers (current group AES layer identified as redundant, see §6)
- **Files:** ⚠️ DTLS transport only — no application E2E
- **Calls:** ⚠️ DTLS-SRTP transport only
- **Metadata (who talks to who):** ❌ Not protected

### 5.2 Local Device Attacker (localStorage access)
- **Private key:** ❌ Fully exposed — can impersonate user (addressed by §7 WebAuthn PRF master key)
- **All message history:** ❌ Fully readable (addressed by §7 Tier 3 storage encryption)
- **Group keys:** ❌ Fully exposed (addressed by §7 Tier 3 storage encryption — group key removed entirely in proposed model)
- **Contact list:** ❌ Fully readable (addressed by §7 Tier 3 storage encryption)
- **Files:** ❌ Fully readable from IndexedDB (addressed by §7 Phase 6 file encryption)

### 5.3 Malicious Browser Extension
- **Same-origin extensions:** Can read all localStorage and IndexedDB
- **CryptoKey objects in memory:** Cannot export non-extractable keys but can invoke app functions
- **Mitigation available:** WebAuthn PRF binds key material to device authenticator

### 5.4 Compromised PeerJS Server
- **Message content:** ✅ Not visible (E2E encrypted)
- **Social graph:** ❌ Fully visible
- **Connection timing:** ❌ Visible

---

## 6. In-Transit Security — Current State, Analysis, and Conclusions

### 6.1 How DTLS Works in WebRTC and Its PeerJS Dependency

WebRTC's DTLS 1.2/1.3 is mandatory for all DataChannel and media traffic. Each peer generates a self-signed DTLS certificate. The fingerprint of that certificate is embedded in the SDP offer/answer that flows through the PeerJS signaling server. When the DTLS handshake occurs, both browsers verify the certificate matches the fingerprint from the SDP.

The structural vulnerability is that PeerJS sits in the middle of the SDP exchange. A compromised PeerJS server could substitute its own DTLS fingerprint before the SDP reaches the remote peer:

```
Normal:
  Alice SDP (fingerprint: A) → PeerJS → Bob verifies A → DTLS to Alice ✅

Compromised PeerJS:
  Alice SDP → PeerJS replaces fingerprint B → Bob verifies B → DTLS to attacker ❌
```

Bob's browser sees a valid DTLS connection and has no way to detect the substitution. This is the single meaningful weakness of relying on DTLS alone — it requires trusting the signaling server to faithfully relay SDP.

### 6.2 What ECDSA Adds and Why It Is Sufficient

The ECDSA `hello` handshake closes the PeerJS MITM gap completely:

```typescript
const valid = await verifySignature(key, d.signature, d.ts);
if (!valid) conn.close();
```

An attacker who performs the DTLS fingerprint substitution above cannot forge Alice's ECDSA signature — they don't have her private key. The hello handshake fails and the connection closes. Because the ECDSA public key is independently known and fingerprinted before any connection attempt, there is no way for PeerJS to substitute this identity either.

**ECDSA + DTLS together close the signaling MITM vector entirely.** No further application-level encryption layer is required for in-transit confidentiality on 1:1 connections.

### 6.3 Is The Static ECDH Layer Redundant for 1:1?

Yes. Given ECDSA verifies the DTLS connection is clean, adding a static ECDH pairwise key provides no additional protection for the wire. DTLS is already encrypting the channel. The ECDH layer encrypts it again but with a static long-term key rather than DTLS's ephemeral per-session keys. The two layers are independent — DTLS keeps its own forward secrecy regardless — but the ECDH layer adds complexity without adding a meaningful new security property that DTLS + ECDSA doesn't already provide.

**Conclusion: the static 1:1 ECDH layer is a candidate for removal.**

### 6.4 Is The Group AES Key Redundant?

Following the same logic consistently — yes, for the same reasons.

The group router is a DTLS endpoint, so it receives decrypted bytes on each hop. However the router is also a verified group member — it holds the group key as a legitimate participant. The group key therefore provides no protection against the router reading messages, because the router is supposed to be able to read them as a member. Protection against a malicious router is entirely an application-code concern: ensuring only verified members are admitted and only verified members receive relayed messages. The group AES key does not strengthen or replace that application-level guarantee.

Group key rotation on member removal follows the same pattern — rotation only works if the application code correctly limits who receives the new key. If the application code is correct, DTLS already ensures this. The encryption layer adds nothing on top of correct application logic.

**Conclusion: the group AES key for in-transit confidentiality is also redundant given DTLS + ECDSA.** The pairwise ECDH used for group key distribution can be retired alongside it.

### 6.5 How PeerNS In-Transit Compares To Signal and iMessage

The critical architectural difference between PeerNS and Signal/iMessage is **where the server sits relative to message content**.

Signal and WhatsApp route all messages through their own servers. The server holds your encrypted message while your recipient is offline. This means the server has persistent custody of encrypted content — and under legal compulsion, a cooperative Signal server still cannot produce plaintext because it never had the keys. Double Ratchet and X3DH exist specifically to make this guarantee hold even against a fully cooperative server.

PeerNS uses PeerJS only for **signaling** — SDP exchange to establish the WebRTC connection. Once connected, messages travel directly peer-to-peer over DTLS-encrypted DataChannels. PeerJS never has custody of message content at any point, even transiently. This is actually a stronger position than Signal in one specific sense: there is no server that could be compelled to produce message metadata or timing data beyond connection establishment.

The narrower trust requirement means Double Ratchet solves a problem PeerNS structurally doesn't have for established connections. The only PeerJS attack surface is the SDP exchange, which ECDSA already closes.

**X3DH is also irrelevant to PeerNS.** X3DH exists to establish a shared secret with an offline peer by fetching prekeys from a server. PeerNS requires both peers to be reachable for a WebRTC connection — messages queue on-device and transmit when the peer reconnects over a fresh DTLS session. There is no offline prekey server to design around.

| Property | PeerNS (DTLS+ECDSA) | Signal (Double Ratchet) | iMessage |
|---|---|---|---|
| Server sees message content | ❌ Never — P2P only | ❌ Never — E2E encrypted | ❌ Never — per-recipient encrypted |
| Server sees who talks to whom | ✅ PeerJS sees connection graph | ✅ Signal sees metadata | ✅ Apple sees metadata |
| Per-session forward secrecy | ✅ DTLS ephemeral keys | ✅ Per-message ratchet | ✅ Per-message keys |
| Per-message forward secrecy | ❌ DTLS rotates per session | ✅ Every message | ✅ Every message |
| Identity verification | ✅ ECDSA on every connection | ✅ X3DH + signed prekeys | ✅ Apple PKI |
| Offline message delivery | ❌ Queue on device | ✅ Server holds encrypted | ✅ Apple holds encrypted |
| Signaling server trust required | Partial — ECDSA closes MITM gap | None — DR independent of server | Partial — Apple PKI |
| Protocol patented/licensed | ❌ No | ✅ Yes — commercial license required | ❌ No (proprietary) |

**Group in-transit comparison:**

| Property | PeerNS (DTLS+ECDSA) | Signal (Sender Keys) | iMessage (per-recipient) |
|---|---|---|---|
| Who relays group messages | ✅ No server — self-elected peer router from live group members. Zero server custody of any message at any point. (Con: no offline delivery) | ❌ Signal's servers — encrypted custody until recipient online | ❌ Apple's servers — encrypted custody until recipient online |
| Relay node sees content | ✅ Structurally impossible — no server exists to see content. All hops are direct P2P DTLS+ECDSA between verified group members | ❌ Server holds encrypted blobs — content protected by E2E but server has persistent custody | ❌ Apple holds encrypted blobs — same as Signal |
| Per-session forward secrecy (in-transit) | ✅ DTLS per session | ✅ Per-message ratchet | ✅ Per-message |
| At-rest compromise blast radius | All stored messages exposed (equal to Signal/iMessage — see §7.5) | All stored messages exposed | All stored messages exposed |
| Key distribution | None — DTLS+ECDSA per connection, no group key | X3DH prekeys via Signal server | Apple PKI per device |
| Architecture complexity | Low — no server infrastructure | High | Medium |

The group router in PeerNS is not a server — it is a dynamically self-elected peer from whoever is online in the group namespace, communicating via the same DTLS+ECDSA stack as all other connections. There is no central infrastructure with custody of messages. All relay hops are P2P and verified.

At-rest compromise is equivalent across all three platforms once master key encryption is implemented — an attacker who defeats device authentication gets stored messages regardless of what the in-transit protocol did. This is not a PeerNS-specific weakness and should not be compared against in-transit properties of other platforms.

### 6.6 The Case For Double Ratchet (Optional, Advanced)

The only property DTLS+ECDSA does not provide that Double Ratchet does is **intra-session per-message forward secrecy**. DTLS rotates keys per connection. Double Ratchet rotates per message. The gap is:

```
Attacker compromises your device mid-session:
  DTLS alone:       can read all messages in the current open session
  Double Ratchet:   can only read messages from that point forward —
                    past messages in the same session have already ratcheted away
```

This is a real but narrow scenario requiring live device compromise during an active session. For most threat models this is not the primary concern. It is flagged as an optional advanced phase — the only remaining meaningful upgrade over the clean DTLS+ECDSA baseline.

Note: if Double Ratchet were implemented, X3DH is not required. Since both peers are online for every WebRTC connection, the initial shared secret can be seeded directly from the existing ECDH hello handshake without prekey infrastructure.

```
Recommended Baseline:
  DTLS       → wire confidentiality, per-session forward secrecy
  ECDSA      → identity verification, closes PeerJS MITM gap
  Master key → all at-rest encryption

Optional Advanced (if intra-session forward secrecy required):
  Double Ratchet → per-message forward secrecy
  ECDSA          → identity verification
  Master key     → all at-rest encryption
```

### 6.7 Revised In-Transit Summary

| Channel | Currently | Recommended | Change |
|---|---|---|---|
| 1:1 messages | DTLS + static ECDH + ECDSA | DTLS + ECDSA | Remove static ECDH |
| 1:1 queued messages | DTLS + static ECDH + ECDSA | DTLS + ECDSA on reconnect | Fresh DTLS session per reconnect — forward secrecy maintained |
| 1:1 files | DTLS only | DTLS + ECDSA | No encryption change needed |
| Group messages | DTLS + group AES + ECDSA | DTLS + ECDSA | Remove group AES key — redundant given verified DTLS per hop |
| Group files | DTLS only | DTLS + ECDSA | No encryption change needed |
| Calls (1:1) | DTLS-SRTP | DTLS-SRTP + signed call token | Add ECDSA-signed token over DataChannel before call |
| Group calls | DTLS-SRTP | DTLS-SRTP + signed token | Same as 1:1 call |
| Namespace/discovery | DTLS (transport only) | DTLS (transport only) | No change — by design |

---

## 7. At-Rest Security — Industry Methods, Current State, and Proposed Solution

### 7.1 How Signal Handles At-Rest Encryption

Signal is the most instructive reference because it documents its approach openly and takes at-rest security as seriously as in-transit.

**Mobile (iOS and Android):**
Signal stores all messages in a local SQLite database encrypted with **SQLCipher** — a full database encryption extension. The database key is a 256-bit random value generated on first install. On iOS this key is stored in the **Secure Enclave-backed Keychain** under the `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` attribute — meaning it requires the device to have been unlocked at least once since boot, is hardware-bound to the specific device, and is never exported from the Secure Enclave. On Android it uses the **Android Keystore** with hardware-backed key storage in the TEE (Trusted Execution Environment).

The key never exists in application memory as raw bytes. It is used directly by SQLCipher via the OS APIs without ever being accessible to the application layer.

**Desktop (Electron):**
Signal Desktop derives a storage key from the OS credential store (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). It uses this to encrypt a local key file. The database is again SQLCipher-encrypted. This is weaker than mobile because desktop OS credential stores are less isolated than hardware-backed mobile keystores — but it is still meaningfully better than plaintext.

**Key insight:** Signal never asks the user for a PIN or password for at-rest encryption on mobile. The OS hardware security model handles it. Authentication is handled by the device unlock mechanism (biometric/PIN) which in turn gates access to the Keychain/Keystore. The user experience is seamless — the database is just always encrypted.

### 7.2 How WhatsApp Handles At-Rest Encryption

WhatsApp relies primarily on the OS-level encryption provided by iOS Data Protection and Android's file-based encryption. Messages are in a SQLite database that is encrypted at the filesystem level by the OS when the device is locked.

WhatsApp additionally offers end-to-end encrypted backups (since 2021) using a 64-digit key or a user-supplied password derived via PBKDF2. The backup encryption key itself is stored in a hardware security module on WhatsApp's servers — which is a weaker model than Signal since it introduces server-side key storage.

Local storage on-device is primarily protected by the OS, not application-level encryption.

### 7.3 How iMessage Handles At-Rest Encryption

iMessage uses iOS Data Protection classes. Each message database file is assigned a protection class:

- **Class A** (`CompleteProtection`): encrypted with a key derived from device passcode + device key. File is inaccessible when device is locked.
- **Class B** (`CompleteUnlessOpen`): accessible while file is open, encrypted when closed and device locked.
- **Class C** (`CompleteUntilFirstUserAuthentication`): accessible after first unlock, remains accessible until reboot.

The actual database key is wrapped with the user's passcode-derived key and stored on-device. The Secure Enclave enforces passcode attempts and can wipe the key after too many failures (if configured).

Apple also holds iCloud backup keys on their servers, which is a known weakness — iCloud backups of iMessages are not E2E encrypted by default (though Advanced Data Protection changes this).

### 7.4 The Common Pattern Across All Three

| App | Key Storage | Hardware-Backed | User Friction |
|---|---|---|---|
| Signal mobile | iOS Keychain / Android Keystore | ✅ Yes (Secure Enclave / TEE) | None — device unlock gates it |
| Signal desktop | OS credential store | Partial | None |
| WhatsApp | OS filesystem encryption | ✅ Via OS | None |
| iMessage | iOS Data Protection | ✅ Secure Enclave | None |

The universal pattern is: **bind encryption keys to hardware-backed OS authentication. Never derive keys from application-level passwords. Never store keys in application storage.**

The user's device unlock mechanism (biometric/PIN) is the authentication factor. The OS hardware security module enforces this. The application never sees the raw key.

### 7.6 The Browser Equivalent — WebAuthn PRF

The browser has no Secure Enclave API, no Keychain API, no SQLCipher. However **WebAuthn with the PRF extension** provides the closest functional equivalent available on the web platform:

- The credential is bound to the device's platform authenticator (Touch ID, Face ID, Windows Hello, device PIN)
- The PRF output is computed inside the authenticator hardware — it never exists as a raw value the application can access directly
- The output is deterministic — the same authentication always produces the same 32-byte PRF output
- The application derives a master key from this output via HKDF, uses it to encrypt all sensitive storage, then discards it when the session locks
- Without the device authenticator, the PRF output cannot be obtained — localStorage dumps are useless without it

This is architecturally equivalent to Signal's Keychain/Keystore approach adapted to browser constraints.

### 7.7 What Needs To Be Encrypted At Rest

| Data | Current State | Required State | Why |
|---|---|---|---|
| ECDSA private key | ❌ Plaintext base64 | ✅ Encrypted (master key) | Critical — full identity compromise |
| All 1:1 message history | ❌ Plaintext | ✅ Encrypted (master key) | Full conversation exposure |
| All group message history | ❌ Plaintext | ✅ Encrypted (master key) | Full group conversation exposure |
| Contact records (PIDs, public keys) | ❌ Plaintext | ✅ Encrypted (master key) | Social graph + identity data |
| Group info (members, groupKeyBase64) | ❌ Plaintext | ✅ Encrypted (master key) transitioning to obsolete | Group key sitting plaintext is critical gap in current model — `groupKeyBase64` field removed entirely in proposed DTLS+ECDSA model, making this a non-issue going forward |
| Discovery UUID | ❌ Plaintext | Plaintext acceptable | Broadcast openly to all namespace routers — public network identifier |
| PID history | ❌ Plaintext | Plaintext acceptable | Broadcast openly to signaling server — public network identifier |
| Display name | ❌ Plaintext | Plaintext acceptable | Not sensitive |
| File blobs (IndexedDB) | ❌ Plaintext | ✅ Encrypted (master key) | File content exposure |
| Offline/config flags | ❌ Plaintext | Plaintext acceptable | No sensitivity |

### 7.8 Tiered Storage Model

#### Tier 1 — Always Plaintext
```
${APP_PREFIX}-offline
${APP_PREFIX}-ns-offline
${APP_PREFIX}-fp-migrated
${APP_PREFIX}-credential-created
${APP_PREFIX}-name              (display name — not sensitive)
${APP_PREFIX}-pid               (PeerJS ID — broadcast openly to signaling server)
${APP_PREFIX}-pid-history       (historical PeerJS IDs — public network identifiers)
${APP_PREFIX}-disc-uuid         (discovery UUID — broadcast openly to all namespace routers)
${APP_PREFIX}-custom-ns         (namespace names — broadcast openly during discovery)
```

#### Tier 2 — Plaintext Metadata (pre-unlock notifications)
```
Key: ${APP_PREFIX}-contact-meta
Contents: { [contactKey]: { friendlyName, lastMessageTs, unreadCount } }

No PIDs, no public keys, no fingerprints, no message content.
Purpose: render contact list and notification sender name while session is locked.
```

#### Tier 3 — Encrypted with Master Key
```
${APP_PREFIX}-sk                  ECDSA private key
${APP_PREFIX}-contacts            full contact records
${APP_PREFIX}-chats               all 1:1 message history
${APP_PREFIX}-groups              group info + groupKeyBase64 (groupKeyBase64 field obsolete in proposed model — group AES key removed entirely)
${APP_PREFIX}-group-msgs-{id}     group message history
${APP_PREFIX}-disc-uuid           discovery UUID
${APP_PREFIX}-pid-history         historical PeerJS IDs
IndexedDB file blobs              encrypted before write
```

### 7.9 Master Key Derivation and Session Lifecycle

```
Device Authenticator (Touch ID / Face ID / Windows Hello / PIN)
    │
    └─► WebAuthn PRF output [32 bytes, never stored, computed in hardware]
            │
            └─► HKDF-SHA256 → Master AES-256-GCM key [memory only, non-extractable]
                    │
                    ├─► Decrypt ECDSA private key → ECDSA sign/verify all connections
                    │
                    ├─► Encrypt/decrypt all Tier 3 localStorage values
                    │
                    └─► Encrypt/decrypt all IndexedDB file blobs

Session Lifecycle:
    App opens
        Load Tier 1 + Tier 2 → show contact list, unread counts
        WebAuthn prompt → biometric / PIN
        PRF → HKDF → master key (memory only)
        Decrypt Tier 3 → full app available

    Idle 15 min / tab hidden / explicit lock
        masterKey = null
        'session-locked' event dispatched
        UI shows lock screen

    Incoming message while locked
        DataChannel still open (WebRTC persists)
        Store raw payload — cannot decrypt
        Notify: "[Name]: New message" (Tier 2 only)
        On unlock → re-process stored payloads

    User unlocks
        WebAuthn prompt again → same PRF output → same master key
        Decrypt pending payloads → full access restored

Fallback (WebAuthn PRF unavailable — Chrome <116, Firefox, older Safari):
    PBKDF2(userPassword, storedSalt, 600_000 iterations, SHA-256) → master key
    Same tiered model applies
    Weaker: offline dictionary attack possible if storage + salt stolen
    Salt stored plaintext in Tier 1
```

---

## 8. Implementation Strategy

### Phase 1 — crypto.ts: Master Key Foundation
- `createAuthCredential(userId)` — register WebAuthn credential with PRF extension
- `getMasterKeyMaterial()` — authenticate, retrieve PRF output from hardware
- `deriveMasterKey(prfOutput)` — HKDF-SHA256 → non-extractable AES-256-GCM
- `encryptForStorage(masterKey, plaintext)` — AES-GCM with prepended IV
- `decryptFromStorage(masterKey, blob)` — reverse
- `deriveMasterKeyFromPassword(password, salt)` — PBKDF2 fallback
- `detectPRFSupport()` — browser capability check

### Phase 2 — store.ts: Encrypted Storage Layer
All sensitive read/write functions accept `masterKey` parameter:
- `saveChats(chats, masterKey) / loadChats(masterKey)`
- `saveContacts(contacts, masterKey) / loadContacts(masterKey)`
- `saveGroups(infos, masterKey) / loadGroups(masterKey)`
- `saveGroupMessages(id, msgs, masterKey) / loadGroupMessages(id, masterKey)`
- `saveFile(tid, blob, name, ts, masterKey)` — encrypt blob before IndexedDB write
- New: `saveContactMeta(meta) / loadContactMeta()` — Tier 2, always plaintext

### Phase 3 — p2p.ts: Session Management
In `loadState()`:
1. Load Tier 1 + Tier 2 immediately, emit preliminary status
2. Check `credential-created` — run `createAuthCredential()` on first run
3. `getMasterKeyMaterial()` → triggers biometric/PIN prompt
4. On PRF failure → PBKDF2 password fallback
5. On both fail → dispatch `'auth-required'`, halt init
6. `masterKey` stored on P2PManager instance (memory only)
7. Decrypt Tier 3, continue normal init

New P2PManager members:
- `masterKey: CryptoKey | null`
- `sessionLocked: boolean`
- `lockSession()` — nulls masterKey, emits `'session-locked'`
- `unlockSession()` — re-runs WebAuthn / PBKDF2 flow
- Idle timer: reset on `visibilitychange` and `pointerdown`
- `pagehide` handler → null masterKey immediately

### Phase 4 — p2p-messaging.ts: Locked Session Handling
```typescript
// Incoming message while locked:
if (!mgr.masterKey) {
  mgr.pendingEncrypted = mgr.pendingEncrypted || [];
  mgr.pendingEncrypted.push({ encryptedPayload: d, conn, ck });
  const fname = loadContactMeta()[ck]?.friendlyName || 'Someone';
  mgr.notify(fname, 'New message', `msg-${ck}`);
  return;
}

// On unlockSession() success:
for (const p of mgr.pendingEncrypted || []) {
  await handlePersistentData(mgr, p.encryptedPayload, p.conn);
}
mgr.pendingEncrypted = [];
```

### Phase 5 — Remove Static ECDH From 1:1 and Group (Simplification)
- Remove `getOrDeriveSharedKey()` from all `p2p-messaging.ts` send/receive paths
- Remove `sendEncryptedMessage()` ECDH encryption branch
- Remove group AES key encryption/decryption from `p2p-group.ts` message send/receive
- Remove `group-key-distribute` / `group-key-rotate` message types
- Remove `generateGroupKey` / `exportGroupKey` / `importGroupKey` usage from group flow
- Retain ECDSA `hello` signature verification — unchanged and required
- Result: significantly simpler codebase, DTLS + ECDSA trusted for all in-transit

### Phase 6 — File Encryption At Rest (IndexedDB)
```typescript
// On save:
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, masterKey, await blob.arrayBuffer()
);
const combined = new Uint8Array(12 + ct.byteLength);
combined.set(iv); combined.set(new Uint8Array(ct), 12);
// Store combined buffer

// On load:
const iv = combined.slice(0, 12);
const ct = combined.slice(12);
const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, masterKey, ct);
```

### Phase 7 — Double Ratchet (Optional, Advanced)
If full independence from PeerJS trust is required — equivalent to Signal's threat model:
- Implement X3DH initial key agreement on top of existing ECDSA/ECDH keys
- Implement Double Ratchet: DH ratchet per exchange + symmetric ratchet per message
- Provides per-message forward secrecy DTLS cannot offer
- Replaces Phase 5 simplification for 1:1 messages
- Group messaging would require Sender Keys (Signal's group ratchet approach)
- Significant implementation complexity — only warranted if PeerJS is explicitly untrusted

---

## 9. Remaining Accepted Risks (Post-Implementation)

| Risk | Severity | Mitigation |
|---|---|---|
| JS memory cannot be zeroed | Low | Browser constraint; non-extractable keys limit exposure |
| Master key usable by same-origin malicious extension | Low-Medium | Requires extension with explicit host permission |
| PeerJS social graph visibility (who talks to whom) | Medium | Self-host PeerJS server to eliminate entirely |
| No intra-session per-message forward secrecy | Medium | Phase 7 Double Ratchet addresses if required |
| WebAuthn PRF unavailable on some browsers | Medium | PBKDF2 password fallback covers gap |
| PBKDF2 fallback weaker than PRF | Low-Medium | Offline dictionary attack if storage stolen; acceptable fallback |
| Namespace/discovery exposes presence and display name | Low | By design for discovery; acceptable |
| Call metadata (timing, participants) visible | Low | Content protected by DTLS-SRTP |

---

## 10. Why Application-Level Encryption Is Not Redundant

### The DTLS Question

WebRTC DataChannels are protected by DTLS 1.2/1.3 at the transport layer — legitimate, strong, per-session encryption with ephemeral keys. A reasonable question is whether the ECDSA identity verification built on top of this is necessary. The answer is yes — but for identity only, not for message encryption.

DTLS encrypts the channel but does not authenticate who is at the other end. DTLS certificate fingerprints travel through the PeerJS signaling server inside SDP negotiation packets. A compromised PeerJS server could substitute its own DTLS fingerprint before it reaches the peer, establishing a perfectly encrypted channel directly to an attacker. The victim sees a valid DTLS connection and has no way to detect the substitution from DTLS alone.

The ECDSA hello handshake directly closes this vector. Because the remote peer must sign a timestamp with their private key, and because the public key is independently known and fingerprinted, a MITM cannot forge the signature without possessing the private key.

```
Without ECDSA:  You ──[DTLS]──► Attacker ──[DTLS]──► Peer   (invisible MITM)
With ECDSA:     You ──[DTLS]──► Attacker             FAILS signature check → disconnect
```

**ECDSA is the necessary application-level addition to DTLS. Message-level ECDH encryption is not — it is redundant given verified DTLS channels and mutual ECDSA enforcement.**

### Group Messages and DTLS+ECDSA

The earlier conclusion that group AES encryption was non-negotiable due to DTLS being hop-by-hop has been superseded. Each hop in the group topology — sender to router, router to each member — is an independent DTLS+ECDSA verified connection between authenticated group members. The router is not an untrusted relay; it is a verified peer whose identity is confirmed via ECDSA on every session. There is no meaningful security difference between a 1:1 connection and a group hop under DTLS+ECDSA. The group AES key is redundant for the same reasons the 1:1 ECDH layer is redundant.

### Code Correctness and the Self-Enforcing Property of DTLS+ECDSA

A critical property of mutual ECDSA verification is that security does not depend on all parties running correct code — only one correctly coded peer is sufficient to enforce verification for their side of the connection.

The hello handshake is always mutual:

```
Alice sends: { publicKey, signature, ts }
Bob verifies → fail → disconnect

Bob sends: { publicKey, signature, ts }
Alice verifies → fail → disconnect
```

If Bob runs modified code that skips verifying Alice, he only undermines his own security. He cannot force Alice's correct app to skip her verification of him. Alice will not proceed unless Bob's ECDSA signature passes. A modified app cannot fool a correctly coded peer into communicating over an unverified channel — it can only fool itself.

This gives three clean cases:

```
Correct app ↔ Modified app
  → Correct app verifies modified app's hello
  → Modified app cannot bypass this
  → Correct side is fully protected

Modified app ↔ Modified app
  → Both users chose to run compromised code
  → Outside any reasonable security model

Private key stolen (either side)
  → ECDSA broken → DTLS unverified
  → ECDH equally broken → shared key derivable from stolen key
  → Both models equally compromised
  → At-rest private key protection is the only meaningful mitigation
```

The ECDH layer provides no additional protection in any of these cases that DTLS+ECDSA does not already provide. Security in all cases reduces to a single dependency: **private key protection at rest**. This is entirely addressed by the WebAuthn PRF master key encryption described in section 7.

### The Priority Inversion Problem

The codebase correctly implements identity verification via ECDSA and transport security via DTLS, but has not yet closed the simpler, more practically exploitable gap: plaintext storage at rest. The result is a system that defeats a compromised signaling server while remaining fully readable to anyone who opens DevTools or accesses the device's localStorage. The threat model is inverted relative to the realistic attack surface for a browser application.

The at-rest encryption work described in this document is what makes the security model coherent end-to-end. ECDSA+DTLS handles the wire. WebAuthn PRF master key handles storage. Neither layer is unnecessary — they solve distinct problems. The redundant layer that has been identified and scheduled for removal is the application-level ECDH message encryption, not ECDSA identity verification.

---

## 10. Priority Order

| Priority | Item | Impact |
|---|---|---|
| P0 | Encrypt ECDSA private key at rest | Critical — full identity compromise possible |
| P1 | Encrypt all message history at rest (1:1 and group) | High — full conversation history exposed |
| P1 | Encrypt contacts at rest | High — social graph + public keys exposed |
| P2 | Locked-session message handling | High — enables secure background operation |
| P2 | File encryption at rest (IndexedDB) | Medium-High |
| P3 | Add ECDSA signed call token over DataChannel before call | Medium — ties call to verified identity |
| P3 | PBKDF2 fallback for unsupported browsers | Medium |
| P4 | Idle session auto-lock | Low-Medium |
| P4 | Self-hosted PeerJS (eliminate social graph) | Low |
