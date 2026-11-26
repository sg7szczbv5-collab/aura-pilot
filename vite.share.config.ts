import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { buildEnvironmentViolations } from './src/ops/buildGuards'

// One self-contained HTML file (dist-share/index.html) for sharing the whole ecosystem as a single page.
// Same payment rule as vite.config.ts: a mock-only (BETA / staging / Preview) build fails on any gateway setting.
export default defineConfig(({ mode }) => {
  const policy = buildEnvironmentViolations({ ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string | undefined>)
  if (policy.violations.length) {
    throw new Error(`AURA: unsafe build configuration (payment gateways in a mock-only build, secrets in the browser, or a BETA build not bound to the BETA project): ${policy.violations.join(', ')}`)
  }
  return {
    plugins: [react(), tailwindcss(), viteSingleFile()],
    define: { 'import.meta.env.VITE_AURA_PAYMENTS_MOCK_ONLY': JSON.stringify(policy.mockOnly ? '1' : '') },
    build: { outDir: 'dist-share', chunkSizeWarningLimit: 4000 },
  }
})
