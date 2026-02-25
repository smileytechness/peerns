import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { Copy, Share2, X, Link } from 'lucide-react';
import { APP_NAME } from '../lib/types';

interface ShareModalProps {
  pid: string;
  onClose: () => void;
}

export function ShareModal({ pid, onClose }: ShareModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const url = `${window.location.origin}${window.location.pathname}?connect=${encodeURIComponent(pid)}`;

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, url, {
        width: 200,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
    }
  }, [url]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // You might want to show a toast here
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Connect on ${APP_NAME}`,
          url: url,
        });
      } catch (err) {
        console.error('Share failed', err);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 anim-fade-in">
      <div className="bg-gray-900 border border-gray-800 p-6 rounded-xl w-80 shadow-2xl relative anim-scale-up">
        <button onClick={onClose} className="absolute top-2 right-2 text-gray-500 hover:text-white">
          <X size={20} />
        </button>
        <h3 className="text-lg font-semibold text-gray-200 mb-2 text-center">Share Your ID</h3>
        <p className="text-gray-400 text-xs mb-4 text-center">
          Others on any network can connect using these
        </p>
        <div className="flex justify-center bg-white p-2 rounded-lg mb-4">
          <canvas ref={canvasRef} />
        </div>
        <div className="text-xs text-gray-500 mb-1">Persistent ID</div>
        <div className="bg-gray-950 p-2 rounded text-blue-400 font-mono text-xs break-all mb-4">
          {pid}
        </div>
        <div className="flex gap-2 justify-center">
          <button
            onClick={() => copyToClipboard(pid)}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs"
          >
            <Copy size={14} /> Copy ID
          </button>
          <button
            onClick={() => copyToClipboard(url)}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs"
          >
            <Link size={14} /> Copy Link
          </button>
          {navigator.share && (
            <button
              onClick={share}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
            >
              <Share2 size={14} /> Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
