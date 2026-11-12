import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { driverPwa } from './build/pwa.ts'

// Backend for the dev-server /api proxy. The default matches running both
// apps on the host; docker-compose sets API_PROXY_TARGET to the backend
// service, because localhost inside the frontend container is itself.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000'

export default defineConfig({
  // driverPwa: the driver app's service worker, production builds only (FMS-34).
  plugins: [react(), driverPwa()],
  resolve: {
    alias: {
      // @/components, @/lib, @/hooks, ... -> src/ (mirrors tsconfig paths)
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true
    },
    proxy: {
      // Socket.IO (FMS-43), first so it wins over /api. The browser's Host is
      // kept, so the API sees a same-origin socket and needs no allow-list.
      '/api/v1/socket.io': {
        target: apiProxyTarget,
        ws: true,
      },
      // The browser's Host is kept here too (no changeOrigin): the API's CSRF check (FMS-103) compares the page's Origin
      // (localhost:5173) with the Host it receives, and a rewritten Host (backend:3000) would refuse every write. This is what the
      // production nginx does (proxy_set_header Host $http_host).
      '/api': {
        target: apiProxyTarget,
      },
    },
  }
})
