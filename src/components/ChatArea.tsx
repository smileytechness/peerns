import React, { useState, useEffect, useRef } from 'react';
import { ChatMessage } from '../lib/types';
import { loadFile, loadFileMeta } from '../lib/store';
import { Send, Paperclip, Phone, Video, Monitor, Download, File, ArrowLeft, Info, Pencil, Trash2, RotateCcw, Check, CheckCheck, Clock, AlertCircle, ChevronDown, PhoneIncoming, PhoneOutgoing, PhoneMissed } from 'lucide-react';
import { clsx } from 'clsx';

function formatCallDuration(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface ChatAreaProps {
  pid: string;
  friendlyName: string;
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onSendFile: (file: File) => void;
  onCall: (kind: 'audio' | 'video' | 'screen') => void;
  onBack: () => void;
  onContactInfo: () => void;
  onEditMessage: (id: string, content: string) => void;
  onDeleteMessage: (id: string) => void;
  onRetryMessage: (id: string) => void;
}

function StatusIcon({ status }: { status?: string }) {
  if (status === 'delivered') return <CheckCheck size={11} className="text-blue-400" />;
  if (status === 'sent') return <Check size={11} className="text-gray-400" />;
  if (status === 'failed') return <AlertCircle size={11} className="text-red-400" />;
  return <Clock size={11} className="text-gray-600" />;
}

const MessageItem: React.FC<{
  msg: ChatMessage;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
}> = ({ msg, onEdit, onDelete, onRetry }) => {
  const [fileData, setFileData] = useState<string | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(msg.content || '');
  const [showActions, setShowActions] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (msg.type === 'file' && msg.tid) {
      loadFile(msg.tid).then(setFileData);
      setMeta(loadFileMeta(msg.tid));
    }
  }, [msg]);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  const isSent = msg.dir === 'sent';
  const canEdit = isSent && msg.type === 'text' && !msg.deleted && msg.status !== 'failed';

  const submitEdit = () => {
    if (editValue.trim() && editValue.trim() !== msg.content) {
      onEdit(msg.id, editValue.trim());
    }
    setEditing(false);
  };

  if (msg.deleted) {
    return (
      <div className={clsx('flex mb-1', isSent ? 'justify-end' : 'justify-start')}>
        <span className="text-[11px] italic text-gray-600 px-3 py-1 bg-gray-800/50 rounded-lg">
          {isSent ? 'You deleted this message' : 'Message deleted'}
        </span>
      </div>
    );
  }

  if (msg.type === 'call') {
    const icon = msg.callKind === 'video' ? <Video size={14} />
               : msg.callKind === 'screen' ? <Monitor size={14} />
               : <Phone size={14} />;
    const label = msg.dir === 'sent' ? 'Outgoing' : 'Incoming';
    const resultText = msg.callResult === 'answered'
      ? (msg.callDuration ? formatCallDuration(msg.callDuration) : '')
      : msg.callResult === 'missed' ? 'Missed'
      : msg.callResult === 'rejected' ? 'Declined'
      : 'Cancelled';
    const color = msg.callResult === 'answered' ? 'text-green-400'
                : msg.callResult === 'missed' ? 'text-red-400'
                : 'text-gray-400';

    return (
      <div className="flex justify-center mb-2 self-center">
        <div className={clsx('flex items-center gap-2 text-xs px-3 py-1.5 rounded-full bg-gray-800/60', color)}>
          {icon}
          <span>{label} {msg.callKind} call</span>
          {resultText && <span className="opacity-70">&middot; {resultText}</span>}
          <span className="text-gray-600 text-[10px]">{new Date(msg.ts).toLocaleTimeString()}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx('flex flex-col mb-2 max-w-[75%]', isSent ? 'self-end items-end' : 'self-start items-start')}
      onMouseEnter={() => isSent && setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); }}
    >
      {/* Action buttons (hover, sent messages only) */}
      {isSent && showActions && !editing && !msg.deleted && (
        <div className="flex gap-1 mb-1">
          {canEdit && (
            <button
              onClick={() => { setEditValue(msg.content || ''); setEditing(true); }}
              className="p-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-400 hover:text-white"
              title="Edit"
            >
              <Pencil size={11} />
            </button>
          )}
          <button
            onClick={() => onDelete(msg.id)}
            className="p-1 bg-gray-700 hover:bg-red-900/60 rounded text-gray-400 hover:text-red-400"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}

      {/* Bubble */}
      {editing ? (
        <div className="flex flex-col gap-1 w-full">
          <textarea
            ref={editRef}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
              if (e.key === 'Escape') setEditing(false);
            }}
            className="bg-blue-700 text-white text-sm rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[120px]"
            rows={2}
          />
          <div className="flex gap-1 justify-end">
            <button onClick={() => setEditing(false)} className="text-[10px] text-gray-400 hover:text-white px-2 py-0.5 bg-gray-700 rounded">Cancel</button>
            <button onClick={submitEdit} className="text-[10px] text-white px-2 py-0.5 bg-blue-600 hover:bg-blue-700 rounded">Save</button>
          </div>
        </div>
      ) : (
        <div
          className={clsx(
            'p-2 rounded-lg text-sm break-words',
            isSent ? 'bg-blue-600 text-white rounded-br-none' : 'bg-gray-800 text-gray-200 rounded-bl-none'
          )}
        >
          {msg.type === 'file' ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 font-semibold">
                <File size={16} /> {msg.name}
              </div>
              <div className="text-xs opacity-70">
                {(msg.size ? (msg.size / 1024).toFixed(1) : '0')} KB
              </div>
              {fileData ? (
                <div className="mt-2">
                  {msg.name?.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                    <img src={fileData} alt={msg.name} className="max-w-[200px] rounded" />
                  ) : (
                    <a
                      href={fileData}
                      download={msg.name}
                      className="flex items-center gap-1 bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs text-white w-fit"
                    >
                      <Download size={12} /> Download
                    </a>
                  )}
                </div>
              ) : (
                <div className="text-xs italic opacity-50">Loading file...</div>
              )}
            </div>
          ) : (
            <>
              {msg.content}
              {msg.edited && <span className="text-[9px] opacity-50 ml-1">(edited)</span>}
            </>
          )}
        </div>
      )}

      {/* Timestamp + status */}
      <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
        <span>{new Date(msg.ts).toLocaleTimeString()}</span>
        {isSent && <StatusIcon status={msg.status} />}
        {isSent && msg.status === 'failed' && (
          <button
            onClick={() => onRetry(msg.id)}
            className="flex items-center gap-0.5 text-red-400 hover:text-red-300 ml-1"
            title="Retry"
          >
            <RotateCcw size={10} /> retry
          </button>
        )}
      </div>
    </div>
  );
};

function CallDropdown({ onCall }: { onCall: (kind: 'audio' | 'video' | 'screen') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="flex">
        <button
          onClick={() => onCall('audio')}
          className="p-2 hover:bg-gray-800 rounded-l text-gray-400 hover:text-white"
          title="Audio Call"
        >
          <Phone size={17} />
        </button>
        <button
          onClick={() => setOpen(!open)}
          className="p-1 hover:bg-gray-800 rounded-r text-gray-400 hover:text-white border-l border-gray-700"
          title="Call options"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 w-44 py-1 anim-scale-up origin-top-right">
          <button
            onClick={() => { onCall('audio'); setOpen(false); }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
          >
            <Phone size={14} /> Audio call
          </button>
          <button
            onClick={() => { onCall('video'); setOpen(false); }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
          >
            <Video size={14} /> Video call
          </button>
          <button
            onClick={() => { onCall('screen'); setOpen(false); }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
          >
            <Monitor size={14} /> Screen share
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatArea({ pid, friendlyName, messages, onSendMessage, onSendFile, onCall, onBack, onContactInfo, onEditMessage, onDeleteMessage, onRetryMessage }: ChatAreaProps) {
  const [input, setInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSendMessage(input);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onSendFile(e.target.files[0]);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 anim-slide-right">
      <div className="p-3 border-b border-gray-800 bg-gray-900 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="md:hidden p-1.5 hover:bg-gray-800 rounded text-gray-400 hover:text-white">
            <ArrowLeft size={20} />
          </button>
          <button
            onClick={onContactInfo}
            className="text-left hover:opacity-75 transition-opacity"
            title="View contact info"
          >
            <div className="font-semibold text-gray-200">{friendlyName}</div>
            <div className="text-[11px] text-gray-500 font-mono">
              {pid.length > 28 ? pid.slice(0, 28) + '...' : pid}
            </div>
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onContactInfo} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Contact Info">
            <Info size={17} />
          </button>
          <CallDropdown onCall={onCall} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
        {[...messages].sort((a, b) => a.ts - b.ts).map((msg) => (
          <MessageItem
            key={msg.id || msg.ts}
            msg={msg}
            onEdit={onEditMessage}
            onDelete={onDeleteMessage}
            onRetry={onRetryMessage}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-gray-800 bg-gray-900 flex gap-2 items-center shrink-0">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white"
        >
          <Paperclip size={20} />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          className="hidden"
        />
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded p-2 text-gray-200 text-sm focus:outline-none focus:border-blue-500 resize-none h-10"
        />
        <button
          onClick={handleSend}
          className="p-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
