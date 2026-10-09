import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// `npm run dev` sends API calls to this backend. Default: the shared dev
// server, so screen work needs no Asterisk or database on your laptop.
const API = process.env.DIALFORGE_API ?? 'https://dialforge.ddnsfree.com:3000';
const API_PREFIXES = ['/auth', '/admin', '/agent', '/leads', '/calls', '/queues', '/health'];

export default defineConfig({
  // The backend serves this app at /app (old pages keep their URLs).
  base: '/app/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Built straight into the backend, which serves it - one folder to deploy.
    outDir: '../backend/web-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(API_PREFIXES.map((p) => [p, { target: API, changeOrigin: true }])),
      '/ws': { target: API, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Screen tests type into big forms; under a full parallel run 5 s isn't enough.
    testTimeout: 20_000,
  },
});
