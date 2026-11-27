import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { buildEnvironmentViolations } from './src/ops/buildGuards'
import { nextPublicDefines } from './src/config/publicEnvKeys'

// One self-contained HTML file (dist-share/index.html) for sharing the whole ecosystem as a single page.
// Same payment rule as vite.config.ts: a mock-only (BETA / staging / Preview) build fails on any gateway setting.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string | undefined>
  const policy = buildEnvironmentViolations(env)
  if (policy.violations.length) {
    throw new Error(`AURA: unsafe build configuration (payment gateways in a mock-only build, secrets in the browser, or a BETA build not bound to the BETA project): ${policy.violations.join(', ')}`)
  }
  return {
    plugins: [react(), tailwindcss(), viteSingleFile()],
    // C2: same rule as vite.config.ts — VITE_* by prefix (the default), allowlisted NEXT_PUBLIC_* only.
    define: { 'import.meta.env.VITE_AURA_PAYMENTS_MOCK_ONLY': JSON.stringify(policy.mockOnly ? '1' : ''), ...nextPublicDefines(env) },
    envPrefix: ['VITE_'],
    build: { outDir: 'dist-share', chunkSizeWarningLimit: 4000 },
  }
})
