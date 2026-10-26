import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In sviluppo (npm run dev) Vite gira su 5173 e passa API e WebSocket al server su 3001.
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
