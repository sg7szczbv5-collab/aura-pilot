import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // NEXT_PUBLIC_* too, so a NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN set in Vercel reaches the browser.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  build: { chunkSizeWarningLimit: 1600 },
  server: { host: true, port: 5180 },
  preview: { host: true, port: 4180 },
  test: {
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
  },
})
