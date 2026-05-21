import { fetchDriftCasts, fetchCastBodyRaw, readCast, decryptCastBody } from '../sui/client'
import { useState, useEffect, useRef } from 'react'
import { useStore, type Cast, type CastMode } from '../store/store'
import { useSoundCast } from '../hooks/use402'
import { formatTide, timeUntilExpiry, formatTimeAgo, castDurationMs, getTideState, getTideLabel } from '../utils/scrubber'
import { DecayBadge } from './DecayBadge'
import { WreckModal } from './WreckModal'
import { SecurityModal } from './SecurityModal'
import { VesselSelectModal } from './VesselSelectModal'
import { PaywayModal } from './PaywayModal'

function formatPrice(microUsdc: number): string {
  const usdc = microUsdc / 1000000
  if (usdc < 0.01) return `$${usdc.toFixed(3)}`
  if (usdc < 1) return `$${usdc.toFixed(3)}`
  return `$${usdc.toFixed(2)}`
}


const MODE_FILTERS: { id: 'all'|CastMode; label: string }[] = [
  { id:'all',  label:'all'  },
  { id:'open', label:'open' },
  { id:'burn', label:'burn' },
]

export function DriftFeed() {
  const casts        = useStore((s) => s.driftCasts)
  const setDriftCasts = useStore((s) => s.setDriftCasts)

  // Fetch Open casts from Sui on mount — populates Drift with real on-chain data
  useEffect(() => {
    fetchDriftCasts().then(onChain => {
      if (onChain.length === 0) return
      // Merge on-chain casts with local casts, deduplicate by id
      const existing = new Set(useStore.getState().driftCasts.map(c => c.id))
      const newCasts = onChain
        .filter(c => !existing.has(c.id))
        .map(c => ({
          ...c,
          duration: '24h' as const,
          lastInteractionAt: c.createdAt,
          tideCount: c.readCount,
          tideReads: [],
        }))
      if (newCasts.length > 0) {
        setDriftCasts([...newCasts, ...useStore.getState().driftCasts])
      }
    }).catch(err => console.warn('[Drift] on-chain fetch failed:', err))
  }, [])
  const filter       = useStore((s) => s.driftFilter)
  const searchQuery  = useStore((s) => s.driftSearch)
  const setFilter    = useStore((s) => s.setDriftFilter)
  const setSearch    = useStore((s) => s.setDriftSearch)
  const vessel       = useStore((s) => s.vessel)
  const incTide      = useStore((s) => s.incrementTide)
  const [newCount, setNewCount] = useState(0)
  const feedRef   = useRef<HTMLDivElement>(null)
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    const iv = setInterval(() => {
      const { driftCasts } = useStore.getState()
      const hot = driftCasts.filter(c => c.tideCount > 500)
      if (!hot.length) return
      incTide(hot[Math.floor(Math.random() * hot.length)].id)
    }, 3000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    const iv = setInterval(() => setNewCount(n => n + 1), 25000)
    return () => clearInterval(iv)
  }, [])

  const vesselId = vessel?.id ?? ''
  const now      = Date.now()

  const filtered = casts
    .filter(c => !c.burned)
    .filter(c => !vesselId || !(c.burnedBy ?? []).includes(vesselId))
    .filter(c => c.mode !== 'eyes_only')  // Flares are private — never shown in Drift
    .filter(c => filter === 'all' ? true : c.mode === filter)
    .filter(c => {
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase()
      return (
        c.hook.toLowerCase().includes(q) ||
        (c.keywords ?? []).some(k => k.toLowerCase().includes(q))
      )
    })

  return (
    <div className="drift-col">
      {/* Filter bar */}
      <div className="drift-filter-bar">
        <span style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',letterSpacing:'0.12em',textTransform:'uppercase',flexShrink:0,marginRight:'4px'}}>DRIFT</span>
        {MODE_FILTERS.map(f => (
          <button key={f.id} className={`chip ${filter===f.id?'active':''}`} data-testid={`filter-${f.id === 'eyes_only' ? 'eyes-only' : f.id}`}
            style={{fontSize:'10px',padding:'3px 9px',flexShrink:0}}
            onClick={() => setFilter(f.id as any)}>{f.label}
          </button>
        ))}
        {/* Search toggle */}
        <button
          onClick={() => { setShowSearch(!showSearch); if(showSearch) setSearch('') }}
          data-testid="search-toggle"
          style={{marginLeft:'4px',padding:'3px 8px',background:showSearch?'var(--teal-dim)':'none',border:`1px solid ${showSearch?'var(--border3)':'var(--border)'}`,borderRadius:'var(--radius)',color:showSearch?'var(--teal)':'var(--text-off)',fontFamily:'var(--font-mono)',fontSize:'10px',cursor:'pointer',transition:'all 0.12s',flexShrink:0}}>
          ⌕
        </button>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'4px',fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--teal)',opacity:0.7,flexShrink:0}}>
          <div style={{width:'4px',height:'4px',borderRadius:'50%',background:'var(--teal)',animation:'livePulse 2.5s ease-in-out infinite'}}/>
          live
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div style={{display:'flex',alignItems:'center',gap:'8px',padding:'8px 12px',borderBottom:'1px solid var(--border)',background:'var(--surface)',flexShrink:0}}>
          <input
            data-testid="search-input"
            value={searchQuery}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search signals by hook or keyword..."
            style={{flex:1,background:'var(--surface2)',border:'1px solid var(--border2)',borderRadius:'var(--radius)',color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'11px',padding:'7px 10px',outline:'none'}}
            autoFocus
          />
          {searchQuery && (
            <button onClick={() => setSearch('')} data-testid="search-clear-btn"
              style={{background:'none',border:'none',color:'var(--text-dim)',fontFamily:'var(--font-mono)',fontSize:'11px',cursor:'pointer',padding:'4px'}}>
              ✕
            </button>
          )}
          {searchQuery && (
            <span data-testid="search-result-count" style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',flexShrink:0}}>
              {filtered.length} result{filtered.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      {newCount > 0 && (
        <button onClick={() => { setNewCount(0); feedRef.current?.scrollTo({top:0,behavior:'smooth'}) }}
          style={{border:'none',borderBottom:'1px solid var(--border3)',background:'rgba(0,184,230,0.07)',color:'var(--teal)',fontFamily:'var(--font-mono)',fontSize:'10px',padding:'7px',cursor:'pointer',flexShrink:0,letterSpacing:'0.04em'}}>
          {newCount} new cast{newCount>1?'s':''} in the tide
        </button>
      )}

      <div className="drift-feed" ref={feedRef}>
        {!vessel && (
          <div style={{margin:'12px',padding:'12px',background:'var(--surface)',border:'1px solid var(--border2)',borderRadius:'var(--radius-lg)',fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--text-dim)',lineHeight:1.6}}>
            Signal requires payment. Drift hooks open through vessels. Signals survive by interaction — otherwise, they sink.
          </div>
        )}

        {searchQuery && filtered.length === 0 && (
          <div style={{padding:'40px 20px',textAlign:'center',color:'var(--text-off)',fontFamily:'var(--font-mono)',fontSize:'11px'}}>
            No signals match "{searchQuery}"
          </div>
        )}

        {filtered.map((cast, i) => (
          <CastRow key={cast.id} cast={cast} index={i}/>
        ))}

        {filtered.length > 0 && (
          <div style={{padding:'20px 16px',textAlign:'center',fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',letterSpacing:'0.06em',lineHeight:1.8}}>
            {formatTide(filtered.reduce((a,c) => a+c.tideCount, 0))} reads · the tide decides<br/>
            <span style={{opacity:0.5}}>Signals survive by interaction. Otherwise, they sink.</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── CAST ROW ─────────────────────────────────────────────────

type UnlockStep =
  | 'idle'
  | 'expanded'
  | 'vessel_select'
  | 'payway'
  | 'eyes_map'
  | 'security'
  | 'unlocked'

function CastRow({ cast, index }: { cast: Cast; index: number; key?: string }) {
  const vessel          = useStore((s) => s.vessel)
  const vessels         = useStore((s) => s.vessels)
  const markCastRead    = useStore((s) => s.markCastRead)
  const burnCast        = useStore((s) => s.burnCast)
  const burnFromVessel  = useStore((s) => s.burnFromVessel)
  const storeForVessel  = useStore((s) => s.storeForVessel)
  const debitVessel     = useStore((s) => s.debitVessel)
  const debitHarbor     = useStore((s) => s.debitHarbor)
  const { sound, status: soundSt }  = useSoundCast()
  const [isPaying,     setIsPaying]     = useState(false)
  const [pendingBody,  setPendingBody]  = useState('')

  const [step,          setStep]          = useState<UnlockStep>('idle')
  const [mapVal,        setMapVal]        = useState('')
  const [mapError,      setMapError]      = useState(false)
  const [securityError, setSecurityError] = useState(false)
  const [burnCount,     setBurnCount]     = useState<number|null>(null)
  const [showReturn,    setShowReturn]    = useState(false)
  const [returnHook,    setReturnHook]    = useState('')
  const [returnDone,    setReturnDone]    = useState(false)
  const [showWreck,     setShowWreck]     = useState(false)
  const [stored,        setStored]        = useState(false)

  const now            = Date.now()
  const isSoundPending = soundSt === 'pending'
  // Paid casts arrive with body='' from fetchCastById — only unlock after readCast() confirms.
  // Free casts and own casts have real body content from the store.
  const isUnlocked     = step === 'unlocked' || (cast.body !== undefined && cast.body !== '')
  const isBurn         = cast.mode === 'burn'
  const isEyes         = cast.mode === 'eyes_only'
  const isOpen         = cast.mode === 'open'
  const hasSecurityQ   = !!cast.securityQuestion
  const isOwn          = !!cast.vesselId && cast.vesselId === vessel?.id
  const vesselFuel     = vessel?.fuel ?? 0
  const autofuel       = vessel?.fuelDrawing ?? true
  const autoBurn       = vessel?.autoBurn ?? true
  const isStoredByMe   = vessel?.id ? (cast.storedBy ?? []).includes(vessel.id) : false
  const isFuture       = !!cast.unlocksAt && cast.unlocksAt > now
  const modeCls        = isBurn ? 'burn' : isEyes ? 'eyes' : 'open'
  const modeLabel      = isBurn ? 'Burn' : isEyes ? 'Eyes Only' : 'Open'
  const lhPct          = Math.min(100, (cast.tideCount / 1_000_000) * 100)

  const handleHookClick = () => {
    if (isFuture) return // locked until unlocksAt
    if (isUnlocked) { setStep(s => s === 'expanded' ? 'unlocked' : 'expanded'); return }
    if (step === 'expanded') { setStep('idle'); return }
    setStep('expanded')
  }

  const handleOpenCTA = () => {
    if (!vessel) { setStep('vessel_select'); return }
    setStep('payway')
  }

  const handleVesselSelected = () => setStep('payway')

  const handlePaywayConfirm = async () => {
    setIsPaying(true)
    try {
      const payAmount = (cast as any).feePaid ?? cast.price ?? 1000
      // SEAL flow: call readCast() first (on-chain payment + state change),
      // then request the decryption key from zkProxy which verifies the tx.
      // Falls back to fetchCastBodyRaw() for pre-SEAL casts without a registered key.
      const { digest, readerAddress } = await readCast({ castId: cast.id, amountUsdc: payAmount })
      let rawBody: string
      try {
        rawBody = await decryptCastBody(cast.id, digest, readerAddress)
      } catch {
        // No key registered (pre-SEAL cast or free cast): fetch plaintext from chain
        rawBody = await fetchCastBodyRaw(cast.id)
      }
      setPendingBody(rawBody)
      if (vesselFuel >= 10) debitVessel(10); else debitHarbor(10)
      if (isEyes) { setStep('eyes_map'); return }
      if (hasSecurityQ) { setStep('security'); return }
      doReveal(rawBody)
    } catch (err: any) {
      console.error('[payway] readCast failed:', err)
      setStep('expanded')
    } finally {
      setIsPaying(false)
    }
  }

  const handleMapSubmit = () => {
    if (mapVal.trim().length < 3) { setMapError(true); return }
    if (hasSecurityQ) { setStep('security'); return }
    doReveal()
  }

  const handleSecurityAnswer = async (answer: string) => {
    const correct = cast.securityAnswer?.toLowerCase().trim()
    if (correct && answer.toLowerCase().trim() !== correct) {
      if (vesselFuel >= 10) debitVessel(10); else debitHarbor(10)
      setSecurityError(true); return
    }
    setSecurityError(false)
    doReveal()
  }

  const doReveal = (body?: string) => {
    // body param: raw content fetched immediately before readCast().
    // Falls back to pendingBody (set during async payment flow) or cast.body for local/seed casts.
    const revealBody = body ?? pendingBody ?? cast.body ?? ''
    markCastRead(cast.id, revealBody)
    useStore.getState().addChartEntry({ type:'cast', id:cast.id, name:cast.hook, visitedAt:now })
    setStep('unlocked')
    if (isBurn) startCountdown()
    // Auto-burn after interaction if enabled and not stored
    else if (autoBurn && vessel?.id && !isStoredByMe) {
      setTimeout(() => {
        // Re-check current store state — user may have stored in the 8s window
        const currentCast = useStore.getState().driftCasts.find(x => x.id === cast.id)
        const currentlyStored = (currentCast?.storedBy ?? []).includes(vessel.id)
        if (!currentlyStored) burnFromVessel(cast.id, vessel.id)
      }, 8000) // 8 second window to store before auto-burn
    }
  }

  const startCountdown = () => {
    setBurnCount(4)
    const iv = setInterval(() => {
      setBurnCount(n => {
        if (n === null || n <= 1) { clearInterval(iv); burnCast(cast.id); return null }
        return n - 1
      })
    }, 1000)
  }

  const doReturn = async () => {
    if (!returnHook.trim()) return
    const ok = await sound({ hook:returnHook.trim(), body:returnHook.trim(), mode:'open', duration:'24h' })
    if (ok) { setReturnDone(true); setShowReturn(false); setReturnHook('') }
  }

  const handleStore = () => {
    if (vessel?.id) {
      storeForVessel(cast.id, vessel.id)
      setStored(true)
    }
  }

  const handleViewerBurn = () => {
    if (vessel?.id) burnFromVessel(cast.id, vessel.id)
  }

  // Get tide decay indicator
  const durMs     = castDurationMs(cast.duration ?? '24h')
  const tideState = getTideState(cast.createdAt, durMs)
  const tideLabel = getTideLabel(tideState)

  // Time until future unlock
  const futureMs    = cast.unlocksAt ? cast.unlocksAt - now : 0
  const futureHours = Math.ceil(futureMs / 3600000)

  return (
    <>
      {step === 'vessel_select' && (
        <VesselSelectModal onSelect={handleVesselSelected} onLaunch={() => setStep('idle')} onCancel={() => setStep('expanded')}/>
      )}
      {step === 'payway' && vessel && (
        <PaywayModal vessel={vessel} hookTitle={cast.hook} mode={cast.mode} hasSecurityQ={hasSecurityQ} autofuel={autofuel} onConfirm={handlePaywayConfirm} onCancel={() => setStep('expanded')} isPending={isPaying}/>
      )}
      {step === 'security' && cast.securityQuestion && (
        <SecurityModal question={cast.securityQuestion} onSubmit={handleSecurityAnswer} onCancel={() => setStep('expanded')} error={securityError}/>
      )}
      {showWreck && (
        <WreckModal title="Wreck this cast?" description="Your cast will be removed from the tide permanently. Cannot be undone." confirmLabel="Confirm — wreck cast"
          onConfirm={() => { burnCast(cast.id); setShowWreck(false) }} onCancel={() => setShowWreck(false)}/>
      )}

      <div style={{borderBottom:'1px solid var(--border)'}} data-testid="cast-row" {...(isFuture ? {'data-future-signal': 'true'} : {})} {...(cast.securityQuestion ? {'data-security-gated': 'true'} : {})}>
        {/* also expose as future-signal for direct queries */}
        {isFuture && <span data-testid="future-signal" style={{display:'none'}}/>}
        {/* Hook row */}
        <div onClick={handleHookClick}
          style={{display:'flex',gap:'12px',padding:'14px 16px',cursor:isFuture?'default':'pointer',background:step!=='idle'?'var(--surface)':'transparent',transition:'background 0.15s',opacity:isFuture?0.6:1}}
          onMouseEnter={e => { if(step==='idle'&&!isFuture) (e.currentTarget as HTMLElement).style.background='rgba(0,184,230,0.018)' }}
          onMouseLeave={e => { if(step==='idle') (e.currentTarget as HTMLElement).style.background='transparent' }}>

          <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:'4px',flexShrink:0,paddingTop:'2px'}}>
            <div className={`cast-mode-dot ${isFuture?'open':modeCls}`} style={{fontSize:'11px'}}>
              {isFuture?'🔒':isBurn?'🔥':isEyes?'👁':'◎'}
            </div>
            {step!=='idle'&&<div style={{width:'1px',flex:1,minHeight:'12px',background:'linear-gradient(to bottom,var(--border2),transparent)'}}/>}
          </div>

          <div style={{flex:1,minWidth:0,display:'flex',flexDirection:'column',gap:'5px'}}>
            <div style={{display:'flex',alignItems:'center',gap:'5px',flexWrap:'wrap'}}>
              {isFuture ? (
                <span className="badge" style={{color:'var(--text-off)',borderColor:'var(--border)',background:'none'}}>Future Signal</span>
              ) : (
                <span data-testid="mode-badge" className={`badge badge-${modeCls}`}>{modeLabel}</span>
              )}
              {isEyes&&!isFuture&&<span className="badge badge-eyes">map required</span>}
              {isBurn&&!isFuture&&<span className="badge badge-burn">burns on read</span>}
              {hasSecurityQ&&!isFuture&&(
                <span data-testid="security-badge" style={{display:'inline-flex',alignItems:'center',gap:'3px',padding:'2px 7px',borderRadius:'100px',fontFamily:'var(--font-mono)',fontSize:'8px',fontWeight:600,letterSpacing:'0.06em',background:'rgba(94,79,232,0.1)',border:'1px solid rgba(94,79,232,0.2)',color:'var(--sealed)'}}>
                  🔐 gated
                </span>
              )}
              {isStoredByMe&&<span style={{fontFamily:'var(--font-mono)',fontSize:'8px',color:'var(--teal)',border:'1px solid var(--border3)',borderRadius:'100px',padding:'1px 6px'}}>stored</span>}
              <span className="badge badge-time">{formatTimeAgo(cast.createdAt)}</span>
              <DecayBadge expiresAt={cast.expiresAt}/>
              {tideLabel&&(
                <span style={{fontFamily:'var(--font-mono)',fontSize:'8px',color:tideState==='final'?'var(--burn)':'#FFB020',letterSpacing:'0.06em',opacity:0.8}}>
                  ⏳ {tideLabel}
                </span>
              )}
              <span className="cast-tide">{formatTide(cast.tideCount)}</span>
            </div>

            <div className="cast-hook" data-testid="cast-hook">{cast.hook}</div>

            {isFuture && (
              <div data-testid="future-countdown" style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)'}}>
                🔒 Unlocks in {futureHours}h
              </div>
            )}
            {!isFuture && step==='idle' && (
              <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',opacity:0.5}}>
                {isUnlocked ? 'tap to expand' : `tap to open · ${formatPrice(cast.price ?? 1000)}`}
                {autoBurn&&!isUnlocked&&vessel&&' · auto-burns after read'}
              </div>
            )}
            {returnDone&&<div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--teal)'}}>↩ return cast sounded</div>}
          </div>

          {!isFuture&&(
            <div style={{color:'var(--text-off)',alignSelf:'flex-start',paddingTop:'3px',flexShrink:0,transition:'transform 0.2s',transform:step!=='idle'?'rotate(90deg)':'rotate(0deg)'}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
          )}
        </div>

        {/* Expanded panel */}
        {step!=='idle' && !isFuture && (
          <div style={{padding:'0 16px 16px',background:'var(--surface)',animation:'revealBody 0.22s ease both'}} data-testid="cast-expanded">

            {step==='eyes_map'&&(
              <div style={{marginBottom:'10px',paddingTop:'4px'}}>
                <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:mapError?'var(--burn)':'var(--eyes)',marginBottom:'6px'}}>
                  {mapError?'Vessel not mapped to this Dock':'Enter your Dock map to unlock'}
                </div>
                {mapError&&<div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--burn)',padding:'6px 8px',background:'var(--burn-dim)',borderRadius:'var(--radius)',marginBottom:'8px',lineHeight:1.6}}>Your vessel is not mapped. Fuel debited. No refund.</div>}
                <input style={{width:'100%',background:'var(--surface2)',border:`1px solid ${mapError?'var(--burn-line)':'var(--border2)'}`,borderRadius:'var(--radius)',color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'12px',padding:'8px 10px',outline:'none',marginBottom:'8px'}}
                  placeholder="Dock ID or map address..." value={mapVal}
                  onChange={e=>{setMapVal(e.target.value);setMapError(false)}}
                  onKeyDown={e=>e.key==='Enter'&&mapVal.trim()&&handleMapSubmit()} autoFocus/>
                <div style={{display:'flex',gap:'6px'}}>
                  <button className="btn btn-primary btn-sm" onClick={handleMapSubmit} disabled={!mapVal.trim()}>Confirm map</button>
                  <button className="btn btn-ghost btn-sm" onClick={()=>{setStep('expanded');setMapVal('');setMapError(false)}}>cancel</button>
                </div>
              </div>
            )}

            {step==='expanded'&&!isUnlocked&&(
              <div style={{paddingTop:'6px'}}>
                {/* Decay warning */}
                {(tideState==='tide2'||tideState==='final')&&(
                  <div style={{padding:'6px 10px',background:'rgba(255,176,32,0.08)',border:'1px solid rgba(255,176,32,0.2)',borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'9px',color:'#FFB020',marginBottom:'8px',lineHeight:1.6}}>
                    {tideState==='final'
                      ? '⚠ Final tide. This signal will sink unless it earns a Lighthouse.'
                      : '⏳ Signal is fading. Interaction resets the tide.'
                    }
                  </div>
                )}
                <button onClick={handleOpenCTA} data-testid="cross-payway-btn"
                  style={{display:'flex',alignItems:'center',justifyContent:'center',gap:'8px',width:'100%',padding:'12px 16px',background:'var(--teal)',color:'var(--text-inv)',border:'none',borderRadius:'var(--radius-lg)',fontFamily:'var(--font-mono)',fontSize:'12px',fontWeight:600,cursor:'pointer',letterSpacing:'0.04em',transition:'all 0.15s',boxShadow:'0 0 12px rgba(0,184,230,0.2)'}}
                  onMouseEnter={e=>(e.currentTarget.style.boxShadow='var(--teal-glow)')}
                  onMouseLeave={e=>(e.currentTarget.style.boxShadow='0 0 12px rgba(0,184,230,0.2)')}>
                  {!vessel?'Select vessel to read →'
                    :isBurn?`Cross payway · ${formatPrice(cast.price ?? 1000)} · burns after`
                    :isEyes?`Cross payway · ${formatPrice(cast.price ?? 1000)} · map required`
                    :`Cross payway · ${formatPrice(cast.price ?? 1000)}`}
                </button>
                <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'5px',textAlign:'center',lineHeight:1.5}}>
                  Harbor access alone does not reveal signal content
                </div>
              </div>
            )}

            {isUnlocked&&(
              <>
                <div className="cast-body-revealed" data-testid="cast-body" style={{marginTop:'6px',marginBottom:'12px'}}>
                  {(cast.body??'').split('\n\n').map((p,i)=>(
                    <p key={i} style={{margin:i>0?'10px 0 0':'0'}}>{p}</p>
                  ))}
                </div>
                <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginBottom:'10px',lineHeight:1.6,fontStyle:'italic'}}>
                  This signal is temporary. Interaction resets the tide.
                </div>

                {burnCount!==null&&(
                  <div style={{display:'flex',alignItems:'center',gap:'8px',padding:'7px 10px',background:'var(--burn-dim)',border:'1px solid var(--burn-line)',borderRadius:'var(--radius)',marginBottom:'10px'}}>
                    <span style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--burn)'}}>🔥 burning in {burnCount}…</span>
                    <div style={{flex:1,height:'2px',background:'rgba(255,45,85,0.15)',borderRadius:'1px',overflow:'hidden'}}>
                      <div style={{height:'100%',background:'var(--burn)',width:`${(burnCount/4)*100}%`,transition:'width 1s linear'}}/>
                    </div>
                  </div>
                )}

                {/* Auto-burn notice */}
                {autoBurn&&!isStoredByMe&&!stored&&burnCount===null&&(
                  <div style={{padding:'6px 10px',background:'rgba(255,176,32,0.06)',border:'1px solid rgba(255,176,32,0.15)',borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'9px',color:'#FFB020',marginBottom:'10px',lineHeight:1.6}}>
                    Auto-burn active. Signal removed from your vessel in 8s unless stored.
                  </div>
                )}

                {burnCount===null&&!showReturn&&(
                  <div style={{display:'flex',gap:'8px',flexWrap:'wrap',marginBottom:'4px'}}>
                    {/* Return cast */}
                    <button onClick={()=>setShowReturn(true)}
                      style={{display:'flex',alignItems:'center',gap:'5px',padding:'6px 12px',background:'var(--teal-dim)',border:'1px solid var(--border3)',borderRadius:'var(--radius)',color:'var(--teal)',fontFamily:'var(--font-mono)',fontSize:'10px',cursor:'pointer',letterSpacing:'0.04em'}}>
                      ↩ return · ${formatPrice(cast.price ?? 1000)}
                    </button>

                    {/* Store */}
                    {!isStoredByMe&&!stored&&(
                      <button onClick={handleStore} data-testid="store-btn"
                        style={{display:'flex',alignItems:'center',gap:'5px',padding:'6px 12px',background:'rgba(0,184,230,0.08)',border:'1px solid var(--border3)',borderRadius:'var(--radius)',color:'var(--teal)',fontFamily:'var(--font-mono)',fontSize:'10px',cursor:'pointer',letterSpacing:'0.04em'}}>
                        ⊕ store to vessel
                      </button>
                    )}
                    {(isStoredByMe||stored)&&(
                      <span data-testid="stored-badge" style={{display:'flex',alignItems:'center',gap:'5px',padding:'6px 12px',fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--teal)',opacity:0.6}}>
                        ✓ stored
                      </span>
                    )}
                    {/* Viewer burn */}
                    {vessel?.id&&(
                      <button onClick={handleViewerBurn} data-testid="viewer-burn-btn"
                        style={{display:'flex',alignItems:'center',gap:'5px',padding:'6px 12px',background:'var(--burn-dim)',border:'1px solid var(--burn-line)',borderRadius:'var(--radius)',color:'var(--burn)',fontFamily:'var(--font-mono)',fontSize:'10px',cursor:'pointer',letterSpacing:'0.04em'}}>
                        🔥 burn
                      </button>
                    )}
                    {/* Owner wreck */}
                    {isOwn&&(
                      <button onClick={()=>setShowWreck(true)} data-testid="wreck-btn"
                        style={{display:'flex',alignItems:'center',gap:'5px',padding:'6px 12px',background:'var(--surface2)',border:'1px solid var(--border2)',borderRadius:'var(--radius)',color:'var(--text-dim)',fontFamily:'var(--font-mono)',fontSize:'10px',cursor:'pointer'}}>
                        wreck
                      </button>
                    )}
                  </div>
                )}

                {showReturn&&(
                  <div style={{marginTop:'4px',padding:'12px',background:'var(--surface2)',border:'1px solid var(--border2)',borderRadius:'var(--radius-lg)'}}>
                    <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)',marginBottom:'8px',letterSpacing:'0.04em'}}>
                      ↩ Sound a return cast into the tide
                    </div>
                    <textarea style={{width:'100%',background:'var(--surface)',border:'1px solid var(--border2)',borderRadius:'var(--radius)',color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'12px',padding:'8px 10px',outline:'none',resize:'none',marginBottom:'8px',lineHeight:1.5}}
                      rows={2} placeholder="Your hook..." value={returnHook}
                      onChange={e=>setReturnHook(e.target.value)} maxLength={160} autoFocus/>
                    <div style={{display:'flex',gap:'6px'}}>
                      <button onClick={doReturn} disabled={isSoundPending||!returnHook.trim()}
                        style={{flex:1,padding:'8px',background:'var(--teal)',color:'var(--text-inv)',border:'none',borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'11px',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:'6px'}}>
                        {isSoundPending?<><span className="spinner" style={{borderTopColor:'var(--text-inv)',borderColor:'rgba(0,0,0,0.2)'}}/>sounding…</>:`Sound · ${formatPrice(cast.price ?? 1000)}`}
                      </button>
                      <button onClick={()=>{setShowReturn(false);setReturnHook('')}}
                        style={{padding:'8px 12px',background:'none',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-dim)',fontFamily:'var(--font-mono)',fontSize:'11px',cursor:'pointer'}}>
                        cancel
                      </button>
                    </div>
                  </div>
                )}

                {isOpen&&cast.tideCount>=10000&&(
                  <div className="lh-bar-row" style={{marginTop:'12px'}}>
                    <div className="lh-bar-track"><div className="lh-bar-fill" style={{width:`${lhPct}%`}}/></div>
                    <span className="lh-bar-label">
                      {cast.tideCount>=1_000_000?'🔆 lighthouse':`${lhPct.toFixed(1)}% to lighthouse`}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
