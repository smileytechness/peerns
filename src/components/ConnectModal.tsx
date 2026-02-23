import React, { useState } from 'react';
import { X, UserPlus, AlertCircle } from 'lucide-react';
import { APP_PREFIX } from '../lib/types';

interface ConnectModalProps {
  onConnect: (pid: string, fname: string) => void;
  onClose: () => void;
}

/** Returns true only for a genuine persistent ID: APP_PREFIX + '-' + 32 hex chars */
function isPersistentID(val: string): boolean {
  const parts = val.split('-');
  if (parts.length !== 2) return false;
  if (parts[0] !== APP_PREFIX) return false;
  return /^[a-f0-9]{32}$/.test(parts[1]);
}

/** Returns a human-readable reason if the ID looks like a namespace/discovery ID */
function getIDError(val: string): string | null {
  if (!val.startsWith(APP_PREFIX + '-')) {
    return `ID must start with "${APP_PREFIX}-".`;
  }
  const parts = val.split('-');
  if (parts.length > 2) {
    // Could be a router ID (ends in -1, -2, …) or a discovery ID
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      return 'This looks like a namespace router ID (ends in a number). Router IDs are not user addresses — ask the other person for their Persistent ID from the Share screen.';
    }
    return 'This looks like a discovery ID. Discovery IDs include an IP address segment. Ask the other person for their Persistent ID from the Share screen.';
  }
  if (parts.length === 2 && !/^[a-f0-9]{32}$/.test(parts[1])) {
    return 'The ID format is invalid. A Persistent ID looks like: myapp-a1b2c3d4… (32 hex characters after the dash).';
  }
  return null;
}

export function ConnectModal({ onConnect, onClose }: ConnectModalProps) {
  const [pid, setPid] = useState('');
  const [fname, setFname] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let val = pid.trim();
    if (!val) return;

    // Extract from a share URL if pasted
    try {
      const u = new URL(val);
      val = u.searchParams.get('connect') || val;
    } catch {}

    const err = getIDError(val);
    if (err) {
      setError(err);
      return;
    }
    if (!isPersistentID(val)) {
      setError('Invalid Persistent ID format.');
      return;
    }

    onConnect(val, fname.trim() || 'Unknown');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-200 flex items-center gap-2">
              <UserPlus size={16} className="text-blue-400" />
              Add Contact
            </h3>
            <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300">
              <X size={16} />
            </button>
          </div>

          <p className="text-gray-500 text-xs mb-4">
            Paste the other person's <span className="text-gray-300">Persistent ID</span> or share link.
            You can get yours from the share button in the nav panel.
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
                Persistent ID or Share Link
              </label>
              <input
                type="text"
                value={pid}
                onChange={(e) => { setPid(e.target.value); setError(''); }}
                placeholder="myapp-a1b2c3d4e5f6…"
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-blue-500 font-mono"
                autoFocus
              />
            </div>

            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
                Their Name (optional)
              </label>
              <input
                type="text"
                value={fname}
                onChange={(e) => setFname(e.target.value)}
                placeholder="e.g. Alice"
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-red-400 text-xs bg-red-900/20 border border-red-800/40 rounded-lg p-3">
                <AlertCircle size={13} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-2 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded-lg text-sm transition-colors"
              >
                Send Request
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
