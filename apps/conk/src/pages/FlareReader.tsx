/**
 * FlareReader — Dock invitation + cast read for /cast/:id deep links
 *
 * User journey:
 *   1. User clicks email link → lands on app
 *   2. App.tsx captures cast ID into sessionStorage['conk:pending_flare']
 *   3. VesselHome detects pendingFlare, renders this component
 *   4. fetchCastById() resolves the on-chain cast
 *   5. User sees Dock invitation with hook, price, description
 *   6. User taps "Enter Dock" → readCast() calls Move cast::read
 *   7. Body reveals on-chain read success
 *   8. User taps Close → clears pending flare, returns to Drift
 */
import { useEffect, useState } from 'react'
import { fetchCastById, readCast, fetchCastBodyRaw, type OnChainCastView } from '../sui/client'

type ReaderState = 'loading' | 'invitation' | 'paying' | 'revealed' | 'error'

interface Props {
  castId:  string
  onClose: () => void
}

export function FlareReader({ castId, onClose }: Props) {
  const [state, setState]   = useState<ReaderState>('loading')
  const [cast,  setCast]    = useState<OnChainCastView | null>(null)
  const [error, setError]   = useState<string>('')
  const [body,  setBody]    = useState<string>('')

  // ── Fetch cast on mount ──
  useEffect(() => {
    let cancelled = false
    fetchCastById(castId).then(result => {
      if (cancelled) return
      if (!result) {
        setError('Cast not found. It may have expired or been burned.')
        setState('error')
        return
      }
      if (result.burned) {
        setError('This cast has been burned and is no longer readable.')
        setState('error')
        return
      }
      if (!result.isLighthouse && result.expiresAt < Date.now()) {
        setError('This cast expired on ' + new Date(result.expiresAt).toLocaleString() + '.')
        setState('error')
        return
      }
      if (result.isDockFull) {
        setError('This Dock is full. No more readers can enter.')
        setState('error')
        return
      }
      setCast(result)
      setState('invitation')
    }).catch(err => {
      if (cancelled) return
      setError(err?.message ?? 'Failed to fetch cast')
      setState('error')
    })
    return () => { cancelled = true }
  }, [castId])

  // ── Pay and read ──
  const handleEnterDock = async () => {
    if (!cast) return
    setState('paying')
    try {
      // For free casts, contract still expects a payment coin — send $0.01
      // For paid casts, send the full fee_paid amount
      const payAmount = cast.feePaid > 0 ? cast.feePaid : 10000  // 10000 microUSDC = $0.01
      // Fetch raw content BEFORE readCast() — EYES_ONLY Docks burn content_blob in the same
      // on-chain tx as the read. fetchCastBodyRaw() bypasses the blank in fetchCastById().
      const preReadBody = await fetchCastBodyRaw(cast.id)
      await readCast({ castId: cast.id, amountUsdc: payAmount })
      // Use pre-read body since contract clears content_blob when Dock fills
      setBody(preReadBody)

      // Save received Flare for Dock inbox
      const received = JSON.parse(localStorage.getItem('conk:received_flares') || '[]')
      received.push({
        castId: cast.id,
        hook: cast.hook,
        body: preReadBody,
        author: cast.author,
        feePaid: cast.feePaid,
        readAt: Date.now(),
      })
      localStorage.setItem('conk:received_flares', JSON.stringify(received))

      setState('revealed')
    } catch (err: any) {
      console.error('[FlareReader] read failed:', err)
      setError(err?.message ?? 'Read failed — payment may have been refunded')
      setState('error')
    }
  }

  const handleClose = () => {
    sessionStorage.removeItem('conk:pending_flare')
    onClose()
  }

  // ── Render ──
  const priceUsd = cast ? (cast.feePaid / 1_000_000).toFixed(2) : '0.10'

  return (
    <div className="shell" style={{display:'flex',flexDirection:'column',height:'100%'}}>
      {/* Top bar */}
      <div style={{
        display:'flex', alignItems:'center', gap:'10px',
        padding:'0 14px', height:'52px',
        background:'rgba(3,12,20,0.92)', backdropFilter:'blur(20px)',
        borderBottom:'1px solid var(--border2)',
        flexShrink:0,
      }}>
        <button onClick={handleClose}
          style={{background:'transparent',border:'none',color:'var(--text-dim)',cursor:'pointer',padding:'4px 8px',fontFamily:'var(--font-mono)',fontSize:'11px'}}>
          ← Drift
        </button>
        <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)',letterSpacing:'0.1em'}}>
          FLARE · DOCK INVITATION
        </div>
      </div>

      {/* Body */}
      <div style={{flex:1,overflow:'auto',padding:'20px 16px'}}>

        {state === 'loading' && (
          <div style={{padding:'40px 20px',textAlign:'center',color:'var(--text-off)',fontFamily:'var(--font-mono)',fontSize:'11px'}}>
            Fetching cast from Sui...
          </div>
        )}

        {state === 'error' && (
          <div style={{padding:'20px',background:'var(--burn-dim)',border:'1px solid var(--burn-line)',borderRadius:'var(--radius-lg)'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--burn)',marginBottom:'8px'}}>
              ⚠ Cannot enter Dock
            </div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)',lineHeight:1.6}}>
              {error}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={handleClose} style={{marginTop:'16px'}}>
              Back to Drift
            </button>
          </div>
        )}

        {state === 'invitation' && cast && (
          <div style={{padding:'20px',background:'var(--surface)',border:'1px solid var(--eyes)',borderRadius:'var(--radius-lg)'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--eyes)',letterSpacing:'0.1em',marginBottom:'12px'}}>
              EYES ONLY · FLARE INVITATION
            </div>
            <div style={{fontSize:'17px',color:'var(--text)',lineHeight:1.4,marginBottom:'16px',wordBreak:'break-word'}}>
              {cast.hook}
            </div>
            {cast.dockDescription && (
              <div style={{fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--text-dim)',lineHeight:1.6,marginBottom:'16px',padding:'12px',background:'var(--surface2)',borderRadius:'var(--radius)'}}>
                {cast.dockDescription}
              </div>
            )}
            <div style={{display:'flex',justifyContent:'space-between',fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)',marginBottom:'4px'}}>
              <span>Read price</span>
              <span style={{color:'var(--text)'}}>${priceUsd}</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)',marginBottom:'4px'}}>
              <span>Dock seats</span>
              <span style={{color:'var(--text)'}}>{cast.claimsUsed} of {cast.maxClaims} taken</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)',marginBottom:'16px'}}>
              <span>Expires</span>
              <span style={{color:'var(--text)'}}>{new Date(cast.expiresAt).toLocaleString()}</span>
            </div>
            <button className="btn btn-primary btn-full" onClick={handleEnterDock}>
              {cast.feePaid > 0 ? `Enter Dock · ${priceUsd}` : 'Open Reply'}
            </button>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'10px',lineHeight:1.6}}>
              97% of read price routes to the author · 3% to CONK treasury · cast burns when Dock fills
            </div>
          </div>
        )}

        {state === 'paying' && (
          <div style={{padding:'40px 20px',textAlign:'center'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--eyes)',marginBottom:'8px'}}>
              Entering Dock...
            </div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)',lineHeight:1.6}}>
              Processing on-chain read. This takes a few seconds.
            </div>
          </div>
        )}

        {state === 'revealed' && cast && (
          <div>
            <div style={{padding:'20px',background:'var(--surface)',border:'1px solid var(--border2)',borderRadius:'var(--radius-lg)',marginBottom:'16px'}}>
              <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--teal)',letterSpacing:'0.1em',marginBottom:'12px'}}>
                ✓ DOCK ENTERED · CAST READ
              </div>
              <div style={{fontSize:'17px',color:'var(--text)',lineHeight:1.4,marginBottom:'16px',wordBreak:'break-word'}}>
                {cast.hook}
              </div>
              <div style={{fontSize:'13px',color:'var(--text-dim)',lineHeight:1.7,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>
                {body || '(no body content)'}
              </div>
            </div>
            <div style={{display:'flex',gap:'8px'}}>
              <button className="btn btn-primary" style={{flex:1}} onClick={() => {
                // Save reply context so CastPanel can pre-fill
                sessionStorage.setItem('conk:reply_context', JSON.stringify({
                  replyTo: cast.hook,
                  authorAddress: cast.author,
                  originalCastId: cast.id,
                }))
                sessionStorage.removeItem('conk:pending_flare')
                // Signal VesselHome to switch to Cast tab in Flare mode
                window.dispatchEvent(new CustomEvent('conk:reply_flare'))
                onClose()
              }}>
                Reply with Flare
              </button>
              <button className="btn btn-ghost" style={{flex:1}} onClick={handleClose}>
                Close
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
