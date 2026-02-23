import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface MediaOverlayProps {
  stream: MediaStream;
  localStream?: MediaStream;
  fname: string;
  kind: string;
  onEnd: () => void;
}

export function MediaOverlay({ stream, localStream, fname, kind, onEnd }: MediaOverlayProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
    }
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [stream, localStream]);

  return (
    <div className="fixed inset-0 bg-black/95 z-[100] flex flex-col items-center justify-center">
      <div className="absolute top-4 left-4 text-gray-400 text-sm">
        {kind === 'screen' ? '📺 Screen share' : '📞 Call'} with <span className="text-white font-semibold">{fname}</span>
      </div>
      
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className="max-w-[90vw] max-h-[80vh] rounded-lg bg-black"
      />
      
      {localStream && kind !== 'screen' && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-4 right-4 w-32 rounded-lg bg-gray-900 border border-gray-700"
        />
      )}

      <button
        onClick={onEnd}
        className="absolute bottom-8 px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full font-semibold shadow-lg transition-transform hover:scale-105"
      >
        End Call
      </button>
    </div>
  );
}
