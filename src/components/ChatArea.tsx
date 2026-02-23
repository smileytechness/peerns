import React, { useState, useEffect, useRef } from 'react';
import { ChatMessage } from '../lib/types';
import { loadFile, loadFileMeta } from '../lib/store';
import { Send, Paperclip, Phone, Video, Monitor, Download, File, ArrowLeft, Info } from 'lucide-react';
import { clsx } from 'clsx';

interface ChatAreaProps {
  pid: string;
  friendlyName: string;
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onSendFile: (file: File) => void;
  onCall: (kind: 'audio' | 'video' | 'screen') => void;
  onBack: () => void;
  onContactInfo: () => void;
}

const MessageItem: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const [fileData, setFileData] = useState<string | null>(null);
  const [meta, setMeta] = useState<any>(null);

  useEffect(() => {
    if (msg.type === 'file' && msg.tid) {
      loadFile(msg.tid).then(setFileData);
      setMeta(loadFileMeta(msg.tid));
    }
  }, [msg]);

  const isSent = msg.dir === 'sent';

  return (
    <div className={clsx("flex flex-col mb-2 max-w-[70%]", isSent ? "self-end items-end" : "self-start items-start")}>
      <div
        className={clsx(
          "p-2 rounded-lg text-sm break-words",
          isSent ? "bg-blue-600 text-white rounded-br-none" : "bg-gray-800 text-gray-200 rounded-bl-none"
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
          msg.content
        )}
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1">
        <span>{new Date(msg.ts).toLocaleTimeString()}</span>
        {isSent && (
          <span className={clsx(
            msg.status === 'delivered' ? 'text-blue-400' :
            msg.status === 'sent'      ? 'text-gray-400' :
                                         'text-gray-600'
          )}>
            {msg.status === 'delivered' ? '✓✓' : msg.status === 'sent' ? '✓' : '⏳'}
          </span>
        )}
      </div>
    </div>
  );
}

export function ChatArea({ pid, friendlyName, messages, onSendMessage, onSendFile, onCall, onBack, onContactInfo }: ChatAreaProps) {
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
    <div className="flex flex-col h-full bg-gray-900">
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
              {pid.length > 28 ? pid.slice(0, 28) + '…' : pid}
            </div>
          </button>
        </div>
        <div className="flex gap-1">
          <button onClick={onContactInfo} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Contact Info">
            <Info size={17} />
          </button>
          <button onClick={() => onCall('audio')} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Audio Call">
            <Phone size={17} />
          </button>
          <button onClick={() => onCall('video')} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Video Call">
            <Video size={17} />
          </button>
          <button onClick={() => onCall('screen')} className="p-2 hover:bg-gray-800 rounded text-gray-400 hover:text-white" title="Screen Share">
            <Monitor size={17} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.map((msg) => (
          <MessageItem key={msg.id || msg.ts} msg={msg} />
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
