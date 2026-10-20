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
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  }
})
