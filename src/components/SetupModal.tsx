import React, { useState } from 'react';

interface SetupModalProps {
  onJoin: (name: string) => void;
}

export function SetupModal({ onJoin }: SetupModalProps) {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onJoin(name.trim());
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-800 p-8 rounded-xl w-80 shadow-2xl">
        <h2 className="text-2xl font-bold text-blue-500 mb-2">myapp</h2>
        <p className="text-gray-400 text-sm mb-6">Serverless P2P — proof of concept</p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your friendly name"
            className="w-full bg-gray-950 border border-gray-800 rounded p-3 text-gray-200 mb-4 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <button
            type="submit"
            className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded transition-colors"
          >
            Join
          </button>
        </form>
      </div>
    </div>
  );
}
