import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: `npm run dev` proxies the API to the Node server on :8787.
// Prod: `npm run build` -> dist/, served by the same Node server.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5174, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { sourcemap: false },
})
