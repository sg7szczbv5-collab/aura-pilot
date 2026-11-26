import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { buildEnvironmentViolations } from './src/ops/buildGuards'

export default defineConfig(({ mode }) => {
  // BETA / staging / Vercel Preview builds are mock-only (F3): fail the build on any payment-gateway
  // setting, and tell the bundle it is mock-only so the browser guard is installed.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string | undefined>
  const policy = buildEnvironmentViolations(env)
  if (policy.violations.length) {
    throw new Error(`AURA: unsafe build configuration (payment gateways in a mock-only build, secrets in the browser, or a BETA build not bound to the BETA project): ${policy.violations.join(', ')}`)
  }
  return {
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_AURA_PAYMENTS_MOCK_ONLY': JSON.stringify(policy.mockOnly ? '1' : '') },
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
}
})
