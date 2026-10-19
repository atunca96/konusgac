import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/gateway': { target: server, ws: true },
    },
  },
});
