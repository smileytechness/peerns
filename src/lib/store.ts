import { Contact, ChatMessage, APP_PREFIX } from './types';

const IDB_NAME = `${APP_PREFIX}-files`;
const IDB_STORE = 'files';

export function saveContacts(contacts: Record<string, Contact>) {
  try {
    const clean: Record<string, any> = {};
    Object.keys(contacts).forEach((pid) => {
      clean[pid] = {
        friendlyName: contacts[pid].friendlyName,
        discoveryID: contacts[pid].discoveryID,
        discoveryUUID: contacts[pid].discoveryUUID,
        publicKey: contacts[pid].publicKey,
        lastSeen: contacts[pid].lastSeen,
      };
    });
    localStorage.setItem(`${APP_PREFIX}-contacts`, JSON.stringify(clean));
  } catch (e) {
    console.error('localStorage save error:', e);
  }
}

export function loadContacts(): Record<string, Contact> {
  try {
    const c = localStorage.getItem(`${APP_PREFIX}-contacts`);
    return c ? JSON.parse(c) : {};
  } catch (e) {
    return {};
  }
}

export function saveChats(chats: Record<string, ChatMessage[]>) {
  try {
    localStorage.setItem(`${APP_PREFIX}-chats`, JSON.stringify(chats));
  } catch (e) {
    console.error('localStorage save error:', e);
  }
}

export function loadChats(): Record<string, ChatMessage[]> {
  try {
    const h = localStorage.getItem(`${APP_PREFIX}-chats`);
    return h ? JSON.parse(h) : {};
  } catch (e) {
    return {};
  }
}

export function saveFileMeta(tid: string, name: string, size: number, receivedAt: number) {
  try {
    localStorage.setItem(
      `${APP_PREFIX}-filemeta-` + tid,
      JSON.stringify({
        tid,
        name,
        size,
        ext: name.split('.').pop()?.toLowerCase(),
        receivedAt,
      })
    );
  } catch (e) {
    console.error('FileMeta save error', e);
  }
}

export function loadFileMeta(tid: string) {
  try {
    const m = localStorage.getItem(`${APP_PREFIX}-filemeta-` + tid);
    return m ? JSON.parse(m) : null;
  } catch (e) {
    return null;
  }
}

let idb: IDBDatabase | null = null;

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (idb) return resolve(idb);
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e: any) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'tid' });
    };
    req.onsuccess = (e: any) => {
      idb = e.target.result;
      resolve(idb!);
    };
    req.onerror = (e: any) => reject(e.target.error);
  });
}

export async function saveFile(tid: string, blob: Blob, name: string, receivedAt?: number): Promise<string | null> {
  saveFileMeta(tid, name, blob.size, receivedAt || Date.now());
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({
          tid,
          name,
          dataUrl: e.target?.result,
          receivedAt: receivedAt || Date.now(),
        });
        tx.oncomplete = () => resolve(e.target?.result as string);
        tx.onerror = (err) => {
          console.error('IDB save error', err);
          reject(err);
        };
      };
      reader.readAsDataURL(blob);
    });
  } catch (e: any) {
    console.error('IDB open error: ' + e.message);
    return null;
  }
}

export async function loadFile(tid: string): Promise<string | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(tid);
      req.onsuccess = (e: any) => resolve(e.target.result ? e.target.result.dataUrl : null);
      req.onerror = (e: any) => reject(e.target.error);
    });
  } catch (e) {
    return null;
  }
}
