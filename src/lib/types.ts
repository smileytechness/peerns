import { Peer } from 'peerjs';

export const APP_PREFIX = 'peerns';
export const APP_NAME = 'PeerNS';
export const TTL = 90000;
export const PING_IV = 60000;
export const IP_REFRESH = 5 * 60 * 1000;
export const CHUNK_SIZE = 16000;
export const RVZ_WINDOW = 10 * 60 * 1000;   // 10 minute time windows
export const RVZ_SWEEP_IV = 5 * 60 * 1000;  // sweep unreachable contacts every 5 min

export interface PeerInfo {
  discoveryID: string;
  friendlyName: string;
  lastSeen: number;
  isMe?: boolean;
  conn?: any;
  knownPID?: string | null;
  publicKey?: string;
}

export interface Contact {
  friendlyName: string;
  discoveryID: string | null;
  discoveryUUID: string;
  conn?: any;
  onNetwork?: boolean;
  networkDiscID?: string | null;
  publicKey?: string;            // For Zero Trust
  lastSeen?: number;             // Timestamp of last interaction
  pending?: 'outgoing' | 'incoming'; // outgoing = we sent request; incoming = they sent, we saved
  pendingFingerprint?: string;   // key fingerprint from their request
  pendingVerified?: boolean;     // signature verified at request time
}

export interface NSConfig {
  label: string;
  makeRouterID: (level: number) => string;
  makeDiscID: (uuid: string) => string;
  makePeerSlotID: () => string;
}

export interface CustomNS {
  name: string;
  slug: string;
  isRouter: boolean;
  level: number;
  offline: boolean;
  advanced?: boolean;
  registry: Record<string, PeerInfo>;
  joinStatus?: 'joining' | 'peer-slot' | null;
  joinAttempt?: number;
}

export interface ChatMessage {
  id: string;
  dir: 'sent' | 'recv';
  type?: 'text' | 'file' | 'call';
  content?: string;
  name?: string;
  tid?: string;
  size?: number;
  ts: number;
  status?: 'waiting' | 'sent' | 'delivered' | 'failed';
  edited?: boolean;
  deleted?: boolean;
  retries?: number;
  // Call log fields
  callKind?: 'audio' | 'video' | 'screen';
  callDuration?: number;
  callResult?: 'answered' | 'missed' | 'rejected' | 'cancelled';
}

export interface FileTransfer {
  tid: string;
  name: string;
  size: number;
  total: number;
  chunks: ArrayBuffer[];
  received: number;
}
