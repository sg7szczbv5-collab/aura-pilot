/**
 * Runtime check for BETA builds: after every sign-in the app asks the database which environment it
 * belongs to (public.my_environment(), migration 024). Anything but 'beta' — production (no beta
 * marker), a database without migration 024, an error — signs the user out and stops the app.
 * Complements the build-time binding (src/ops/buildGuards.ts).
 */
type Rpc = { rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }> }

export async function verifyBetaBackend(client: Rpc, signOut: () => Promise<unknown>): Promise<boolean> {
  let mode: unknown = null
  try {
    const { data, error } = await client.rpc('my_environment')
    mode = error ? null : data
  } catch {
    mode = null
  }
  if (mode === 'beta') return true
  try {
    await signOut()
  } catch {
    /* signed out locally anyway */
  }
  return false
}

export function blockApp(doc: { body: { innerHTML: string } } = document): void {
  doc.body.innerHTML =
    '<div dir="rtl" style="font-family:sans-serif;padding:32px;max-width:560px;margin:48px auto;text-align:center">' +
    '<h1 style="font-size:20px">نسخة BETA غير متصلة بخادم BETA</h1>' +
    '<p>تم إيقاف التطبيق وتسجيل الخروج لأن الخادم ليس بيئة BETA المعتمدة.</p>' +
    '<p dir="ltr" style="color:#666">This BETA build is not connected to the BETA backend; it has been stopped and signed out.</p></div>'
}
