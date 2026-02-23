# 🚀 What's Next: Future Roadmap

The current architecture proves that serverless discovery is possible via Public IP. The next phase extends this logic to support **physical proximity**, **unbreakable group chats**, and **military-grade identity protection**.

## 1. Geo-Spatial Discovery ("Stadium Mode")
Currently, discovery is limited to users on the same WiFi (Public IP). By utilizing the browser's Geolocation API, we can create discovery namespaces based on physical location, allowing users on different networks (e.g., WiFi vs. 5G) to find each other when physically close.

*   **Logic:** Convert GPS (Lat/Long) into a [Geohash](https://en.wikipedia.org/wiki/Geohash).
*   **Precision:** 7 characters (~150m radius).
*   **Router ID:** `myapp-geo-{geohash}-1`
*   **Behavior:** The app attempts to claim the router for its current 150m square.
*   **Edge Case Handling:** To solve the "border problem" (users standing on the edge of a zone), clients connect to the routers of their current zone *plus* the 8 surrounding neighbor zones.
*   Or: have the client calculate the 4 surounding gps coordinates and hash them. Only enroll in the hashes that are foud in all 5 geolocation hashses (limits the network overhead).
*   -------------------
*  ```# (calculate)+hash            # (calculate)+hash```
*  ```           #(GPS coordinate you are here)+hash    ```
*  ```# (calculate)+hash            # (calculate)+hash```
*   - enroll in all unique hashes. might only be 1 or 2...
*   - namespace routers for geohash will include each users actual gps coordinate as a datapoint
*   - client will look at all registrations from all geohash routers, and sort by closest gps coordinates from all hash groups

## 2. Self-Healing "Floating" Groups
Standard P2P groups rely on a specific "Host." If the host leaves, the group dies. We can solve this by applying our **Router Election Logic** to the group itself.

*   **Concept:** A Group is not a list of peers; a Group is a *Topic Router*.
*   **Group ID:** `myapp-group-{groupUUID}-1`
*   **The Mechanism:**
    1.  **Creation:** User A creates a group. They implicitly become the router for that Group ID.
    2.  **Joining:** Users B and C connect to the Group ID. User A relays messages (Star Topology).
    3.  **Host Migration (The Magic):** If User A leaves (or closes their laptop), the connection dies. Users B and C detect this, wait a random jitter (0–3s), and attempt to **claim the Group ID**.
*   **Result:** As long as *one* member remains online, the group infrastructure persists. The "Server" floats from user to user automatically.

## 3. "Stealth Mode" (Rotating Secure IDs)
The current Persistent ID (`myapp-{uuid}`) is static. If a user shares it publicly, they can be spammed forever. To fix this, we introduce **Time-Based Identity Rotation** (similar to RSA tokens/TOTP).

*   **The Mechanism:** `myapp-secure-{Hash(Secret + Time)}-1`
*   **The Secret:** Generated automatically upon initial connection.
*   **Confirmation (Bluetooth Style):** To ensure no Man-in-the-Middle attacks during the initial exchange, users can optionally compare a 6-digit "Safety Number" derived from the secret before trusting the connection.
*   **Behavior:** The "Meeting Point" changes every 10 minutes. Even if an attacker intercepts the ID, it becomes dead within minutes. This completely separates "Discovery" from "Long-term Identity."

## 4. Application-Layer Encryption (E2EE)
While WebRTC provides transport encryption (DTLS), we need to ensure that the person holding the ID is actually who they say they are.

*   **Key Generation:** On first launch, the app generates a `CryptoKey` pair (ECDH-P521) via the Web Crypto API.
*   **Trust on First Use (TOFU):**
    1.  **Handshake:** When Peer A connects to Peer B via *Persistent ID*, they exchange **Public Keys**.
    2.  **Storage:** The Public Key is stored locally alongside the contact's ID.
*   **Verification:**
    *   **Signing:** Every message sent is signed with the sender's *Private Key*.
    *   **Verifying:** The receiver verifies the signature using the stored *Public Key*.
    *   If the ID matches but the signature fails (e.g., a stolen router ID), the message is rejected.

---

## 🧩 The Final ID Hierarchy

With these features, a single app instance manages four distinct layers of identity simultaneously.

### Group Routers (Discovery Namespaces)
*These IDs are deterministic "meeting points." Any peer can claim them to become the router for that scope.*

| Scope | ID Format | Purpose |
| :--- | :--- | :--- |
| **Network (WiFi)** | `myapp-{ip}-1` | Discovery for devices on the same Public IP. |
| **Physical (Geo)** | `myapp-geo-{geohash}-1` | Discovery for devices in the same ~150m radius. |
| **Topic (Group)** | `myapp-group-{groupUUID}-1` | Discovery for members of a specific chat group. |

### Peer Identities
*These IDs represent a specific user/device.*

| Type | ID Format | Visibility | Purpose |
| :--- | :--- | :--- | :--- |
| **Discovery ID** | `myapp-{namespace}-{discoveryUUID}` | **Public** | Opaque ID used to announce presence to a Router. `namespace` changes based on context (IP/Geo). |
| **Persistent ID** | `myapp-{persistentUserUUID}` | **Private** | Long-term identity exchanged only after acceptance. Used for direct 1:1 connections. |
| **Shared Secure ID**| `myapp-secure-{rotatingUserUUID}` | **Secret** | Rotating ID derived from `Hash(Secret + Time)`. Used for stealth/untraceable connections. |



---
## 5. Headless API & Remote Command Execution (RPC)
We are evolving the protocol from simple "Messaging" to "Remote Procedure Calls" (JSON-RPC), allowing trusted devices to act as headless nodes or personal servers.

*   **The Concept:** Trusted peers can send signed commands to query data, manage files, or trigger actions without human intervention on the receiving side.
*   **Security:** This utilizes a granular **Access Control List (ACL)** based on cryptographic signatures. A user explicitly grants specific capabilities (Scopes) to a contact's Shared Secure ID.
*   **Protocol:**
    *   **Request:** `{ type: 'RPC', method: 'fs.list', params: { path: '/shared' }, signature: '...' }`
    *   **Response:** `{ type: 'RPC_RES', result: ['photo.jpg', 'doc.pdf'] }`

### Granular Permission Scopes
Permissions are not binary; they utilize a path-based syntax (`category:action:resource`) to ensure a remote peer only accesses exactly what they are authorized to touch.

| Category | Scope Syntax | Granularity Example | Use Case |
| :--- | :--- | :--- | :--- |
| **Filesystem** | `fs:{action}:{path}` | `fs:read:/public/photos/*` | Allow a peer to view the "Photos" folder, but **deny** access to `/documents` or root. |
| **Database** | `db:{action}:{key}` | `db:read:messages:timestamp>17000` | Allow a syncing device (e.g., your phone) to fetch only **new** messages from your Desktop history. |
| **Media** | `media:{action}:{source}` | `media:stream:camera:environment` | Allow a trusted "Sentinel" device to auto-start the **rear camera** only (baby monitor mode), preventing access to the front camera or microphone. |
| **System** | `sys:{action}` | `sys:status:battery` | Allow a remote dashboard to monitor device health or storage quotas. |

### "Self-Hosted" Mesh Cloud
By combining **Granular Scopes** with **Trusted Shared Secure IDs**, users can safely treat their own devices as a personal cloud:
1.  **Desktop** stays open at home with `fs:write:/incoming/*` scope granted to **Phone**.
2.  **Phone** sends a photo via RPC to the Desktop's storage.
3.  **Desktop** acknowledges receipt and indexes the file in OPFS (Origin Private File System).
4.  **Result:** Serverless, encrypted file backup without user interaction on the receiving end.
