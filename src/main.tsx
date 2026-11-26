import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans-arabic/300.css'
import '@fontsource/ibm-plex-sans-arabic/400.css'
import '@fontsource/ibm-plex-sans-arabic/500.css'
import '@fontsource/ibm-plex-sans-arabic/600.css'
import '@fontsource/ibm-plex-sans-arabic/700.css'
import '@fontsource/readex-pro/400.css'
import '@fontsource/readex-pro/500.css'
import '@fontsource/readex-pro/600.css'
import '@fontsource/readex-pro/700.css'
import './styles/index.css'
import { App } from './app/App'
import { I18nProvider } from './i18n/I18n'
import { startDispatcher } from './core/store'
import { PAYMENT_POLICY } from './payments/cards'
import { installPaymentNetworkGuard } from './payments/networkGuard'
import { AUTH_MODE } from './auth/config'
import { getSupabase } from './auth/supabaseClient'
import { blockApp, verifyBetaBackend } from './ops/betaBackendGuard'

// BETA / staging / Preview: no request may reach a payment gateway, whatever the settings say.
installPaymentNetworkGuard(PAYMENT_POLICY.mockOnly)
// BETA builds only work against the BETA database: checked after every sign-in (migration 024).
if (PAYMENT_POLICY.mockOnly && AUTH_MODE === 'supabase') {
  const sb = getSupabase()
  sb.auth.onAuthStateChange((_event, session) => {
    if (session) void verifyBetaBackend(sb, () => sb.auth.signOut()).then((ok) => { if (!ok) blockApp() })
  })
}
startDispatcher()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
