import React from 'react';
import { Menu, Share2, Key, User } from 'lucide-react';

interface TopBarProps {
  name: string;
  pid: string;
  pubkeyFingerprint: string;
  persConnected: boolean;
  onToggleSidebar: () => void;
  onShare: () => void;
}

export function TopBar({ name, pid, pubkeyFingerprint, persConnected, onToggleSidebar, onShare }: TopBarProps) {
  return (
    <div className="shrink-0 h-11 bg-gray-900 border-b border-gray-800 flex items-center gap-2 px-3 z-10">
      {/* Hamburger — mobile only */}
      <button
        onClick={onToggleSidebar}
        className="md:hidden p-1.5 hover:bg-gray-800 rounded text-gray-400 hover:text-white shrink-0"
        aria-label="Toggle sidebar"
      >
        <Menu size={18} />
      </button>

      {/* Online status dot */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${persConnected ? 'bg-green-500' : 'bg-gray-600'}`}
        title={persConnected ? 'Reachable (persistent ID registered)' : 'Signaling disconnected'}
      />

      {/* Friendly name */}
      <div className="flex items-center gap-1.5 shrink-0">
        <User size={13} className="text-gray-500" />
        <span className="font-semibold text-gray-100 text-sm">{name || '—'}</span>
      </div>

      {/* Persistent ID — hidden on very small screens */}
      {pid && (
        <div className="hidden sm:flex items-center gap-1 min-w-0">
          <span className="text-gray-700 text-xs">·</span>
          <span className="font-mono text-[11px] text-gray-500 truncate max-w-[160px]">
            {pid.length > 24 ? pid.slice(0, 24) + '…' : pid}
          </span>
        </div>
      )}

      {/* Key fingerprint — desktop only */}
      {pubkeyFingerprint && (
        <div className="hidden md:flex items-center gap-1 shrink-0">
          <Key size={11} className="text-purple-400" />
          <span className="font-mono text-[11px] text-purple-400">{pubkeyFingerprint}</span>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Share button */}
      <button
        onClick={onShare}
        className="p-1.5 hover:bg-gray-800 rounded text-gray-400 hover:text-white shrink-0"
        title="Share your Persistent ID"
      >
        <Share2 size={15} />
      </button>
    </div>
  );
}
