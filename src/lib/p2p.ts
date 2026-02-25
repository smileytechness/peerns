import { Peer, DataConnection, MediaConnection } from 'peerjs';
import {
  APP_PREFIX,
  TTL,
  PING_IV,
  PeerInfo,
  Contact,
  ChatMessage,
  FileTransfer,
  CHUNK_SIZE,
  CustomNS,
  NSConfig,
  RVZ_WINDOW,
  RVZ_SWEEP_IV,
} from './types';
import {
  makeRouterID,
  makeDiscID,
  extractDiscUUID,
  getPublicIP,
  slugifyNamespace,
  makeCustomRouterID,
  makeCustomDiscID,
  makePeerSlotID,
  makeRendezvousRouterID,
  makeRendezvousDiscID,
  makeRendezvousPeerSlotID,
} from './discovery';
import {
  saveContacts,
  loadContacts,
  saveChats,
  loadChats,
  saveFile,
} from './store';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
  signData,
  verifySignature,
  ecdsaToECDHPrivate,
  ecdsaToECDHPublic,
  deriveSharedKey,
  fingerprintSharedKey,
  encryptMessage,
  decryptMessage,
  arrayBufferToBase64,
  deriveRendezvousSlug,
} from './crypto';

// ─── Internal namespace state ─────────────────────────────────────────────────

interface NSState {
  isRouter: boolean;
  level: number;
  registry: Record<string, PeerInfo>;
  routerPeer: Peer | null;
  routerConn: DataConnection | null;
  discPeer: Peer | null;
  pingTimer: any;
  monitorTimer: any;
  peerSlotPeer: Peer | null;
  peerSlotTimer: any;
  peerSlotProbeTimer: any;
  joinTimeout: any;
  joinStatus: 'joining' | 'peer-slot' | null;
  joinAttempt: number;
}

interface CNSState extends NSState {
  name: string;
  slug: string;
  offline: boolean;
  advanced?: boolean;
  cfg: NSConfig;
}

function makeNSState(): NSState {
  return {
    isRouter: false,
    level: 0,
    registry: {},
    routerPeer: null,
    routerConn: null,
    discPeer: null,
    pingTimer: null,
    monitorTimer: null,
    peerSlotPeer: null,
    peerSlotTimer: null,
    peerSlotProbeTimer: null,
    joinTimeout: null,
    joinStatus: null,
    joinAttempt: 0,
  };
}

// ─── P2PManager ───────────────────────────────────────────────────────────────

export class P2PManager extends EventTarget {
  public friendlyName: string = '';
  public persistentID: string = '';
  public discoveryUUID: string = '';
  public discoveryID: string = '';
  public publicIP: string = '';
  public pubkeyFingerprint: string = '';

  public contacts: Record<string, Contact> = {};
  public chats: Record<string, ChatMessage[]> = {};

  // Public IP namespace state (shared NSState)
  private publicNS: NSState = makeNSState();

  private persPeer: Peer | null = null;

  public persConnected: boolean = false;
  public signalingState: 'connected' | 'reconnecting' | 'offline' = 'offline';
  public lastSignalingTs: number = 0;
  private heartbeatTimer: any = null;
  private connectingPIDs: Set<string> = new Set();
  private connectFailures: Record<string, number> = {};
  private readonly MAX_CONNECT_RETRIES = 3;
  public offlineMode: boolean = false;
  public namespaceOffline: boolean = false;
  private readonly MAX_NAMESPACE = 5;
  private readonly MAX_JOIN_ATTEMPTS = 3;
  private incomingFiles: Record<string, FileTransfer> = {};
  private pendingFiles: Record<string, File[]> = {};

  // ─── Custom Namespaces ─────────────────────────────────────────────────────
  private cns: Map<string, CNSState> = new Map();

  private privateKey: CryptoKey | null = null;
  private publicKey: CryptoKey | null = null;
  private ecdhPrivateKey: CryptoKey | null = null;
  public publicKeyStr: string = '';
  public readonly signalingServer = '0.peerjs.com';
  // Runtime shared key cache: pid → { key, fingerprint }
  private sharedKeys: Map<string, { key: CryptoKey; fingerprint: string }> = new Map();

  // ─── Rendezvous Fallback ──────────────────────────────────────────────────
  private rvzQueue: string[] = [];         // PIDs needing rendezvous
  private rvzActive: string | null = null; // PID currently in rendezvous
  private rvzState: NSState | null = null; // Current rendezvous NSState
  private rvzCfg: NSConfig | null = null;  // Current rendezvous NSConfig
  private rvzSweepTimer: any = null;       // 5-min sweep timer
  private rvzWindowTimer: any = null;      // Time-window expiry timer
  private rvzInitTimer: any = null;        // Initial delayed sweep

  private initPromise: Promise<void> | null = null;
  private wakeLock: any = null;
  private keepAliveTimer: any = null;

  // ─── Backward-compatible getters ───────────────────────────────────────────
  get isRouter() { return this.publicNS.isRouter; }
  get namespaceLevel() { return this.publicNS.level; }
  get registry(): Record<string, PeerInfo> { return this.publicNS.registry; }
  set registry(v: Record<string, PeerInfo>) { this.publicNS.registry = v; }

  // ─── NSConfig factories ────────────────────────────────────────────────────
  private get publicNSConfig(): NSConfig {
    return {
      label: 'public',
      makeRouterID: (level) => makeRouterID(this.publicIP, level),
      makeDiscID: (uuid) => makeDiscID(this.publicIP, uuid),
      makePeerSlotID: () => makePeerSlotID(this.publicIP),
    };
  }

  private makeCNSConfig(s: { name: string; slug: string; advanced?: boolean }): NSConfig {
    const slug = s.slug;
    if (s.advanced) {
      return {
        label: `ns:${s.name}`,
        makeRouterID: (level) => `${slug}-${level}`,
        makeDiscID: (uuid) => `${slug}-${uuid}`,
        makePeerSlotID: () => `${slug}-p1`,
      };
    }
    return {
      label: `ns:${s.name}`,
      makeRouterID: (level) => makeCustomRouterID(slug, level),
      makeDiscID: (uuid) => makeCustomDiscID(slug, uuid),
      makePeerSlotID: () => `${APP_PREFIX}-ns-${slug}-p1`,
    };
  }

  // ─── ECDH shared key derivation ────────────────────────────────────────────

  /** Derive (or retrieve cached) shared AES key for a contact. Returns null if
   *  our ECDH key or their public key is unavailable. */
  private async getOrDeriveSharedKey(pid: string): Promise<{ key: CryptoKey; fingerprint: string } | null> {
    if (!this.ecdhPrivateKey) return null;
    const c = this.contacts[pid];
    if (!c?.publicKey) return null;

    const cached = this.sharedKeys.get(pid);
    if (cached) return cached;

    try {
      const theirECDH = await ecdsaToECDHPublic(c.publicKey);
      const key = await deriveSharedKey(this.ecdhPrivateKey, theirECDH);
      const fingerprint = await fingerprintSharedKey(key);
      const entry = { key, fingerprint };
      this.sharedKeys.set(pid, entry);
      this.log(`Shared key derived for ${c.friendlyName}: ${fingerprint}`, 'ok');
      return entry;
    } catch (e) {
      this.log(`Failed to derive shared key for ${c.friendlyName}: ${e}`, 'err');
      return null;
    }
  }

  /** Public accessor: get shared key fingerprint for a contact (for UI display) */
  public getSharedKeyFingerprint(pid: string): string | null {
    return this.sharedKeys.get(pid)?.fingerprint ?? null;
  }

  /** Export raw shared AES key as base64 (for UI display) */
  public async getSharedKeyExport(pid: string): Promise<string | null> {
    const entry = this.sharedKeys.get(pid);
    if (!entry) return null;
    const raw = await window.crypto.subtle.exportKey('raw', entry.key);
    return arrayBufferToBase64(raw);
  }

  /** Invalidate cached shared key (e.g. if contact's public key changes — shouldn't happen) */
  private clearSharedKey(pid: string) {
    this.sharedKeys.delete(pid);
  }

  constructor() {
    super();
  }

  private async loadState() {
    this.contacts = loadContacts();
    this.chats = loadChats();
    this.friendlyName = localStorage.getItem(`${APP_PREFIX}-name`) || '';
    this.persistentID = localStorage.getItem(`${APP_PREFIX}-pid`) || '';
    this.discoveryUUID = localStorage.getItem(`${APP_PREFIX}-disc-uuid`) || '';

    if (!this.persistentID) {
      this.persistentID = `${APP_PREFIX}-${crypto.randomUUID().replace(/-/g, '')}`;
      localStorage.setItem(`${APP_PREFIX}-pid`, this.persistentID);
    }
    if (!this.discoveryUUID) {
      this.discoveryUUID = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(`${APP_PREFIX}-disc-uuid`, this.discoveryUUID);
    }

    if (!window.crypto?.subtle) {
      this.log('No secure context (not HTTPS) — crypto disabled, identity verification skipped', 'err');
      return;
    }

    const sk = localStorage.getItem(`${APP_PREFIX}-sk`);
    const pk = localStorage.getItem(`${APP_PREFIX}-pk`);

    if (sk && pk) {
      try {
        this.privateKey = await importPrivateKey(sk);
        this.publicKey = await importPublicKey(pk);
        this.publicKeyStr = pk;
        this.pubkeyFingerprint = await this.computeFingerprint(pk);
        this.ecdhPrivateKey = await ecdsaToECDHPrivate(this.privateKey);
        this.log('Loaded cryptographic identity', 'ok');
      } catch (e) {
        this.log('Failed to load keys, regenerating...', 'err');
        await this.generateAndSaveKeys();
      }
    } else {
      await this.generateAndSaveKeys();
    }
  }

  private async generateAndSaveKeys() {
    this.log('Generating new identity keys...', 'info');
    const pair = await generateKeyPair();
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    const sk = await exportPrivateKey(this.privateKey);
    const pk = await exportPublicKey(this.publicKey);
    this.publicKeyStr = pk;
    this.pubkeyFingerprint = await this.computeFingerprint(pk);
    this.ecdhPrivateKey = await ecdsaToECDHPrivate(this.privateKey);
    localStorage.setItem(`${APP_PREFIX}-sk`, sk);
    localStorage.setItem(`${APP_PREFIX}-pk`, pk);
    this.log('Identity keys generated', 'ok');
  }

  public async computeFingerprint(pk: string): Promise<string> {
    if (!window.crypto?.subtle) return '';
    try {
      const bytes = new TextEncoder().encode(pk);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  }

  public init(name: string) {
    this.friendlyName = name;
    localStorage.setItem(`${APP_PREFIX}-name`, name);

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init() {
    await this.loadState();
    this.log('Initializing...', 'info');

    const savedOffline = !!localStorage.getItem(`${APP_PREFIX}-offline`);
    const savedNsOffline = !!localStorage.getItem(`${APP_PREFIX}-ns-offline`);

    if (savedOffline) {
      this.offlineMode = true;
      this.namespaceOffline = true;
      this.signalingState = 'offline';
      this.log('Restored offline mode from previous session', 'info');
      this.emitStatus();
      return;
    }

    this.registerPersistent();
    this.watchNetwork();
    this.startHeartbeat();
    // Request notification permission early so we can notify when backgrounded
    this.requestNotificationPermission();

    this.publicIP = (await getPublicIP()) || '';
    if (!this.publicIP) {
      this.log('Could not detect public IP — manual connect still works', 'err');
      this.emitStatus();
      return;
    }

    this.log(`Public IP: ${this.publicIP}`, 'ok');
    this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);

    if (savedNsOffline) {
      this.namespaceOffline = true;
      this.log('Restored namespace offline from previous session', 'info');
    } else {
      this.attemptNamespace(1);
    }
    this.cnsRestoreSaved();
    this.rvzStart();

    this.emitStatus();
  }

  private watchNetwork() {
    const nc = (navigator as any).connection;
    if (nc) {
      nc.addEventListener('change', () => this.handleNetworkChange());
    }

    window.addEventListener('online', () => {
      this.log('Browser online event', 'info');
      this.handleOnline();
    });
    window.addEventListener('offline', () => {
      this.log('Browser offline event', 'err');
      this.persConnected = false;
      this.emitStatus();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.log('App foregrounded — checking connections', 'info');
        this.handleOnline();
        this.acquireWakeLock();
      }
    });

    this.startKeepAlive();
  }

  // ─── Keep-alive: prevent browser from suspending the page ──────────────

  private startKeepAlive() {
    // Web Lock API — prevents browser from freezing the page when backgrounded.
    // The lock is held as long as the promise is pending (forever until page closes).
    if (navigator.locks) {
      navigator.locks.request(`${APP_PREFIX}-keepalive`, () => {
        this.log('Web Lock acquired — page will stay alive in background', 'ok');
        return new Promise(() => {}); // never resolves — holds the lock
      }).catch(() => {});
    }

    // Wake Lock API — prevents screen from sleeping (released when hidden, reacquired on visible)
    this.acquireWakeLock();

    // Periodic signaling ping — re-registers with PeerJS server if connection drifted.
    // Mobile browsers may let WebSocket idle-timeout; this forces activity every 45s.
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.offlineMode) return;
      if (this.persPeer && !this.persPeer.destroyed && !this.persPeer.disconnected) {
        // PeerJS socket is alive — send a lightweight probe to keep it active.
        // persPeer.socket is internal but we can trigger activity via a self-check.
        const sock = (this.persPeer as any).socket;
        if (sock && typeof sock.send === 'function') {
          try { sock.send({ type: 'HEARTBEAT' }); } catch {}
        }
      } else if (this.persPeer?.disconnected && !this.reconnectScheduled) {
        this.log('Keep-alive: signaling drifted — reconnecting', 'info');
        this.schedulePersReconnect();
      }
    }, 45000);
  }

  private async acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    // Only acquire when page is visible (API requirement)
    if (document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await (navigator as any).wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch {}
  }

  /** Request notification permission (needed for background awareness on mobile PWAs) */
  public async requestNotificationPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    this.log(`Notification permission: ${result}`, result === 'granted' ? 'ok' : 'info');
    return result === 'granted';
  }

  /** Show a browser notification. Always fires when permission granted — the in-app
   *  toast system separately handles suppression for the active chat. */
  private async notify(title: string, body: string, tag?: string) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    // Don't notify if user is actively viewing the app
    if (document.visibilityState === 'visible' && document.hasFocus()) return;

    const opts: NotificationOptions = {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || `${APP_PREFIX}-${Date.now()}`,
      renotify: !!tag,
    };

    // Prefer Service Worker notifications (required on Android Chrome / mobile PWAs)
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, opts);
        return;
      } catch (e) {
        this.log(`SW notification failed, falling back: ${e}`, 'err');
      }
    }

    // Fallback: direct Notification API (desktop browsers)
    try {
      const n = new Notification(title, opts);
      setTimeout(() => n.close(), 6000);
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch (e) {
      this.log(`Notification failed: ${e}`, 'err');
    }
  }

  private async handleNetworkChange() {
    if (this.offlineMode) return;
    const nc = (navigator as any).connection;
    const type = nc?.type || nc?.effectiveType || 'unknown';
    this.log(`Network type changed → ${type}`, 'info');

    // Invalidate all contact DataConnections — they're dead after network change
    Object.keys(this.contacts).forEach(pid => {
      if (this.contacts[pid].conn) {
        try { this.contacts[pid].conn.close(); } catch {}
        this.contacts[pid].conn = null;
      }
    });
    this.resetUnackedMessages();
    this.emitPeerListUpdate();

    if (this.persPeer && !this.persPeer.destroyed) {
      this.reconnectBackoff = 0;
      this.signalingState = 'reconnecting';
      this.emitStatus();
      try {
        if (!this.persPeer.disconnected) this.persPeer.disconnect();
        this.persPeer.reconnect();
      } catch {
        this.persPeer.destroy();
        this.persPeer = null;
        this.registerPersistent();
      }
    } else {
      this.handleOnline();
    }

    if (!this.publicIP) return;

    const newIP = await getPublicIP();
    if (!newIP) {
      this.log('IP undetectable after network change', 'err');
      return;
    }
    if (newIP !== this.publicIP) {
      this.log(`IP changed ${this.publicIP} → ${newIP} — refailing discovery`, 'info');
      this.publicIP = newIP;
      this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
      this.emitStatus();
      this.failover();
    } else {
      this.log('Same IP — rejoining discovery', 'ok');
      if (!this.publicNS.isRouter && (!this.publicNS.routerConn || !this.publicNS.routerConn.open)) {
        this.tryJoinNamespace(this.publicNS.level || 1);
      }
    }

    // Restart non-offline custom namespaces
    this.cns.forEach((s) => {
      if (s.offline) return;
      this.nsTeardown(s);
      s.level = 0; s.isRouter = false;
      const myEntry = Object.values(s.registry).find(r => r.isMe);
      s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      setTimeout(() => this.nsAttempt(s, s.cfg, 1), Math.random() * 3000);
    });
  }

  private emitStatus() {
    const level = this.publicNS.level;
    const roleLabel = level > 0
      ? (this.publicNS.isRouter ? `Router L${level}` : `Peer L${level}`)
      : (this.publicNS.isRouter ? 'Router' : 'Peer');

    this.dispatchEvent(
      new CustomEvent('status-change', {
        detail: {
          status: this.publicIP ? 'online' : 'offline',
          role: roleLabel,
          ip: this.publicIP,
          did: this.discoveryID,
          pid: this.persistentID,
          namespaceLevel: this.publicNS.level,
          pubkeyFingerprint: this.pubkeyFingerprint,
          persConnected: this.persConnected,
          signalingState: this.signalingState,
          lastSignalingTs: this.lastSignalingTs,
          reconnectAttempt: this.reconnectBackoff,
          joinStatus: this.publicNS.joinStatus,
          joinAttempt: this.publicNS.joinAttempt,
        },
      })
    );
  }

  private log(msg: string, type: string = 'info') {
    console.log(`[P2P:${type}] ${msg}`);
    this.dispatchEvent(new CustomEvent('log', { detail: { msg, type } }));
  }

  private registerPersistent() {
    if (this.persPeer && !this.persPeer.destroyed) return;

    this.persPeer = new Peer(this.persistentID);

    this.persPeer.on('open', (id) => {
      this.persConnected = true;
      this.signalingState = 'connected';
      this.lastSignalingTs = Date.now();
      this.reconnectBackoff = 0;
      this.reconnectScheduled = false;
      this.log(`Persistent ID registered: ${id}`, 'ok');
      this.emitStatus();
      this.reconnectOfflineContacts();
    });

    this.persPeer.on('disconnected', () => {
      this.persConnected = false;
      this.signalingState = 'reconnecting';
      this.log('Persistent peer lost signaling connection — reconnecting...', 'err');
      this.emitStatus();
      this.schedulePersReconnect();
    });

    this.persPeer.on('close', () => {
      this.persConnected = false;
      this.log('Persistent peer closed — recreating...', 'err');
      this.emitStatus();
      this.persPeer = null;
      setTimeout(() => this.registerPersistent(), 3000);
    });

    this.persPeer.on('connection', (conn) => {
      conn.on('data', (d) => this.handlePersistentData(d, conn));
      conn.on('close', () => {
        const pid = Object.keys(this.contacts).find((k) => this.contacts[k].conn === conn);
        if (pid) {
          this.contacts[pid].conn = null;
          this.emitPeerListUpdate();
        }
      });
    });

    this.persPeer.on('call', (call) => this.handleIncomingCall(call));
    this.persPeer.on('error', (e: any) => {
      // peer-unavailable errors bubble up from outgoing connect() calls (e.g. peer slot probes,
      // contact reconnects) — they're expected and handled at the DataConnection level already.
      if (e.type === 'peer-unavailable') return;
      this.log(`Persistent peer error: ${e.type}`, 'err');
      if (e.type === 'unavailable-id') {
        this.log('Persistent ID claimed — generating new one', 'err');
        this.persistentID = `${APP_PREFIX}-${crypto.randomUUID().replace(/-/g, '')}`;
        localStorage.setItem(`${APP_PREFIX}-pid`, this.persistentID);
        this.persPeer?.destroy();
        this.persPeer = null;
        setTimeout(() => this.registerPersistent(), 1000);
      }
    });
  }

  private reconnectBackoff = 0;

  public setOfflineMode(offline: boolean) {
    this.offlineMode = offline;
    localStorage.setItem(`${APP_PREFIX}-offline`, offline ? '1' : '');
    this.log(offline ? 'Offline mode — all connections paused' : 'Going online...', 'info');
    if (offline) {
      this.setNamespaceOffline(true);
      this.rvzTeardown();
      if (this.persPeer && !this.persPeer.destroyed && !this.persPeer.disconnected) {
        try { this.persPeer.disconnect(); } catch {}
      }
      this.persConnected = false;
      this.signalingState = 'offline';
      this.emitStatus();
    } else {
      this.namespaceOffline = false;
      localStorage.setItem(`${APP_PREFIX}-ns-offline`, '');
      this.signalingState = 'reconnecting';
      this.handleOnline();
    }
  }

  public setNamespaceOffline(offline: boolean) {
    this.namespaceOffline = offline;
    localStorage.setItem(`${APP_PREFIX}-ns-offline`, offline ? '1' : '');
    if (offline) {
      // Teardown public NS but keep discPeer alive
      if (this.publicNS.monitorTimer) { clearInterval(this.publicNS.monitorTimer); this.publicNS.monitorTimer = null; }
      if (this.publicNS.pingTimer) { clearInterval(this.publicNS.pingTimer); this.publicNS.pingTimer = null; }
      if (this.publicNS.peerSlotProbeTimer) { clearInterval(this.publicNS.peerSlotProbeTimer); this.publicNS.peerSlotProbeTimer = null; }
      if (this.publicNS.peerSlotPeer && !this.publicNS.peerSlotPeer.destroyed) { try { this.publicNS.peerSlotPeer.destroy(); } catch {} this.publicNS.peerSlotPeer = null; }
      if (this.publicNS.peerSlotTimer) { clearTimeout(this.publicNS.peerSlotTimer); this.publicNS.peerSlotTimer = null; }
      if (this.publicNS.routerPeer) { this.publicNS.routerPeer.destroy(); this.publicNS.routerPeer = null; }
      // Keep discPeer alive — destroying it releases our disc ID on PeerJS server
      if (this.publicNS.routerConn) { this.publicNS.routerConn.close(); this.publicNS.routerConn = null; }
      this.publicNS.isRouter = false;
      this.publicNS.level = 0;
      const myEntry = Object.values(this.publicNS.registry).find(r => r.isMe);
      this.publicNS.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      this.emitPeerListUpdate();
      this.emitStatus();
      this.log('Namespace discovery paused', 'info');
    } else {
      if (this.publicIP) {
        this.log('Rejoining namespace...', 'info');
        this.attemptNamespace(1);
      }
    }
  }

  private findContactByPublicKey(publicKey: string, excludePID?: string): string | null {
    return Object.keys(this.contacts).find(
      k => k !== excludePID && !!this.contacts[k].publicKey && this.contacts[k].publicKey === publicKey
    ) ?? null;
  }

  private migrateContact(oldPID: string, newPID: string) {
    if (oldPID === newPID) return;
    const existing = this.contacts[oldPID];
    if (!this.contacts[newPID]) {
      this.contacts[newPID] = { ...existing, conn: null };
    } else {
      // Preserve fields from old contact that new one might lack
      if (existing.publicKey && !this.contacts[newPID].publicKey) {
        this.contacts[newPID].publicKey = existing.publicKey;
      }
    }
    // Merge chat histories (concatenate + deduplicate by id, sort by timestamp)
    if (this.chats[oldPID]) {
      if (!this.chats[newPID]) {
        this.chats[newPID] = this.chats[oldPID];
      } else {
        const existingIds = new Set(this.chats[newPID].map(m => m.id));
        const newMsgs = this.chats[oldPID].filter(m => !existingIds.has(m.id));
        this.chats[newPID] = [...this.chats[newPID], ...newMsgs].sort((a, b) => a.ts - b.ts);
      }
      delete this.chats[oldPID];
    }
    // Migrate shared key
    const oldSK = this.sharedKeys.get(oldPID);
    if (oldSK && !this.sharedKeys.has(newPID)) {
      this.sharedKeys.set(newPID, oldSK);
    }
    this.sharedKeys.delete(oldPID);

    delete this.contacts[oldPID];
    saveContacts(this.contacts);
    saveChats(this.chats);
    this.log(`Contact migrated: ${oldPID.slice(-8)} → ${newPID.slice(-8)}`, 'info');

    // Notify UI to redirect activeChat if needed
    this.dispatchEvent(new CustomEvent('contact-migrated', { detail: { oldPID, newPID } }));
  }

  private schedulePersReconnect() {
    if (this.offlineMode || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectBackoff), 30000) + Math.random() * 1000;
    this.reconnectBackoff = Math.min(this.reconnectBackoff + 1, 5);
    this.log(`Scheduling reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectBackoff})`, 'info');
    setTimeout(() => {
      this.reconnectScheduled = false;
      if (!this.persPeer || this.persPeer.destroyed) {
        this.persPeer = null;
        this.registerPersistent();
      } else if (this.persPeer.disconnected) {
        try {
          this.persPeer.reconnect();
        } catch {
          this.persPeer.destroy();
          this.persPeer = null;
          this.registerPersistent();
        }
      }
    }, delay);
  }

  private handleOnline() {
    if (this.offlineMode) return;
    this.log('Connectivity change — checking persistent peer...', 'info');
    if (!this.persPeer || this.persPeer.destroyed) {
      this.persPeer = null;
      this.registerPersistent();
    } else if (this.persPeer.disconnected) {
      this.reconnectBackoff = 0;
      try {
        this.persPeer.reconnect();
      } catch {
        this.persPeer.destroy();
        this.persPeer = null;
        this.registerPersistent();
      }
    }
    if (this.publicIP && !this.namespaceOffline && !this.publicNS.isRouter && (!this.publicNS.routerConn || !this.publicNS.routerConn.open)) {
      setTimeout(() => this.tryJoinNamespace(this.publicNS.level || 1), 1500);
    }
  }

  private reconnectOfflineContacts() {
    if (!this.persPeer || this.persPeer.destroyed || this.persPeer.disconnected) return;
    const pids = Object.keys(this.contacts).filter(
      pid => !this.contacts[pid].conn?.open && !this.connectingPIDs.has(pid)
    );
    if (pids.length === 0) return;
    this.log(`Reconnecting to ${pids.length} offline contact(s)...`, 'info');
    pids.forEach(pid => {
      if (this.contacts[pid].conn && !this.contacts[pid].conn.open) {
        this.contacts[pid].conn = null;
      }
      this.connectPersistent(pid, this.contacts[pid].friendlyName);
    });
  }

  private reconnectScheduled = false;

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.offlineMode) return;
      const connected = this.persPeer != null && !this.persPeer.destroyed && !this.persPeer.disconnected;
      if (connected !== this.persConnected) {
        this.persConnected = connected;
        this.emitStatus();
      }
      if (!connected && this.persPeer && !this.persPeer.destroyed && !this.reconnectScheduled) {
        this.log('Heartbeat: signaling lost — reconnecting', 'info');
        this.schedulePersReconnect();
      }
    }, 20000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Shared Namespace Routing Core (ns* methods) ═══════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // All namespace types (public IP, custom) use these methods.
  // They operate on an NSState object + NSConfig closures.

  private nsEmit(s: NSState) {
    this.emitPeerListUpdate();
    if (s === this.publicNS) {
      this.emitStatus();
    } else {
      this.dispatchEvent(new CustomEvent('custom-ns-update'));
    }
  }

  private nsAttempt(s: NSState, cfg: NSConfig, level: number) {
    if (s !== this.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || this.offlineMode) return;
    } else {
      if (this.namespaceOffline) return;
    }
    if (!this.persPeer || this.persPeer.destroyed) return;
    if (level > this.MAX_NAMESPACE) {
      this.log(`[${cfg.label}] All namespace levels exhausted (1–${this.MAX_NAMESPACE}) — discovery offline`, 'err');
      return;
    }

    const rid = cfg.makeRouterID(level);
    this.log(`[${cfg.label}] Attempting router election at level ${level}: ${rid}`, 'info');

    if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }

    s.routerPeer = new Peer(rid);

    s.routerPeer.on('open', (id) => {
      // For CNS: check if still in map
      if (s !== this.publicNS) {
        const cs = s as CNSState;
        if (!this.cns.has(cs.slug)) { s.routerPeer?.destroy(); return; }
      }
      s.isRouter = true;
      s.level = level;
      s.joinStatus = null;
      s.joinAttempt = 0;
      this.log(`[${cfg.label}] Elected as router at level ${level}: ${id}`, 'ok');
      s.routerPeer?.on('connection', (conn) => this.nsHandleRouterConn(s, cfg, conn));
      this.nsStartPingTimer(s, cfg);
      this.nsRegisterDisc(s, cfg);
      // Start peer slot probe (router probes for EDM NAT peers)
      this.nsStartPeerSlotProbe(s, cfg);
      if (level > 1) {
        this.nsStartMonitor(s, cfg);
      }
      this.nsEmit(s);
    });

    s.routerPeer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') {
        this.log(`[${cfg.label}] Level ${level} router slot taken — trying to join`, 'info');
        s.routerPeer = null;
        this.nsTryJoin(s, cfg, level);
      } else {
        this.log(`[${cfg.label}] Router election error at level ${level}: ${e.type}`, 'err');
      }
    });
  }

  private nsTryJoin(s: NSState, cfg: NSConfig, level: number, attempt: number = 0) {
    if (s !== this.publicNS) {
      const cs = s as CNSState;
      if (cs.offline || this.offlineMode) return;
    }
    if (!this.persPeer || this.persPeer.destroyed) return;

    const rid = cfg.makeRouterID(level);
    this.log(`[${cfg.label}] Connecting to level ${level} router (attempt ${attempt + 1}/${this.MAX_JOIN_ATTEMPTS}): ${rid}`, 'info');

    if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
    if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }

    s.joinStatus = 'joining';
    s.joinAttempt = attempt + 1;
    this.nsEmit(s);

    s.routerConn = this.persPeer.connect(rid, { reliable: true });
    let connected = false;
    let settled = false; // prevent double-fire from timeout + error

    // Timeout: if connection hangs (NAT blocks WebRTC), treat as error
    s.joinTimeout = setTimeout(() => {
      if (settled || connected) return;
      settled = true;
      this.log(`[${cfg.label}] Join timeout at level ${level} (attempt ${attempt + 1}) — connection hung`, 'err');
      try { s.routerConn?.close(); } catch {}
      s.routerConn = null;
      if (attempt + 1 < this.MAX_JOIN_ATTEMPTS) {
        setTimeout(() => this.nsTryJoin(s, cfg, level, attempt + 1), 1500);
      } else {
        this.nsTryPeerSlot(s, cfg, level);
      }
    }, 8000);

    s.routerConn.on('open', () => {
      connected = true;
      settled = true;
      if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }
      s.joinStatus = null;
      s.joinAttempt = 0;
      s.isRouter = false;
      s.level = level;
      const discID = cfg.makeDiscID(this.discoveryUUID);
      s.routerConn?.send({
        type: 'checkin',
        discoveryID: discID,
        friendlyname: this.friendlyName,
        publicKey: this.publicKeyStr,
      });
      this.log(`[${cfg.label}] Checked in to level ${level} router`, 'ok');
      this.nsRegisterDisc(s, cfg);
      if (level > 1) {
        this.nsStartMonitor(s, cfg);
      }
      this.nsEmit(s);
    });

    s.routerConn.on('data', (d: any) => {
      if (d.type === 'registry') this.nsMergeRegistry(s, cfg, d.peers);
      if (d.type === 'ping') s.routerConn?.send({ type: 'pong' });
      if (d.type === 'migrate') {
        this.log(`[${cfg.label}] Router signaling migration to level ${d.level}`, 'info');
        this.nsMigrate(s, cfg, d.level);
      }
    });

    s.routerConn.on('close', () => {
      if (!connected) return;
      this.log(`[${cfg.label}] Router disconnected — failing over`, 'err');
      s.routerConn = null;
      this.nsClearMonitor(s);
      this.nsFailover(s, cfg);
    });

    s.routerConn.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }
      this.log(`[${cfg.label}] Join error at level ${level}: ${err.type}`, 'err');
      s.routerConn = null;
      if (attempt + 1 < this.MAX_JOIN_ATTEMPTS) {
        setTimeout(() => this.nsTryJoin(s, cfg, level, attempt + 1), 1500);
      } else {
        // Try peer slot before escalating
        this.nsTryPeerSlot(s, cfg, level);
      }
    });
  }

  private nsHandleRouterConn(s: NSState, cfg: NSConfig, conn: DataConnection) {
    conn.on('data', (d: any) => {
      if (d.type === 'checkin') {
        const uuid = extractDiscUUID(d.discoveryID);

        // Dedup: remove stale entry for same device (same public key)
        if (d.publicKey) {
          const staleKey = Object.keys(s.registry).find(did =>
            did !== d.discoveryID && !!s.registry[did].publicKey && s.registry[did].publicKey === d.publicKey
          );
          if (staleKey) {
            this.log(`[${cfg.label}] Replaced stale disc entry: …${staleKey.slice(-8)} → …${d.discoveryID.slice(-8)}`, 'info');
            delete s.registry[staleKey];
          }
        }

        // Match existing contact by public key first, then by discoveryUUID
        const knownPID = Object.keys(this.contacts).find((pid) => {
          const c = this.contacts[pid];
          if (d.publicKey && c.publicKey && c.publicKey === d.publicKey) return true;
          return c.discoveryUUID === uuid;
        });

        if (knownPID) {
          this.contacts[knownPID].onNetwork = true;
          this.contacts[knownPID].networkDiscID = d.discoveryID;
        }

        s.registry[d.discoveryID] = {
          discoveryID: d.discoveryID,
          friendlyName: d.friendlyname,
          lastSeen: Date.now(),
          conn,
          knownPID: knownPID || null,
          publicKey: d.publicKey || undefined,
        };
        this.log(`[${cfg.label}] Peer checked in at L${s.level}: ${d.discoveryID}`, 'ok');
        this.nsBroadcast(s, cfg);
        this.nsEmit(s);
      }
      if (d.type === 'pong') {
        const key = Object.keys(s.registry).find((k) => s.registry[k].conn === conn);
        if (key) s.registry[key].lastSeen = Date.now();
      }
    });
    conn.on('close', () => {
      const key = Object.keys(s.registry).find((k) => s.registry[k].conn === conn);
      if (key) {
        delete s.registry[key];
        this.nsBroadcast(s, cfg);
        this.nsEmit(s);
      }
    });
  }

  private nsBroadcast(s: NSState, _cfg: NSConfig) {
    const peers = Object.keys(s.registry).map((did) => ({
      discoveryID: did,
      friendlyname: s.registry[did].friendlyName,
      publicKey: s.registry[did].publicKey,
    }));
    Object.values(s.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try {
          r.conn.send({ type: 'registry', peers });
        } catch {}
      }
    });
  }

  private nsMergeRegistry(s: NSState, cfg: NSConfig, peers: any[]) {
    this.log(`[${cfg.label}] Registry update: ${peers.length} peers`, 'info');
    const myDiscID = cfg.makeDiscID(this.discoveryUUID);

    const newRegistry: Record<string, PeerInfo> = {};
    const myEntry = Object.values(s.registry).find(r => r.isMe);
    if (myEntry) newRegistry[myEntry.discoveryID] = myEntry;

    // Reset all contacts onNetwork before rebuild — only for public NS
    if (s === this.publicNS) {
      Object.keys(this.contacts).forEach((pid) => {
        this.contacts[pid].onNetwork = false;
        this.contacts[pid].networkDiscID = null;
      });
    }

    peers.forEach((p) => {
      if (p.discoveryID === myDiscID) return;

      const uuid = extractDiscUUID(p.discoveryID);

      // Dedup: if we already have an entry for this same public key, remove older one
      if (p.publicKey) {
        const staleKey = Object.keys(newRegistry).find(did =>
          did !== p.discoveryID && !newRegistry[did].isMe && !!newRegistry[did].publicKey && newRegistry[did].publicKey === p.publicKey
        );
        if (staleKey) delete newRegistry[staleKey];
      }

      // Match by publicKey OR discoveryUUID
      const knownPID = Object.keys(this.contacts).find((pid) => {
        const c = this.contacts[pid];
        if (p.publicKey && c.publicKey && c.publicKey === p.publicKey) return true;
        return c.discoveryUUID === uuid;
      });

      if (knownPID) {
        this.contacts[knownPID].onNetwork = true;
        this.contacts[knownPID].networkDiscID = p.discoveryID;
        // Store public key if we receive it for the first time
        if (p.publicKey && !this.contacts[knownPID].publicKey) {
          this.contacts[knownPID].publicKey = p.publicKey;
          saveContacts(this.contacts);
        }
      }

      newRegistry[p.discoveryID] = {
        discoveryID: p.discoveryID,
        friendlyName: p.friendlyname,
        lastSeen: Date.now(),
        knownPID: knownPID || null,
        publicKey: p.publicKey || undefined,
      };
    });

    s.registry = newRegistry;
    this.nsEmit(s);
    // Check rendezvous registry for target contact
    if (s === this.rvzState) this.rvzCheckRegistry(s);
  }

  private nsStartPingTimer(s: NSState, cfg: NSConfig) {
    if (s.pingTimer) clearInterval(s.pingTimer);
    s.pingTimer = setInterval(() => {
      const now = Date.now();
      Object.keys(s.registry).forEach((did) => {
        const r = s.registry[did];
        if (r.isMe) return;
        if (r.conn) {
          try { r.conn.send({ type: 'ping' }); } catch {}
        }
        if (now - r.lastSeen > TTL + 10000) {
          this.log(`[${cfg.label}] Peer timed out: ${did}`, 'err');
          delete s.registry[did];
          this.nsBroadcast(s, cfg);
          this.nsEmit(s);
        }
      });
    }, PING_IV);
  }

  private nsRegisterDisc(s: NSState, cfg: NSConfig) {
    const discID = cfg.makeDiscID(this.discoveryUUID);

    // Reuse existing discPeer if still alive
    if (s.discPeer && !s.discPeer.destroyed) {
      if (!s.registry[discID]) {
        s.registry[discID] = {
          discoveryID: discID,
          friendlyName: this.friendlyName,
          lastSeen: Date.now(),
          isMe: true,
          publicKey: this.publicKeyStr || undefined,
        };
      }
      if (s.isRouter) this.nsBroadcast(s, cfg);
      this.nsEmit(s);
      return;
    }

    // Destroy old discPeer before creating new
    if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }

    s.discPeer = new Peer(discID);
    s.discPeer.on('open', (id) => {
      this.log(`[${cfg.label}] Discovery ID: ${id}`, 'ok');
      s.registry[id] = {
        discoveryID: id,
        friendlyName: this.friendlyName,
        lastSeen: Date.now(),
        isMe: true,
        publicKey: this.publicKeyStr || undefined,
      };

      if (s.isRouter) {
        this.nsBroadcast(s, cfg);
      }
      this.nsEmit(s);
    });

    s.discPeer.on('connection', (conn) => {
      conn.on('data', (d) => this.handleDiscData(d, conn));
    });

    s.discPeer.on('error', (e: any) => {
      this.log(`[${cfg.label}] Discovery error: ${e.type}`, 'err');
      if (e.type === 'unavailable-id') {
        // UUID collision — regenerate
        this.discoveryUUID = crypto.randomUUID().replace(/-/g, '');
        localStorage.setItem(`${APP_PREFIX}-disc-uuid`, this.discoveryUUID);
        if (s === this.publicNS) {
          this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
        }
        this.nsRegisterDisc(s, cfg);
      }
    });
  }

  private nsStartMonitor(s: NSState, cfg: NSConfig) {
    this.nsClearMonitor(s);
    s.monitorTimer = setInterval(() => this.nsProbeLevel1(s, cfg), 30000);
  }

  private nsClearMonitor(s: NSState) {
    if (s.monitorTimer) {
      clearInterval(s.monitorTimer);
      s.monitorTimer = null;
    }
  }

  private nsProbeLevel1(s: NSState, cfg: NSConfig) {
    if (s.level <= 1) return;
    if (s !== this.publicNS) {
      const cs = s as CNSState;
      if (cs.offline) return;
    } else {
      if (!this.publicIP) return;
    }

    const rid = cfg.makeRouterID(1);
    const peer = s.discPeer || this.persPeer;
    if (!peer) return;

    this.log(`[${cfg.label}] Probing level 1 namespace availability...`, 'info');

    const testConn = peer.connect(rid, { reliable: true });
    let settled = false;

    const resolve = (routerFound: boolean) => {
      if (settled) return;
      settled = true;
      try { testConn.close(); } catch {}

      if (routerFound) {
        this.log(`[${cfg.label}] Level 1 router live — migrating from level ${s.level}`, 'info');
        if (s.isRouter) {
          this.nsBroadcastMigration(s, 1);
          setTimeout(() => this.nsMigrate(s, cfg, 1), 600);
        } else {
          this.nsMigrate(s, cfg, 1);
        }
      } else {
        // Level 1 is unclaimed
        if (s.isRouter) {
          this.log(`[${cfg.label}] Level 1 unclaimed — reclaiming from level ${s.level}`, 'info');
          this.nsBroadcastMigration(s, 1);
          setTimeout(() => {
            this.nsClearMonitor(s);
            if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }
            if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }
            if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
            // Clear peer slot state
            if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
            if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
            if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
            s.isRouter = false;
            s.level = 0;
            const myEntry = Object.values(s.registry).find(r => r.isMe);
            s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
            this.nsEmit(s);
            this.nsAttempt(s, cfg, 1);
          }, 600);
        }
      }
    };

    testConn.on('open', () => resolve(true));
    testConn.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 4000);
  }

  private nsBroadcastMigration(s: NSState, level: number) {
    Object.values(s.registry).forEach((r) => {
      if (r.conn && !r.isMe) {
        try { r.conn.send({ type: 'migrate', level }); } catch {}
      }
    });
  }

  private nsMigrate(s: NSState, cfg: NSConfig, targetLevel: number) {
    this.log(`[${cfg.label}] Migrating to level ${targetLevel}`, 'info');
    this.nsClearMonitor(s);
    if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
    if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }
    if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }
    // Clear peer slot state
    if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
    if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
    if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
    s.isRouter = false;
    s.level = 0;
    const myEntry = Object.values(s.registry).find(r => r.isMe);
    s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
    this.nsEmit(s);
    setTimeout(() => this.nsAttempt(s, cfg, targetLevel), Math.random() * 2000);
  }

  private nsFailover(s: NSState, cfg: NSConfig) {
    if (s === this.publicNS && this.namespaceOffline) return;
    if (s !== this.publicNS) {
      const cs = s as CNSState;
      if (cs.offline) return;
    }

    const jitter = Math.random() * 3000;
    this.log(`[${cfg.label}] Failover in ${(jitter / 1000).toFixed(1)}s — restarting from L1`, 'info');
    this.nsClearMonitor(s);
    setTimeout(() => {
      if (s.routerPeer) { s.routerPeer.destroy(); s.routerPeer = null; }
      if (s.discPeer) { s.discPeer.destroy(); s.discPeer = null; }
      if (s.routerConn) { s.routerConn.close(); s.routerConn = null; }
      // Clear peer slot state
      if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
      if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
      if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
      s.isRouter = false;
      s.level = 0;

      const myEntry = Object.values(s.registry).find(r => r.isMe);
      s.registry = myEntry ? { [myEntry.discoveryID]: myEntry } : {};
      this.nsEmit(s);

      if (s === this.publicNS) {
        this.discoveryID = makeDiscID(this.publicIP, this.discoveryUUID);
      }
      this.nsAttempt(s, cfg, 1);
    }, jitter);
  }

  private nsTeardown(s: NSState, keepDisc = false) {
    if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
    if (s.monitorTimer) { clearInterval(s.monitorTimer); s.monitorTimer = null; }
    if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); s.peerSlotProbeTimer = null; }
    if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} s.peerSlotPeer = null; }
    if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }
    if (s.joinTimeout) { clearTimeout(s.joinTimeout); s.joinTimeout = null; }
    s.joinStatus = null;
    s.joinAttempt = 0;
    if (s.routerPeer && !s.routerPeer.destroyed) { try { s.routerPeer.destroy(); } catch {} s.routerPeer = null; }
    if (s.routerConn) { try { s.routerConn.close(); } catch {} s.routerConn = null; }
    if (!keepDisc && s.discPeer && !s.discPeer.destroyed) { try { s.discPeer.destroy(); } catch {} s.discPeer = null; }
  }

  // ─── EDM NAT Reverse-Connect (-p1 peer slot) ──────────────────────────────

  /** Peer side: claim the -p1 slot and wait for router to connect */
  private nsTryPeerSlot(s: NSState, cfg: NSConfig, level: number) {
    const slotID = cfg.makePeerSlotID();
    this.log(`[${cfg.label}] Trying peer slot (-p1 reverse connect): ${slotID}`, 'info');

    // Clean up any previous peer slot attempt
    if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) { try { s.peerSlotPeer.destroy(); } catch {} }
    if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }

    s.joinStatus = 'peer-slot';
    s.joinAttempt = 0;
    this.nsEmit(s);

    s.peerSlotPeer = new Peer(slotID);

    s.peerSlotPeer.on('open', () => {
      this.log(`[${cfg.label}] Peer slot claimed — waiting for router probe`, 'info');

      // Listen for incoming connection from router
      s.peerSlotPeer?.on('connection', (conn: DataConnection) => {
        conn.on('data', (d: any) => {
          if (d.type === 'reverse-welcome') {
            this.log(`[${cfg.label}] Router probed our peer slot — checking in via reverse connect`, 'ok');
            const discID = cfg.makeDiscID(this.discoveryUUID);
            conn.send({
              type: 'checkin',
              discoveryID: discID,
              friendlyname: this.friendlyName,
              publicKey: this.publicKeyStr,
            });

            // Use this connection as our router connection
            s.routerConn = conn;
            s.isRouter = false;
            s.level = level;
            s.joinStatus = null;
            s.joinAttempt = 0;
            this.nsRegisterDisc(s, cfg);

            conn.on('data', (d2: any) => {
              if (d2.type === 'registry') this.nsMergeRegistry(s, cfg, d2.peers);
              if (d2.type === 'ping') conn.send({ type: 'pong' });
              if (d2.type === 'migrate') {
                this.log(`[${cfg.label}] Router signaling migration to level ${d2.level}`, 'info');
                this.nsMigrate(s, cfg, d2.level);
              }
            });

            conn.on('close', () => {
              this.log(`[${cfg.label}] Reverse-connect router dropped — failing over`, 'err');
              s.routerConn = null;
              this.nsClearMonitor(s);
              this.nsFailover(s, cfg);
            });

            // Destroy the peer slot peer to free the -p1 slot for next peer
            if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) {
              try { s.peerSlotPeer.destroy(); } catch {}
            }
            s.peerSlotPeer = null;
            if (s.peerSlotTimer) { clearTimeout(s.peerSlotTimer); s.peerSlotTimer = null; }

            this.nsEmit(s);
          }
        });
      });

      // 30s timeout: give up and escalate
      s.peerSlotTimer = setTimeout(() => {
        this.log(`[${cfg.label}] Peer slot timeout — escalating to level ${level + 1}`, 'info');
        if (s.peerSlotPeer && !s.peerSlotPeer.destroyed) {
          try { s.peerSlotPeer.destroy(); } catch {}
        }
        s.peerSlotPeer = null;
        s.peerSlotTimer = null;
        s.joinStatus = null;
        s.joinAttempt = 0;
        this.nsAttempt(s, cfg, level + 1);
      }, 30000);
    });

    s.peerSlotPeer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') {
        // Slot occupied by another peer — retry in 3-5s
        this.log(`[${cfg.label}] Peer slot occupied — retrying`, 'info');
        s.peerSlotPeer = null;
        s.peerSlotTimer = setTimeout(() => {
          s.peerSlotTimer = null;
          this.nsTryPeerSlot(s, cfg, level);
        }, 3000 + Math.random() * 2000);
      } else {
        // Other error — escalate
        this.log(`[${cfg.label}] Peer slot error: ${e.type} — escalating`, 'err');
        s.peerSlotPeer = null;
        this.nsAttempt(s, cfg, level + 1);
      }
    });
  }

  /** Router side: start continuously probing the -p1 slot */
  private nsStartPeerSlotProbe(s: NSState, cfg: NSConfig) {
    if (s.peerSlotProbeTimer) { clearInterval(s.peerSlotProbeTimer); }
    s.peerSlotProbeTimer = setInterval(() => this.nsProbePeerSlot(s, cfg), 5000);
  }

  /** Router side: single probe of the -p1 slot */
  private nsProbePeerSlot(s: NSState, cfg: NSConfig) {
    if (!this.persPeer || this.persPeer.destroyed || this.persPeer.disconnected) return;
    if (!s.isRouter) return;

    const slotID = cfg.makePeerSlotID();
    const conn = this.persPeer.connect(slotID, { reliable: true });

    const timeout = setTimeout(() => {
      try { conn.close(); } catch {}
    }, 5000);

    conn.on('open', () => {
      conn.send({ type: 'reverse-welcome' });

      conn.on('data', (d: any) => {
        clearTimeout(timeout);
        if (d.type === 'checkin') {
          this.log(`[${cfg.label}] Reverse-connect peer checked in: ${d.discoveryID}`, 'ok');

          const uuid = extractDiscUUID(d.discoveryID);

          // Dedup by public key
          if (d.publicKey) {
            const staleKey = Object.keys(s.registry).find(did =>
              did !== d.discoveryID && !!s.registry[did].publicKey && s.registry[did].publicKey === d.publicKey
            );
            if (staleKey) {
              delete s.registry[staleKey];
            }
          }

          const knownPID = Object.keys(this.contacts).find((pid) => {
            const c = this.contacts[pid];
            if (d.publicKey && c.publicKey && c.publicKey === d.publicKey) return true;
            return c.discoveryUUID === uuid;
          });

          if (knownPID) {
            this.contacts[knownPID].onNetwork = true;
            this.contacts[knownPID].networkDiscID = d.discoveryID;
          }

          s.registry[d.discoveryID] = {
            discoveryID: d.discoveryID,
            friendlyName: d.friendlyname,
            lastSeen: Date.now(),
            conn,
            knownPID: knownPID || null,
            publicKey: d.publicKey || undefined,
          };
          this.nsBroadcast(s, cfg);
          this.nsEmit(s);

          // Monitor this connection
          conn.on('close', () => {
            if (s.registry[d.discoveryID]?.conn === conn) {
              delete s.registry[d.discoveryID];
              this.nsBroadcast(s, cfg);
              this.nsEmit(s);
            }
          });
        }
      });
    });

    conn.on('error', () => {
      clearTimeout(timeout);
      // No peer waiting — silently ignore
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Public IP Routing (thin wrappers over ns* core) ══════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  private attemptNamespace(level: number) {
    this.nsAttempt(this.publicNS, this.publicNSConfig, level);
  }

  private tryJoinNamespace(level: number, attempt: number = 0) {
    this.nsTryJoin(this.publicNS, this.publicNSConfig, level, attempt);
  }

  private handleRouterConn(conn: DataConnection) {
    this.nsHandleRouterConn(this.publicNS, this.publicNSConfig, conn);
  }

  private broadcastRegistry() {
    this.nsBroadcast(this.publicNS, this.publicNSConfig);
  }

  private mergeRegistry(peers: any[]) {
    this.nsMergeRegistry(this.publicNS, this.publicNSConfig, peers);
  }

  private startPingTimer() {
    this.nsStartPingTimer(this.publicNS, this.publicNSConfig);
  }

  private registerDisc() {
    this.nsRegisterDisc(this.publicNS, this.publicNSConfig);
  }

  private checkForLowerNamespace() {
    this.nsProbeLevel1(this.publicNS, this.publicNSConfig);
  }

  private failover() {
    this.nsFailover(this.publicNS, this.publicNSConfig);
  }

  private handleRouterMigrate(level: number) {
    this.nsMigrate(this.publicNS, this.publicNSConfig, level);
  }

  // ─── Manual connect / handshake ───────────────────────────────────────────

  public requestConnect(targetID: string, fname: string) {
    if (targetID === this.discoveryID || targetID === this.persistentID) return;
    this.log(`Requesting connection to: ${targetID}`, 'info');

    const isPersistent = targetID.split('-').length === 2;
    const peer = isPersistent ? this.persPeer : (this.publicNS.discPeer || this.persPeer);

    if (!peer) {
      this.log('No active peer instance to connect', 'err');
      return;
    }

    if (!this.contacts[targetID]) {
      this.contacts[targetID] = { friendlyName: fname, discoveryID: isPersistent ? null : targetID, discoveryUUID: '', pending: 'outgoing' };
      if (!this.chats[targetID]) this.chats[targetID] = [];
      saveContacts(this.contacts);
      saveChats(this.chats);
      this.emitPeerListUpdate();
    }

    const conn = peer.connect(targetID, { reliable: true });
    conn.on('open', async () => {
      this.log(`Handshake channel open with ${targetID}`, 'info');
      const ts = String(Date.now());
      const signature = this.privateKey ? await signData(this.privateKey, ts) : '';
      conn.send({ type: 'request', friendlyname: this.friendlyName, publicKey: this.publicKeyStr, persistentID: this.persistentID, ts, signature });
    });

    conn.on('data', (d: any) => {
      if (d.type === 'accepted') {
        this.log(`Request accepted by ${fname}`, 'ok');
        conn.send({
          type: 'confirm',
          persistentID: this.persistentID,
          friendlyname: this.friendlyName,
          discoveryUUID: this.discoveryUUID,
          publicKey: this.publicKeyStr,
        });

        const dupPID = d.publicKey ? this.findContactByPublicKey(d.publicKey, d.persistentID) : null;
        if (dupPID) this.migrateContact(dupPID, d.persistentID);

        if (isPersistent && this.contacts[targetID]?.pending) {
          delete this.contacts[targetID];
        }

        this.contacts[d.persistentID] = {
          ...(this.contacts[d.persistentID] || {}),
          friendlyName: fname,
          discoveryID: isPersistent ? null : targetID,
          discoveryUUID: d.discoveryUUID,
          conn: null,
        };

        if (!this.chats[d.persistentID]) this.chats[d.persistentID] = [];
        saveContacts(this.contacts);
        saveChats(this.chats);

        setTimeout(() => conn.close(), 1000);
        this.connectPersistent(d.persistentID, fname);
        this.emitPeerListUpdate();
      }
      if (d.type === 'rejected') {
        this.log(`${fname} rejected the connection`, 'err');
        if (this.contacts[targetID]?.pending) {
          delete this.contacts[targetID];
          saveContacts(this.contacts);
          this.emitPeerListUpdate();
        }
        conn.close();
      }
    });

    conn.on('error', (err) => {
      this.log(`Connection request failed: ${err.type}`, 'err');
    });
  }

  private handleDiscData(d: any, conn: DataConnection) {
    if (d.type === 'rvz-exchange') {
      this.rvzHandleExchange(d, conn);
      return;
    }
    this.handleHandshakeData(d, conn);
  }

  private async handleHandshakeData(d: any, conn: DataConnection) {
    if (d.type === 'request') {
      const fname = d.friendlyname;
      let verified = false;
      let fingerprint = '';
      if (d.publicKey && d.ts && d.signature && window.crypto?.subtle) {
        try {
          const key = await importPublicKey(d.publicKey);
          verified = await verifySignature(key, d.signature, d.ts);
          const bytes = new TextEncoder().encode(d.publicKey);
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          fingerprint = Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch {}
      }
      const requesterPID = d.persistentID as string | undefined;
      this.log(`Incoming connection request from ${fname}${verified ? ' (verified)' : ''}`, 'info');
      this.notify('Connection Request', `${fname} wants to connect`, 'conn-request');
      const event = new CustomEvent('connection-request', {
        detail: {
          fname,
          publicKey: d.publicKey || null,
          fingerprint,
          verified,
          accept: () => {
            conn.send({ type: 'accepted', persistentID: this.persistentID, discoveryUUID: this.discoveryUUID });
            this.log(`Accepted request from ${fname}`, 'ok');
          },
          reject: () => {
            conn.send({ type: 'rejected' });
            setTimeout(() => conn.close(), 500);
          },
          saveForLater: () => {
            if (!requesterPID) return;
            this.contacts[requesterPID] = {
              friendlyName: fname,
              discoveryID: null,
              discoveryUUID: '',
              pending: 'incoming',
              publicKey: d.publicKey || undefined,
              pendingFingerprint: fingerprint || undefined,
              pendingVerified: verified,
            };
            if (!this.chats[requesterPID]) this.chats[requesterPID] = [];
            saveContacts(this.contacts);
            saveChats(this.chats);
            this.emitPeerListUpdate();
            this.log(`Saved incoming request from ${fname} for later`, 'info');
            conn.close();
          },
        }
      });
      this.dispatchEvent(event);
    }
    if (d.type === 'confirm') {
      const pid = d.persistentID;
      this.log(`Handshake confirmed by ${d.friendlyname} (${pid})`, 'ok');

      const dupPID = d.publicKey ? this.findContactByPublicKey(d.publicKey, pid) : null;
      if (dupPID) this.migrateContact(dupPID, pid);

      this.contacts[pid] = {
        ...(this.contacts[pid] || {}),
        friendlyName: d.friendlyname,
        discoveryID: null,
        discoveryUUID: d.discoveryUUID,
        conn: null
      };
      if (!this.chats[pid]) this.chats[pid] = [];
      saveContacts(this.contacts);
      saveChats(this.chats);
      setTimeout(() => conn.close(), 500);
      this.emitPeerListUpdate();
    }
  }

  public connectPersistent(pid: string, fname: string) {
    if (!this.persPeer || this.persPeer.destroyed) return;
    if (this.persPeer.disconnected) {
      this.log(`Signaling down — will reconnect to ${fname} when online`, 'info');
      return;
    }

    if (this.contacts[pid]?.conn && !this.contacts[pid].conn.open) {
      this.contacts[pid].conn = null;
    }

    if (this.contacts[pid]?.conn?.open) {
      this.log(`Already connected to ${fname}`, 'info');
      return;
    }

    this.log(`Opening persistent connection to ${fname} (${pid})...`, 'info');
    this.connectingPIDs.add(pid);
    const conn = this.persPeer.connect(pid, { reliable: true });

    conn.on('open', async () => {
      this.connectingPIDs.delete(pid);
      if (!this.contacts[pid]) this.contacts[pid] = { friendlyName: fname, discoveryID: null, discoveryUUID: '' };
      this.contacts[pid].conn = conn;

      const ts = Date.now().toString();
      let signature = '';
      if (this.privateKey) {
        signature = await signData(this.privateKey, ts);
      }

      conn.send({
        type: 'hello',
        friendlyname: this.friendlyName,
        publicKey: this.publicKeyStr,
        ts,
        signature
      });

      this.flushMessageQueue(pid);
      this.emitPeerListUpdate();
      this.log(`Persistent channel open with ${fname}`, 'ok');
    });

    conn.on('data', (d) => this.handlePersistentData(d, conn));

    conn.on('close', () => {
      this.connectingPIDs.delete(pid);
      this.log(`Persistent channel closed with ${fname}`, 'info');
      if (this.contacts[pid]) {
        this.contacts[pid].conn = null;
        this.emitPeerListUpdate();
      }
    });

    conn.on('error', (err) => {
      this.connectingPIDs.delete(pid);
      this.log(`Persistent connection error with ${fname}: ${err.type}`, 'err');
      if (this.persPeer?.disconnected || this.offlineMode) return;
      this.connectFailures[pid] = (this.connectFailures[pid] || 0) + 1;
      if (this.connectFailures[pid] < this.MAX_CONNECT_RETRIES) {
        const delay = 5000 * this.connectFailures[pid];
        this.log(`Retry ${this.connectFailures[pid]}/${this.MAX_CONNECT_RETRIES} for ${fname} in ${delay / 1000}s`, 'info');
        setTimeout(() => {
          if (!this.contacts[pid]?.conn?.open && !this.connectingPIDs.has(pid)) {
            this.connectPersistent(pid, fname);
          }
        }, delay);
      } else {
        this.log(`${fname} unreachable after ${this.MAX_CONNECT_RETRIES} attempts — marking messages failed`, 'err');
        this.markWaitingMessagesFailed(pid);
        this.rvzEnqueue(pid);
      }
    });
  }

  private markWaitingMessagesFailed(pid: string) {
    const msgs = this.chats[pid];
    if (!msgs) return;
    let changed = false;
    msgs.forEach(m => {
      if (m.dir === 'sent' && m.status === 'waiting') {
        m.status = 'failed';
        changed = true;
      }
    });
    if (changed) {
      saveChats(this.chats);
      this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
    }
  }

  private resetUnackedMessages() {
    let changed = false;
    Object.keys(this.chats).forEach(pid => {
      this.chats[pid]?.forEach(m => {
        if (m.dir === 'sent' && m.status === 'sent') {
          m.status = 'waiting';
          changed = true;
        }
      });
    });
    if (changed) saveChats(this.chats);
  }

  private async handlePersistentData(d: any, conn: DataConnection) {
    const pid = conn.peer;

    if (['request', 'confirm'].includes(d.type)) {
      return this.handleHandshakeData(d, conn);
    }

    if (d.type === 'hello') {
      if (d.publicKey) {
        const dupPID = this.findContactByPublicKey(d.publicKey, pid);
        if (dupPID) this.migrateContact(dupPID, pid);
      }

      const isNew = !this.contacts[pid] || !this.contacts[pid].conn;

      if (d.publicKey && d.signature && d.ts) {
        if (window.crypto?.subtle) {
          try {
            const key = await importPublicKey(d.publicKey);
            const valid = await verifySignature(key, d.signature, d.ts);
            if (!valid) {
              this.log(`Invalid signature from ${d.friendlyname}`, 'err');
              conn.close();
              return;
            }
            if (!this.contacts[pid]) this.contacts[pid] = { friendlyName: d.friendlyname, discoveryID: null, discoveryUUID: '', conn, publicKey: d.publicKey };
            this.contacts[pid].publicKey = d.publicKey;
            this.log(`Verified identity for ${d.friendlyname}`, 'ok');
            // Derive ECDH shared key now that we have their verified public key
            this.getOrDeriveSharedKey(pid);
          } catch {
            this.log(`Identity verification failed for ${d.friendlyname}`, 'err');
          }
        } else {
          this.log(`No secure context — skipping identity check for ${d.friendlyname}`, 'info');
        }
      }

      if (!this.contacts[pid]) this.contacts[pid] = { friendlyName: d.friendlyname, discoveryID: null, discoveryUUID: '', conn };
      this.contacts[pid].conn = conn;
      this.contacts[pid].friendlyName = d.friendlyname;
      this.contacts[pid].lastSeen = Date.now();
      delete this.contacts[pid].pending;
      if (!this.chats[pid]) this.chats[pid] = [];

      if (isNew) {
        const ts = Date.now().toString();
        let signature = '';
        if (this.privateKey) {
          signature = await signData(this.privateKey, ts);
        }
        conn.send({
          type: 'hello',
          friendlyname: this.friendlyName,
          publicKey: this.publicKeyStr,
          ts,
          signature
        });
      }
      delete this.connectFailures[pid];
      saveContacts(this.contacts);
      this.emitPeerListUpdate();
      this.log(`Hello from ${d.friendlyname}`, 'ok');
    }

    if (d.type === 'message') {
      if (!this.chats[pid]) this.chats[pid] = [];
      let content = d.content || '';
      // E2E encrypted message: decrypt and verify signature
      if (d.e2e && d.ct && d.iv) {
        try {
          const sk = await this.getOrDeriveSharedKey(pid);
          const contact = this.contacts[pid];
          if (sk && contact?.publicKey) {
            const pubKey = await importPublicKey(contact.publicKey);
            const sigValid = await verifySignature(pubKey, d.sig, d.ct);
            if (sigValid) {
              content = await decryptMessage(sk.key, d.iv, d.ct);
            } else {
              this.log(`E2E signature mismatch from ${contact.friendlyName} — showing as unverified`, 'err');
              content = '[unverified encrypted message]';
            }
          } else {
            content = '[encrypted — no shared key]';
          }
        } catch (e) {
          this.log(`E2E decrypt failed from ${pid}: ${e}`, 'err');
          content = '[encrypted — decryption failed]';
        }
      }
      // ALWAYS create the message and send ack — never silently drop
      const msg: ChatMessage = { id: d.id || crypto.randomUUID(), dir: 'recv', content, ts: d.ts, type: 'text' };
      this.chats[pid].push(msg);
      saveChats(this.chats);
      if (conn.open) conn.send({ type: 'message-ack', id: d.id });
      const fname = this.contacts[pid]?.friendlyName || 'Someone';
      this.notify(fname, content.slice(0, 100) || 'New message', `msg-${pid}`);
      this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
    }

    if (d.type === 'message-ack') {
      const msgs = this.chats[pid];
      if (msgs) {
        const msg = msgs.find(m => m.id === d.id && m.dir === 'sent');
        if (msg) {
          msg.status = 'delivered';
          saveChats(this.chats);
          this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
        }
      }
    }

    if (d.type === 'message-edit') {
      const msgs = this.chats[pid];
      if (msgs) {
        const msg = msgs.find(m => m.id === d.id);
        if (msg && !msg.deleted) {
          let editContent = d.content || '';
          if (d.e2e && d.ct && d.iv) {
            try {
              const sk = await this.getOrDeriveSharedKey(pid);
              const contact = this.contacts[pid];
              if (sk && contact?.publicKey) {
                const pubKey = await importPublicKey(contact.publicKey);
                const sigValid = await verifySignature(pubKey, d.sig, d.ct);
                if (sigValid) {
                  editContent = await decryptMessage(sk.key, d.iv, d.ct);
                } else {
                  editContent = '[unverified edit]';
                }
              } else {
                editContent = '[encrypted edit — no shared key]';
              }
            } catch {
              editContent = '[encrypted edit — decryption failed]';
            }
          }
          msg.content = editContent;
          msg.edited = true;
          saveChats(this.chats);
          this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
        }
      }
    }

    if (d.type === 'message-delete') {
      const msgs = this.chats[pid];
      if (msgs) {
        const msg = msgs.find(m => m.id === d.id);
        if (msg) {
          msg.content = '';
          msg.deleted = true;
          saveChats(this.chats);
          this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
        }
      }
    }

    if (d.type === 'file-start') {
      this.incomingFiles[d.tid] = { tid: d.tid, name: d.name, size: d.size, total: d.total, chunks: [], received: 0 };
      this.log(`Receiving: ${d.name}`, 'info');
    }
    if (d.type === 'file-chunk') {
      const f = this.incomingFiles[d.tid];
      if (f) {
        f.chunks[d.index] = d.chunk;
        f.received++;
        this.dispatchEvent(new CustomEvent('file-progress', { detail: { tid: d.tid, progress: f.received / f.total, name: f.name } }));
      }
    }
    if (d.type === 'file-end') {
      const f = this.incomingFiles[d.tid];
      if (!f) return;
      const blob = new Blob(f.chunks);
      const ts = Date.now();
      saveFile(d.tid, blob, f.name, ts).then(() => {
        if (!this.chats[pid]) this.chats[pid] = [];
        const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'recv', type: 'file', name: f.name, tid: d.tid, size: f.size, ts };
        this.chats[pid].push(msg);
        saveChats(this.chats);
        delete this.incomingFiles[d.tid];
        if (conn.open) conn.send({ type: 'file-ack', tid: d.tid });
        const fileFname = this.contacts[pid]?.friendlyName || 'Someone';
        this.notify(fileFname, `Sent you a file: ${f.name}`, `file-${pid}`);
        this.log(`File received: ${f.name}`, 'ok');
        this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
      });
    }

    if (d.type === 'file-ack') {
      const msgs = this.chats[pid];
      if (msgs) {
        const msg = msgs.find(m => m.tid === d.tid && m.dir === 'sent');
        if (msg) {
          msg.status = 'delivered';
          saveChats(this.chats);
          this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
        }
      }
    }

    if (d.type === 'name-update' && d.name) {
      if (this.contacts[pid]) {
        this.contacts[pid].friendlyName = d.name;
        saveContacts(this.contacts);
        this.emitPeerListUpdate();
        this.log(`${d.name} updated their name`, 'info');
      }
    }
  }

  private async flushMessageQueue(pid: string) {
    const c = this.contacts[pid];
    if (!c || !c.conn || !c.conn.open) return;

    const queue = this.chats[pid]?.filter(m => m.dir === 'sent' && (m.status === 'waiting' || m.status === 'failed')) || [];
    let updated = false;
    for (const msg of queue) {
      if (msg.type === 'text') {
        await this.sendEncryptedMessage(pid, c.conn, msg);
        msg.status = 'sent';
        updated = true;
      }
    }
    if (updated) {
      saveChats(this.chats);
      this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
    }
    delete this.connectFailures[pid];

    const files = this.pendingFiles[pid];
    if (files?.length) {
      files.forEach(file => this._sendFileNow(pid, file, c.conn));
      delete this.pendingFiles[pid];
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  public async editMessage(pid: string, id: string, content: string) {
    const msgs = this.chats[pid];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === id && m.dir === 'sent');
    if (!msg || msg.deleted) return;
    msg.content = content;
    msg.edited = true;
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
    const conn = this.contacts[pid]?.conn;
    if (conn?.open) {
      const sk = await this.getOrDeriveSharedKey(pid);
      if (sk && this.privateKey) {
        try {
          const { iv, ct } = await encryptMessage(sk.key, content);
          const sig = await signData(this.privateKey, ct);
          conn.send({ type: 'message-edit', id, iv, ct, sig, e2e: true });
          return;
        } catch {}
      }
      conn.send({ type: 'message-edit', id, content });
    }
  }

  public deleteMessage(pid: string, id: string) {
    const msgs = this.chats[pid];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === id && m.dir === 'sent');
    if (!msg) return;
    msg.content = '';
    msg.deleted = true;
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
    const conn = this.contacts[pid]?.conn;
    if (conn?.open) conn.send({ type: 'message-delete', id });
  }

  public retryMessage(pid: string, id: string) {
    const msgs = this.chats[pid];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === id && m.dir === 'sent' && m.status === 'failed');
    if (!msg) return;
    msg.status = 'waiting';
    delete this.connectFailures[pid];
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid } }));
    const c = this.contacts[pid];
    if (c) this.connectPersistent(pid, c.friendlyName);
  }

  public acceptIncomingRequest(pid: string) {
    const c = this.contacts[pid];
    if (!c || c.pending !== 'incoming') return;
    const fname = c.friendlyName;
    delete c.pending;
    saveContacts(this.contacts);
    this.emitPeerListUpdate();
    this.connectPersistent(pid, fname);
    this.log(`Accepted saved request from ${fname}`, 'ok');
  }

  public updateFriendlyName(name: string) {
    this.friendlyName = name;
    localStorage.setItem(`${APP_PREFIX}-name`, name);
    // Broadcast to all open connections
    Object.values(this.contacts).forEach(c => {
      if (c.conn?.open) c.conn.send({ type: 'name-update', name });
    });
    // Re-checkin to public namespace router
    if (this.publicNS.routerConn?.open) {
      this.publicNS.routerConn.send({ type: 'checkin', discoveryID: this.discoveryID, friendlyname: name, publicKey: this.publicKeyStr });
    }
    // Re-checkin to custom namespace routers
    this.cns.forEach((s) => {
      const discID = s.cfg.makeDiscID(this.discoveryUUID);
      if (s.routerConn?.open) {
        s.routerConn.send({ type: 'checkin', discoveryID: discID, friendlyname: name, publicKey: this.publicKeyStr });
      }
      if (s.registry[discID]) {
        s.registry[discID].friendlyName = name;
      }
      if (s.isRouter) this.nsBroadcast(s, s.cfg);
    });
    if (this.publicNS.registry[this.discoveryID]) this.publicNS.registry[this.discoveryID].friendlyName = name;
    if (this.publicNS.isRouter) this.broadcastRegistry();
    this.emitPeerListUpdate();
    this.emitStatus();
    this.log(`Name updated to: ${name}`, 'ok');
  }

  public deleteContact(pid: string) {
    const c = this.contacts[pid];
    if (c?.conn?.open) try { c.conn.close(); } catch {}
    delete this.contacts[pid];
    delete this.chats[pid];
    saveContacts(this.contacts);
    saveChats(this.chats);
    this.emitPeerListUpdate();
    this.log(`Deleted contact: ${pid}`, 'info');
  }

  public pingContact(pid: string): Promise<'online' | 'offline'> {
    return new Promise((resolve) => {
      if (!this.persPeer) return resolve('offline');
      const c = this.contacts[pid];
      if (!c) return resolve('offline');

      if (c.conn?.open) {
        resolve('online');
        return;
      }

      const conn = this.persPeer.connect(pid, { reliable: true });
      const timer = setTimeout(() => {
        conn.close();
        resolve('offline');
        this.log(`${c.friendlyName} did not respond to ping`, 'info');
      }, 5000);

      conn.on('open', async () => {
        clearTimeout(timer);
        if (!this.contacts[pid]) this.contacts[pid] = c;
        this.contacts[pid].conn = conn;
        const ts = Date.now().toString();
        const signature = this.privateKey ? await signData(this.privateKey, ts) : '';
        conn.send({ type: 'hello', friendlyname: this.friendlyName, publicKey: this.publicKeyStr, ts, signature });
        resolve('online');
        this.emitPeerListUpdate();
        this.log(`${c.friendlyName} is online`, 'ok');
      });

      conn.on('data', (d) => this.handlePersistentData(d, conn));
      conn.on('close', () => {
        if (this.contacts[pid]) { this.contacts[pid].conn = null; this.emitPeerListUpdate(); }
      });
      conn.on('error', () => {
        clearTimeout(timer);
        resolve('offline');
      });
    });
  }

  public async sendMessage(pid: string, content: string) {
    const c = this.contacts[pid];
    const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'sent', content, ts: Date.now(), type: 'text', status: 'waiting' };

    if (!this.chats[pid]) this.chats[pid] = [];
    this.chats[pid].push(msg);
    saveChats(this.chats);

    if (c && c.conn && c.conn.open) {
      await this.sendEncryptedMessage(pid, c.conn, msg);
      msg.status = 'sent';
      saveChats(this.chats);
    } else if (c) {
      if (c.conn && !c.conn.open) c.conn = null;
      this.connectPersistent(pid, c.friendlyName);
    }
    this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
  }

  /** Send a text message, encrypting with shared key if available */
  private async sendEncryptedMessage(pid: string, conn: DataConnection, msg: ChatMessage) {
    const sk = await this.getOrDeriveSharedKey(pid);
    if (sk && this.privateKey) {
      try {
        const { iv, ct } = await encryptMessage(sk.key, msg.content || '');
        const sig = await signData(this.privateKey, ct);
        conn.send({ type: 'message', iv, ct, sig, ts: msg.ts, id: msg.id, e2e: true });
        return;
      } catch (e) {
        this.log(`E2E encrypt failed for ${pid}, sending plaintext`, 'err');
      }
    }
    // Fallback: plaintext
    conn.send({ type: 'message', content: msg.content, ts: msg.ts, id: msg.id });
  }

  public sendFile(pid: string, file: File) {
    const c = this.contacts[pid];
    if (!c) return;

    if (!c.conn || !c.conn.open) {
      if (!this.pendingFiles[pid]) this.pendingFiles[pid] = [];
      this.pendingFiles[pid].push(file);
      this.log(`File queued (offline): ${file.name}`, 'info');
      if (!c.conn) this.connectPersistent(pid, c.friendlyName);
      return;
    }

    this._sendFileNow(pid, file, c.conn);
  }

  private _sendFileNow(pid: string, file: File, conn: DataConnection) {
    const tid = crypto.randomUUID().replace(/-/g, '');
    const reader = new FileReader();
    reader.onload = async (e) => {
      const buf = e.target?.result as ArrayBuffer;
      const total = Math.ceil(buf.byteLength / CHUNK_SIZE);
      conn.send({ type: 'file-start', tid, name: file.name, size: buf.byteLength, total });

      for (let i = 0; i < total; i++) {
        conn.send({
          type: 'file-chunk',
          tid,
          index: i,
          chunk: buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        });
      }
      conn.send({ type: 'file-end', tid });

      const blob = new Blob([buf]);
      await saveFile(tid, blob, file.name, Date.now());

      if (!this.chats[pid]) this.chats[pid] = [];
      const msg: ChatMessage = { id: crypto.randomUUID(), dir: 'sent', type: 'file', name: file.name, tid, size: file.size, ts: Date.now(), status: 'sent' };
      this.chats[pid].push(msg);
      saveChats(this.chats);
      this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
      this.log(`Sent: ${file.name}`, 'ok');
    };
    reader.readAsArrayBuffer(file);
  }

  public async startCall(pid: string, kind: 'audio' | 'video' | 'screen') {
    if (!this.persPeer) throw new Error('Not initialized');

    if (kind === 'screen' && !navigator.mediaDevices?.getDisplayMedia) {
      const err = new Error('Screen sharing is not supported on this browser. On Android, use a desktop browser.');
      this.log(err.message, 'err');
      throw err;
    }

    try {
      let stream: MediaStream;
      let cameraStream: MediaStream | undefined;

      if (kind === 'screen') {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch {}
      } else {
        stream = await navigator.mediaDevices.getUserMedia(
          kind === 'audio' ? { audio: true } : { audio: true, video: true }
        );
      }

      const call = this.persPeer.call(pid, stream, { metadata: { kind } });
      return { call, stream, cameraStream };
    } catch (e: any) {
      this.log(`Call failed: ${e.message}`, 'err');
      throw e;
    }
  }

  private handleIncomingCall(call: MediaConnection) {
    const pid = call.peer;
    const fname = this.contacts[pid]?.friendlyName || pid;
    const kind = call.metadata?.kind || 'video';
    this.notify(`Incoming ${kind} call`, `${fname} is calling`, 'incoming-call');
    this.dispatchEvent(new CustomEvent('incoming-call', { detail: { call, fname, kind } }));
  }

  public addCallLog(pid: string, dir: 'sent' | 'recv', callKind: 'audio' | 'video' | 'screen', callResult: 'answered' | 'missed' | 'rejected' | 'cancelled', callDuration?: number) {
    if (!this.chats[pid]) this.chats[pid] = [];
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      dir,
      type: 'call',
      ts: Date.now(),
      callKind,
      callResult,
      callDuration,
    };
    this.chats[pid].push(msg);
    saveChats(this.chats);
    this.dispatchEvent(new CustomEvent('message', { detail: { pid, msg } }));
  }

  private emitPeerListUpdate() {
    this.dispatchEvent(new CustomEvent('peer-list-update'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Rendezvous Fallback ════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  /** Start the rendezvous system — called from _init() after cnsRestoreSaved() */
  private rvzStart() {
    if (this.rvzSweepTimer) clearInterval(this.rvzSweepTimer);
    this.rvzSweepTimer = setInterval(() => this.rvzSweep(), RVZ_SWEEP_IV);
    // Initial sweep after 30s (let contacts establish first)
    if (this.rvzInitTimer) clearTimeout(this.rvzInitTimer);
    this.rvzInitTimer = setTimeout(() => { this.rvzInitTimer = null; this.rvzSweep(); }, 30000);
  }

  /** Scan contacts for unreachable peers and queue them for rendezvous */
  private rvzSweep() {
    if (this.offlineMode) return;
    Object.keys(this.contacts).forEach(pid => {
      const c = this.contacts[pid];
      if (c.conn?.open) return;            // already connected
      if (c.pending) return;               // not yet accepted
      if (!c.publicKey) return;            // need pubkey for shared key derivation
      if (this.rvzQueue.includes(pid)) return; // already queued
      if (this.rvzActive === pid) return;  // currently active
      if (this.connectingPIDs.has(pid)) return; // currently trying persistent
      this.rvzQueue.push(pid);
    });
    if (!this.rvzActive && this.rvzQueue.length > 0) {
      this.rvzProcessNext();
    }
  }

  /** Pop next contact from queue and start rendezvous namespace */
  private async rvzProcessNext() {
    if (this.rvzActive) return;
    if (this.rvzQueue.length === 0) return;

    const pid = this.rvzQueue.shift()!;
    // Skip if already connected
    if (this.contacts[pid]?.conn?.open) {
      this.rvzProcessNext();
      return;
    }

    const sk = await this.getOrDeriveSharedKey(pid);
    if (!sk) {
      this.rvzProcessNext();
      return;
    }

    const timeWindow = Math.floor(Date.now() / RVZ_WINDOW);
    let slug: string;
    try {
      slug = await deriveRendezvousSlug(sk.key, timeWindow);
    } catch (e) {
      this.log(`Rendezvous slug derivation failed for ${this.contacts[pid]?.friendlyName}: ${e}`, 'err');
      this.rvzProcessNext();
      return;
    }

    this.rvzActive = pid;
    const fname = this.contacts[pid]?.friendlyName || pid.slice(-8);
    this.log(`Rendezvous: checking namespace for ${fname} (window ${timeWindow})`, 'info');

    this.rvzCfg = {
      label: `rvz:${fname.slice(0, 12)}`,
      makeRouterID: (level) => makeRendezvousRouterID(slug, level),
      makeDiscID: (uuid) => makeRendezvousDiscID(slug, uuid),
      makePeerSlotID: () => makeRendezvousPeerSlotID(slug),
    };

    this.rvzState = makeNSState();
    this.nsAttempt(this.rvzState, this.rvzCfg, 1);

    // Window expiry: move to next contact after current time window ends
    const remaining = RVZ_WINDOW - (Date.now() % RVZ_WINDOW);
    this.rvzWindowTimer = setTimeout(() => this.rvzOnWindowExpire(), remaining + 2000);
  }

  /** Time window expired — re-queue if still unreachable, move to next contact */
  private rvzOnWindowExpire() {
    const pid = this.rvzActive;
    if (pid && this.contacts[pid] && !this.contacts[pid].conn?.open) {
      // Re-queue at end for next round
      if (!this.rvzQueue.includes(pid)) this.rvzQueue.push(pid);
    }
    this.rvzCleanupActive();
    this.rvzProcessNext();
  }

  /** Cleanup the currently active rendezvous (but keep timers for sweep/queue) */
  private rvzCleanupActive() {
    if (this.rvzState) {
      this.nsTeardown(this.rvzState);
      this.rvzState = null;
    }
    this.rvzCfg = null;
    this.rvzActive = null;
    if (this.rvzWindowTimer) { clearTimeout(this.rvzWindowTimer); this.rvzWindowTimer = null; }
  }

  /** Full teardown of rendezvous system */
  private rvzTeardown() {
    this.rvzCleanupActive();
    this.rvzQueue = [];
    if (this.rvzSweepTimer) { clearInterval(this.rvzSweepTimer); this.rvzSweepTimer = null; }
    if (this.rvzInitTimer) { clearTimeout(this.rvzInitTimer); this.rvzInitTimer = null; }
  }

  /** Called from nsMergeRegistry when registry updates for the rendezvous namespace.
   *  Looks for the target contact by publicKey match. */
  private rvzCheckRegistry(s: NSState) {
    if (!this.rvzActive) return;
    const pid = this.rvzActive;
    const contact = this.contacts[pid];
    if (!contact?.publicKey) return;

    // Look for a registry entry with matching publicKey (not our own)
    const match = Object.values(s.registry).find(
      r => !r.isMe && r.publicKey && r.publicKey === contact.publicKey
    );
    if (!match) return;

    this.log(`Rendezvous: found ${contact.friendlyName} in namespace — exchanging PIDs`, 'ok');

    // Connect to their discovery peer and send rvz-exchange
    const peer = s.discPeer || this.persPeer;
    if (!peer || peer.destroyed) return;

    const conn = peer.connect(match.discoveryID, { reliable: true });
    conn.on('open', async () => {
      const ts = Date.now().toString();
      const signature = this.privateKey ? await signData(this.privateKey, ts) : '';
      conn.send({
        type: 'rvz-exchange',
        persistentID: this.persistentID,
        friendlyName: this.friendlyName,
        publicKey: this.publicKeyStr,
        ts,
        signature,
      });
    });

    conn.on('data', (d: any) => {
      if (d.type === 'rvz-exchange') {
        this.rvzHandleExchange(d, conn, pid);
      }
    });

    conn.on('error', () => {
      this.log(`Rendezvous: failed to connect to ${contact.friendlyName}'s disc peer`, 'err');
    });
  }

  /** Handle incoming rendezvous exchange — update PID if changed, reconnect */
  private async rvzHandleExchange(d: any, conn: DataConnection, expectedPID?: string) {
    // Verify signature
    if (d.publicKey && d.signature && d.ts && window.crypto?.subtle) {
      try {
        const key = await importPublicKey(d.publicKey);
        const valid = await verifySignature(key, d.signature, d.ts);
        if (!valid) {
          this.log('Rendezvous: invalid signature on exchange', 'err');
          conn.close();
          return;
        }
      } catch {
        this.log('Rendezvous: signature verification error', 'err');
        conn.close();
        return;
      }
    }

    const newPID = d.persistentID;
    const fname = d.friendlyName || 'Unknown';

    // Find the contact by publicKey match
    const oldPID = expectedPID || (d.publicKey ? this.findContactByPublicKey(d.publicKey) : null);

    if (oldPID && oldPID !== newPID) {
      this.log(`Rendezvous: ${fname} PID changed ${oldPID.slice(-8)} → ${newPID.slice(-8)}`, 'info');
      this.migrateContact(oldPID, newPID);
    } else if (!oldPID && newPID) {
      // Unknown contact found via rendezvous — shouldn't happen but handle gracefully
      this.log(`Rendezvous: unexpected peer ${fname} (${newPID.slice(-8)})`, 'info');
    }

    // Send our exchange back if they haven't gotten ours
    if (conn.open) {
      const ts = Date.now().toString();
      const signature = this.privateKey ? await signData(this.privateKey, ts) : '';
      conn.send({
        type: 'rvz-exchange',
        persistentID: this.persistentID,
        friendlyName: this.friendlyName,
        publicKey: this.publicKeyStr,
        ts,
        signature,
      });
      setTimeout(() => { try { conn.close(); } catch {} }, 1000);
    }

    // Cleanup rendezvous and connect normally
    this.rvzCleanupActive();
    // Remove from queue too
    this.rvzQueue = this.rvzQueue.filter(p => p !== newPID && p !== oldPID);

    // Connect via persistent channel
    if (this.contacts[newPID]) {
      delete this.connectFailures[newPID];
      this.connectPersistent(newPID, fname);
    }

    // Continue with remaining queue
    this.rvzProcessNext();
  }

  /** Add a PID to the rendezvous queue (called from connectPersistent error path) */
  private rvzEnqueue(pid: string) {
    if (!this.contacts[pid]?.publicKey) return; // need pubkey for rendezvous
    if (this.rvzQueue.includes(pid) || this.rvzActive === pid) return;
    this.rvzQueue.push(pid);
    this.log(`Rendezvous: queued ${this.contacts[pid]?.friendlyName || pid.slice(-8)}`, 'info');
    if (!this.rvzActive) this.rvzProcessNext();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══ Custom Namespace Public API ══════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  public joinCustomNamespace(name: string, advanced = false) {
    const slug = advanced ? name : slugifyNamespace(name);
    if (!slug || this.cns.has(slug)) return;

    const cfg = this.makeCNSConfig({ name, slug, advanced });
    const state: CNSState = {
      ...makeNSState(),
      name,
      slug,
      offline: false,
      advanced,
      cfg,
    };

    this.cns.set(slug, state);
    this.cnsSave();
    this.nsAttempt(state, cfg, 1);
    this.cnsEmit();
    this.log(`Joining custom namespace: ${name}${advanced ? ' (advanced)' : ''}`, 'info');
  }

  public leaveCustomNamespace(slug: string) {
    const s = this.cns.get(slug);
    if (!s) return;
    this.nsTeardown(s);
    this.cns.delete(slug);
    this.cnsSave();
    this.cnsEmit();
    this.log(`Left custom namespace: ${slug}`, 'info');
  }

  public setCustomNSOffline(slug: string, offline: boolean) {
    const s = this.cns.get(slug);
    if (!s) return;
    s.offline = offline;
    if (offline) {
      this.nsTeardown(s, true);
      s.level = 0; s.isRouter = false;
    } else {
      if (this.persPeer && !this.persPeer.destroyed && !this.persPeer.disconnected) {
        this.nsAttempt(s, s.cfg, 1);
      }
    }
    this.cnsSave();
    this.cnsEmit();
  }

  public get customNamespaces(): Record<string, CustomNS> {
    const out: Record<string, CustomNS> = {};
    this.cns.forEach((s, k) => {
      out[k] = {
        name: s.name,
        slug: s.slug,
        isRouter: s.isRouter,
        level: s.level,
        offline: s.offline,
        advanced: s.advanced,
        registry: { ...s.registry },
        joinStatus: s.joinStatus,
        joinAttempt: s.joinAttempt,
      };
    });
    return out;
  }

  // ─── Custom Namespace Internal ────────────────────────────────────────────

  private cnsEmit() {
    this.dispatchEvent(new CustomEvent('custom-ns-update'));
    this.emitPeerListUpdate();
  }

  private cnsSave() {
    const arr = Array.from(this.cns.values()).map(s => ({
      name: s.name,
      slug: s.slug,
      offline: s.offline,
      advanced: s.advanced || false,
    }));
    localStorage.setItem(`${APP_PREFIX}-custom-ns`, JSON.stringify(arr));
  }

  private cnsRestoreSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(`${APP_PREFIX}-custom-ns`) || '[]') as { name: string; offline?: boolean; advanced?: boolean }[];
      saved.forEach(({ name, offline, advanced }) => {
        const slug = advanced ? name : slugifyNamespace(name);
        if (!this.cns.has(slug)) {
          this.joinCustomNamespace(name, advanced);
          if (offline) this.setCustomNSOffline(slug, true);
        }
      });
    } catch {}
  }
}

export const p2p = new P2PManager();
