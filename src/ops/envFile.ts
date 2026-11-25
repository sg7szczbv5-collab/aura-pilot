import type { Env } from './configChecks'

/** Minimal .env parser (KEY=value, comments, quotes, `export`). Never evaluates anything. */
export function parseEnvFile(text: string): Env {
  const env: Env = {}
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '').trim()
    env[m[1]] = v
  }
  return env
}
