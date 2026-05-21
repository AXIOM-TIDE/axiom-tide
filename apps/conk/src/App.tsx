import { useState, useEffect } from 'react'
import { useStore } from './store/store'
import { Onboarding } from './pages/Onboarding'
import { HarborHome } from './pages/HarborHome'
import { VesselSelect } from './pages/VesselSelect'
import { VesselHome } from './pages/VesselHome'
import { Legal } from './pages/Legal'
import { ZkLoginButton } from './components/ZkLoginButton'
import { ConkHomeScreen } from './pages/ConkHomeScreen'
import { AgentsLanding } from './pages/AgentsLanding'
import { AboutPage }     from './pages/AboutPage'
import { PrimitivesPage } from './pages/PrimitivesPage'
import { isLoggedIn, handleZkLoginCallback, startZkLogin, getSession } from './sui/zklogin'
import { isWalletSession } from './sui/walletSession'
import { provisionOnChainIdentity } from './sui/bridge'

type Screen = 'harbor' | 'vessels' | 'vessel'

export default function App() {
  const isOnboarded                        = useStore((s) => s.isOnboarded)
  const vessel                             = useStore((s) => s.vessel)
  const { setOnboarded, addVessel, setHarbor } = useStore()
  const [screen, setScreen]               = useState<Screen>('harbor')
  const [showConnectModal, setShowConnectModal] = useState(false)
  const [showLegal, setShowLegal]          = useState(false)
  const [connected, setConnected]          = useState(false)
  const [checking, setChecking]            = useState(true)
  // restoring = silently re-hydrating existing on-chain identity after fresh login
  const [restoring, setRestoring]          = useState(false)

  useEffect(() => {
    const handler = () => setShowLegal(true)
    window.addEventListener('conk:legal', handler)
    return () => window.removeEventListener('conk:legal', handler)
  }, [])

  useEffect(() => {
    // Detect Flare deep link — /cast/:id
    const flareMatch = window.location.pathname.match(/^\/cast\/(.+)$/)
    if (flareMatch) {
      sessionStorage.setItem('conk:pending_flare', flareMatch[1])
      window.history.replaceState({}, '', '/')
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      // Handle OAuth callback
      if (window.location.hash.includes('id_token')) {
        try {
          await handleZkLoginCallback()
        } catch (e) {
          console.error('zkLogin callback failed:', e)
        }
      }
      setConnected(isLoggedIn() || isWalletSession())
      setChecking(false)
    }
    init()
  }, [])

  // Listen for connection events from ZkLoginButton
  useEffect(() => {
    const check = () => setConnected(isLoggedIn() || isWalletSession())
    window.addEventListener('storage', check)
    // Poll every second for session changes
    return () => window.removeEventListener('storage', check)
  }, [])

  // Auto-restore on-chain identity after fresh login.
  // Runs once when the user is connected but the local store is empty.
  // If Harbor + Vessel already exist on-chain: silently restore them and skip
  // the onboarding flow entirely — no charge, no user friction.
  // If nothing exists on-chain: fall through to normal Onboarding.
  useEffect(() => {
    if (!connected || isOnboarded || restoring) return
    const session = getSession()
    if (!session) return

    setRestoring(true)
    provisionOnChainIdentity(session)
      .then((provision) => {
        if (provision.funded && provision.vesselId && provision.alreadyExisted) {
          // Identity exists on-chain — restore local state without any charge
          const now = Date.now()
          const yr  = 365 * 24 * 60 * 60 * 1000
          addVessel({
            id:          provision.vesselId,
            onChainId:   provision.vesselId,
            vesselCapId: provision.vesselCapId ?? undefined,
            class:       'vessel',
            tempOrPerm:  'perm',
            createdAt:   now,
            lastCastAt:  null,
            expiresAt:   now + yr,
            fuel:        0,
            fuelDrawing: true,
            autoBurn:    true,
          })
          setHarbor({
            balance:      0,
            tier:         1,
            lastMovement: now,
            expiresAt:    now + yr,
            onChainId:    provision.harborId ?? undefined,
            harborCapId:  provision.harborCapId ?? undefined,
          })
          setOnboarded(true)
        }
      })
      .catch((err) => console.warn('[App] identity restore failed:', err))
      .finally(() => setRestoring(false))
  }, [connected, isOnboarded])

  if (checking || restoring) return null

  if (window.location.pathname === '/about') {
    return <AboutPage />
  }

  if (window.location.pathname === '/primitives') {
    return <PrimitivesPage />
  }

  if (window.location.pathname === '/agents') {
    return <AgentsLanding onConnect={async () => {
      try { await startZkLogin() } catch(e) { console.error(e) }
    }} />
  }

  // Gate 1 — Must connect first
  if (!connected) {
    return <ConkHomeScreen onConnect={async () => {
      try { await startZkLogin() } catch(e) { console.error(e) }
    }} />
  }

  // Gate 2 — Must complete onboarding (only reached if no on-chain identity found)
  if (!isOnboarded) return <Onboarding />

  return (
    <>
      {showLegal && <Legal onClose={() => setShowLegal(false)}/>}
      {screen === 'vessel' && vessel && (
        <VesselHome onBack={() => setScreen('harbor')}/>
      )}
      {screen === 'vessels' && (
        <VesselSelect onEnter={() => setScreen('vessel')} onBack={() => setScreen('harbor')}/>
      )}
      {screen === 'harbor' && (
        <HarborHome onEnterVessel={() => setScreen('vessels')}/>
      )}
    </>
  )
}
