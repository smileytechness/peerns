import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      basicSsl(),
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: { enabled: true },
        workbox: {
          globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
          navigateFallback: 'index.html',
          // Take control of pages immediately on update — phone gets new code
          // as soon as it reconnects to WiFi and the SW detects an update.
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              // Never cache PeerJS signaling — always needs live network
              urlPattern: /^https:\/\/0\.peerjs\.com\/.*/i,
              handler: 'NetworkOnly',
            },
            {
              // Cache STUN/IP detection calls network-first, fall back to cache
              urlPattern: /^https:\/\/api\.ipify\.org\/.*/i,
              handler: 'NetworkFirst',
              options: { cacheName: 'ip-detection', networkTimeoutSeconds: 3 },
            },
          ],
        },
        manifest: {
          name: 'myapp P2P',
          short_name: 'myapp',
          description: 'Serverless peer-to-peer messenger',
          theme_color: '#0d1117',
          background_color: '#0d1117',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      host: '0.0.0.0',
      port: 3000,
    },
  };
});
