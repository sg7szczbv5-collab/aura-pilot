import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { buildEnvironmentViolations } from './src/ops/buildGuards'
import { nextPublicDefines } from './src/config/publicEnvKeys'

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
  define: { 'import.meta.env.VITE_AURA_PAYMENTS_MOCK_ONLY': JSON.stringify(policy.mockOnly ? '1' : ''), ...nextPublicDefines(env) },
  base: './',
  // C2: only VITE_* by prefix. NEXT_PUBLIC_* reach the browser only when allowlisted
  // (src/config/publicEnvKeys.ts, via define above), so an integration's NEXT_PUBLIC_SUPABASE_*
  // never does. NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN still works as before.
  envPrefix: ['VITE_'],
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
