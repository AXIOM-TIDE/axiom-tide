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
import { isLoggedIn, handleZkLoginCallback, startZkLogin } from './sui/zklogin'
import { isWalletSession } from './sui/walletSession'

type Screen = 'harbor' | 'vessels' | 'vessel'

export default function App() {
  const isOnboarded = useStore((s) => s.isOnboarded)
  const vessel      = useStore((s) => s.vessel)
  const [screen, setScreen]     = useState<Screen>('harbor')
  const [showConnectModal, setShowConnectModal] = useState(false)
  const [showLegal, setShowLegal] = useState(false)
  const [connected, setConnected] = useState(false)
  const [checking, setChecking]   = useState(true)

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

  if (checking) return null

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

  // Gate 2 — Must complete onboarding
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
