import React, { useState } from 'react'
import { useSoundCast } from '../hooks/use402'
import { useStore, type CastMode } from '../store/store'
import { IconCast, IconOpen, IconEye, IconFlame, IconDock } from '../components/Icons'
import { FuelBar } from '../components/FuelMeter'
import { MediaUpload } from '../components/MediaUpload'
import type { WalrusUploadResult } from '../sui/walrus'
import { encryptForCast, buildSealMetadata } from '../sui/seal'
import { getAddress } from '../sui/zklogin'

const MODES: { id: CastMode; icon: React.ReactNode; label: string; desc: string; note?: string }[] = [
  { id:'open',      icon:<IconOpen size={13}  color="var(--teal)"/>,   label:'Open',  desc:'Public · anyone can read' },
  { id:'eyes_only', icon:<IconEye size={13}   color="var(--eyes)"/>,   label:'Flare', desc:'Private · delivered via email', note:'Only the email recipient can read this cast.' },
  { id:'burn',      icon:<IconFlame size={13} color="var(--burn)"/>,   label:'Burn',  desc:'Anyone reads once · gone forever', note:'Permanently deleted after first read.' },
]

function FuelStrip({ fuel }: { fuel: number }) {
  const low = fuel < 10
  return (
    <div style={{display:'flex',alignItems:'center',gap:'10px',padding:'7px 10px',background:low?'var(--burn-dim)':'var(--surface)',border:`1px solid ${low?'rgba(255,58,92,0.2)':'var(--border)'}`,borderRadius:'var(--radius)',marginBottom:'12px'}}>
      <FuelBar value={fuel} max={100} width={80}/>
      <span style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:low?'var(--burn)':'var(--text-off)',marginLeft:'auto'}}>
        {low ? 'low fuel — draw from Harbor' : 'vessel fuel · $0.001 to sound · $0.05 for Flares'}
      </span>
    </div>
  )
}

export function CastPanel({ onClose }: { onClose: () => void }) {
  const vessel = useStore((s) => s.vessel)
  const harbor = useStore((s) => s.harbor)
  const { sound, status } = useSoundCast()

  const [hook,  setHook]  = useState('')
  const [body,  setBody]  = useState('')
  const [mode,  setMode]  = useState<CastMode>('open')
  const [dur,      setDur]      = useState<'24h'|'48h'|'7d'>('24h')
  const [step,     setStep]     = useState<'compose'|'confirm'>('compose')
  const [error,    setError]    = useState('')
  const [useSecQ,  setUseSecQ]  = useState(false)
  const [secQ,     setSecQ]     = useState('')
  const [secA,     setSecA]     = useState('')
  const [keywords, setKeywords] = useState('')
  const [useFuture,setUseFuture]= useState(false)
  const [futureHrs,setFutureHrs]= useState(6)
  const [media, setMedia] = useState<WalrusUploadResult | null>(null)
  const [pendingFile, setPendingFile]       = useState<File | null>(null)
  const [storageFee,  setStorageFee]        = useState(0)
  const [showFeeConfirm, setShowFeeConfirm] = useState(false)
  const [uploading, setUploading]           = useState(false)
  const [uploadError, setUploadError]       = useState('')
  const setHarborStore = useStore((s) => s.setHarbor)
  const [price, setPrice] = useState<number>(100000) // default $0.10 (v6 minimum paid read)
  const [castType, setCastType] = useState<'standard'|'subscription'|'timelocked'>('standard')
  const [subInterval, setSubInterval] = useState<'daily'|'weekly'|'monthly'>('weekly')
  const [lockHrs, setLockHrs] = useState<number>(24)
  const [useCascade, setUseCascade] = useState(false)
  const [cascadeThreshold, setCascadeThreshold] = useState(100)
  const [cascadeHook, setCascadeHook] = useState('')
  const [cascadeBody, setCascadeBody] = useState('')
  const [flare,        setFlare]        = useState('')
  const [isReply,      setIsReply]      = useState(false)

  // Pick up reply context from FlareReader
  React.useEffect(() => {
    const raw = sessionStorage.getItem('conk:reply_context')
    if (raw) {
      try {
        const ctx = JSON.parse(raw)
        setMode('eyes_only')
        setHook('Re: ' + (ctx.replyTo ?? ''))
        setPrice(0)  // Replies default to free read — author can override to $0.10+
        setIsReply(true)
        sessionStorage.removeItem('conk:reply_context')
      } catch {}
    }
  }, [])

  const isSending = status === 'pending'
  const isDone    = status === 'success'
  const modeInfo  = MODES.find(m => m.id === mode)!
  const fuel      = vessel?.fuel ?? 0
  const lowFuel   = fuel < 10

  const calcStorageFee = (bytes: number): number => {
    const mb = bytes / (1024 * 1024)
    if (mb <= 1)   return 1
    if (mb <= 5)   return 5
    if (mb <= 25)  return 20
    if (mb <= 100) return 75
    return 200
  }
  const formatFee = (cents: number) => `$${(cents / 100).toFixed(2)}`

  const handleFileSelect = (file: File) => {
    setPendingFile(file); setStorageFee(calcStorageFee(file.size))
    setShowFeeConfirm(true); setUploadError('')
  }

  const handleConfirmUpload = async () => {
    if (!pendingFile || !harbor) return
    if (harbor.balance < storageFee) {
      setUploadError(`Need ${formatFee(storageFee)}, have $${(harbor.balance/100).toFixed(2)}.`); return
    }
    setUploading(true); setUploadError('')
    const prev = harbor.balance
    setHarborStore({ ...harbor, balance: harbor.balance - storageFee })
    try {
      const { uploadToWalrus } = await import('../sui/walrus')
      const result = await uploadToWalrus(pendingFile)
      setMedia(result); setShowFeeConfirm(false); setPendingFile(null)
    } catch(e: any) {
      setHarborStore({ ...harbor, balance: prev })
      setUploadError(e.message || 'Upload failed — Harbor not charged')
    } finally { setUploading(false) }
  }

  const handleCancelUpload = () => { setShowFeeConfirm(false); setPendingFile(null); setUploadError('') }

  const handleSend = async () => {
    // SEAL encrypt if mode is sealed and media exists
    let sealBody = body.trim() || hook.trim()
    let sealAttachment = media?.blobId
    if (mode === 'sealed' && media) {
      try {
        const senderAddr = getAddress() ?? ''
        const result = await encryptForCast(media.data ?? new Uint8Array(), {
          castId:        `pending_${Date.now()}`,
          authorAddress: senderAddr,
        })
        sealAttachment = result.encryptedBlobId
        sealBody = sealBody + '\n\n' + JSON.stringify(buildSealMetadata(result))
      } catch(e: any) {
        setError('SEAL encryption failed: ' + e.message)
        return
      }
    }
    setError('')
    const ok = await sound({
      hook: hook.trim(),
      body: sealBody,
      price,
      mode, duration: dur,
      securityQuestion: useSecQ && secQ.trim() ? secQ.trim() : undefined,
      securityAnswer:   useSecQ && secA.trim() ? secA.trim() : undefined,
      keywords: keywords.trim() ? keywords.split(',').map(k => k.trim()).filter(Boolean) : undefined,
      unlocksAt: castType === 'timelocked' ? Date.now() + lockHrs * 3600000 : useFuture ? Date.now() + futureHrs * 3600000 : undefined,
      castType,
      subInterval: castType === 'subscription' ? subInterval : undefined,
      cascade: useCascade && cascadeHook.trim() ? {
        threshold: cascadeThreshold,
        hook: cascadeHook.trim(),
        body: cascadeBody.trim() || cascadeHook.trim(),
      } : undefined,
      flare: mode === 'eyes_only' && flare.trim() ? flare.trim() : undefined,
    })
    if (ok) { setHook(''); setBody(''); setStep('compose'); setTimeout(onClose, 300) }
    else setError('Failed. Check your Harbor balance.')
  }

  // Confirm screen
  if (step === 'confirm') return (
    <>
      <FuelStrip fuel={fuel}/>
      <div style={{padding:'10px 11px',background:'var(--surface)',border:'1px solid var(--border2)',borderRadius:'var(--radius-lg)',marginBottom:'14px'}}>
        <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-off)',marginBottom:'4px',textTransform:'uppercase',letterSpacing:'0.08em'}}>Hook</div>
        <div style={{fontFamily:'var(--font-mono)',fontSize:'12px',color:'var(--text)',lineHeight:1.5}}>{hook}</div>
      </div>
      <div className="summary" style={{marginBottom:'14px'}}>
        <div className="summary-row"><span>Mode</span>
          <span style={{display:'flex',alignItems:'center',gap:'5px',fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--text)'}}>
            {modeInfo.icon} {modeInfo.label}
          </span>
        </div>
        <div className="summary-row"><span>Duration</span><span className="summary-val">{dur}</span></div>
        <div className="summary-row"><span>Security gate</span><span className="summary-val">{useSecQ && secQ ? 'enabled' : 'none'}</span></div>
        <div className="summary-row" style={{borderBottom:mode==='eyes_only'&&flare?undefined:'none'}}><span>Read price</span><span className="summary-val">${(price/1000000).toFixed(2)}</span></div>
        {mode === 'eyes_only' && flare && (
          <div className="summary-row" style={{borderBottom:'none'}}>
            <span>Flare to</span>
            <span className="summary-val" style={{color:'var(--teal)'}}>{flare} <span style={{color:'var(--text-off)',fontSize:'9px'}}>· $0.05 fee</span></span>
          </div>
        )}
      </div>

      {/* Void notice */}
      <div style={{padding:'8px 10px',background:'rgba(255,45,85,0.04)',border:'1px solid rgba(255,45,85,0.08)',borderRadius:'var(--radius)',marginBottom:'12px',fontFamily:'var(--font-mono)',fontSize:'9px',color:'rgba(255,45,85,0.5)',letterSpacing:'0.04em',lineHeight:1.7}}>
        Signal requires payment. No refunds. Fees sink to the void.
      </div>

      {error && <div style={{padding:'8px 10px',background:'var(--burn-dim)',border:'1px solid var(--burn-line)',borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--burn)',marginBottom:'10px'}}>{error}</div>}

      <button data-testid="cast-sound-btn" className="btn btn-primary btn-full" onClick={handleSend} disabled={isSending||isDone||lowFuel}>
        {isSending ? <><span className="spinner"/>Sounding…</> : isDone ? <span data-testid="cast-success">✓ cast sounded</span> : <><IconCast size={12} color="var(--text-inv)"/> Sound it · ${(price/1000000).toFixed(2)}</>}
      </button>
      <button className="btn btn-ghost btn-full" style={{marginTop:'6px'}} onClick={() => setStep('compose')}>← edit</button>
    </>
  )

  // Compose screen
  return (
    <>
      <FuelStrip fuel={fuel}/>

      {vessel && (
        <div style={{display:'flex',alignItems:'center',gap:'6px',padding:'5px 9px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius)',marginBottom:'12px'}}>
          <span style={{fontFamily:'var(--font-mono)',fontSize:'13px'}}>{vessel.class === 'daemon' ? '⚙' : '◌'}</span>
          <span style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)'}}>
            casting as <span style={{color:'var(--teal)'}}>vessel</span>
          </span>
        </div>
      )}

      <div className="field" style={{marginBottom:'11px'}}>
        {/* Cast Type */}
        <label className="field-label">Cast Type</label>
        <div style={{display:'flex',gap:'6px',marginBottom:'12px',flexWrap:'wrap'}}>
          {[
            {id:'standard',    label:'⚡ Standard',     desc:'One-time read'},
            {id:'subscription',label:'♻ Subscription',  desc:'Recurring readers'},
            {id:'timelocked',  label:'⏳ Time-Locked',   desc:'Unlocks at set time'},
          ].map(t => (
            <button key={t.id} onClick={() => setCastType(t.id as any)}
              style={{flex:1,padding:'8px',background:castType===t.id?'rgba(0,184,230,0.1)':'var(--surface)',border:`1px solid ${castType===t.id?'var(--teal)':'var(--border)'}`,borderRadius:'var(--radius)',cursor:'pointer',textAlign:'left'}}>
              <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',fontWeight:600,color:castType===t.id?'var(--teal)':'var(--text)',marginBottom:'2px'}}>{t.label}</div>
              <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)'}}>{t.desc}</div>
            </button>
          ))}
        </div>

        {/* Subscription interval */}
        {castType === 'subscription' && (
          <div style={{marginBottom:'12px',padding:'10px 12px',background:'rgba(0,184,230,0.04)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginBottom:'8px',letterSpacing:'0.08em',textTransform:'uppercase'}}>Subscription Interval</div>
            <div style={{display:'flex',gap:'6px'}}>
              {(['daily','weekly','monthly'] as const).map(i => (
                <button key={i} onClick={() => setSubInterval(i)}
                  style={{flex:1,padding:'6px',background:subInterval===i?'rgba(0,184,230,0.1)':'var(--surface2)',border:`1px solid ${subInterval===i?'var(--teal)':'var(--border)'}`,borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'10px',color:subInterval===i?'var(--teal)':'var(--text-dim)',cursor:'pointer',fontWeight:subInterval===i?600:400}}>
                  {i}
                </button>
              ))}
            </div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'6px'}}>
              Readers pay {['daily','weekly','monthly'].includes(subInterval)?'per '+subInterval+' publication':''} · 97% to you
            </div>
          </div>
        )}

        {/* Time-lock settings */}
        {castType === 'timelocked' && (
          <div style={{marginBottom:'12px',padding:'10px 12px',background:'rgba(0,184,230,0.04)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginBottom:'8px',letterSpacing:'0.08em',textTransform:'uppercase'}}>Unlock After</div>
            <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
              {[1,6,12,24,48,72].map(h => (
                <button key={h} onClick={() => setLockHrs(h)}
                  style={{padding:'6px 10px',background:lockHrs===h?'rgba(0,184,230,0.1)':'var(--surface2)',border:`1px solid ${lockHrs===h?'var(--teal)':'var(--border)'}`,borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'10px',color:lockHrs===h?'var(--teal)':'var(--text-dim)',cursor:'pointer',fontWeight:lockHrs===h?600:400}}>
                  {h}h
                </button>
              ))}
            </div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'6px'}}>
              Body encrypts until unlock · all paying vessels receive simultaneously
            </div>
          </div>
        )}

        <label className="field-label">Hook <span className="field-cost">free · always visible</span></label>
        <textarea className="input" rows={2} data-testid="cast-hook-input" placeholder="The line they see first..." value={hook} onChange={e=>setHook(e.target.value)} maxLength={160} autoFocus/>
        <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',textAlign:'right'}}>{hook.length}/160</div>
      </div>

      <div className="field" style={{marginBottom:'11px'}}>
        <label className="field-label">Body <span className="field-cost">$0.10 min · 97% to you</span></label>
        <textarea className="input" rows={4} placeholder="What the tide carries..." value={body} onChange={e=>setBody(e.target.value)}/>
        <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',textAlign:'right'}}>{body.length > 0 ? `${body.length} chars` : 'unlimited'}</div>
      </div>

      {/* Price selector */}
      <div className="field" style={{marginBottom:'11px'}}>
        <label className="field-label">Read Price <span className="field-cost">readers pay this to unlock</span></label>
        <div style={{display:'flex',gap:'6px',flexWrap:'wrap',marginBottom:'6px'}}>
          {[
            {label:'$0.01',  value:0},  // protocol fee only — author earns nothing
            {label:'$0.10',  value:100000},
            {label:'$0.50',  value:500000},
            {label:'$1.00',  value:1000000},
            {label:'$5.00',  value:5000000},
          ].map(p => (
            <button key={p.value} onClick={() => setPrice(p.value)}
              className={`chip ${price===p.value?'active':''}`}
              style={{fontSize:'11px',padding:'4px 10px'}}>
              {p.label}
            </button>
          ))}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
          <span style={{fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--text-dim)'}}>$</span>
          <input
            type="number"
            min="0"
            max="1000"
            step="0.01"
            value={(price/1000000).toFixed(price<100000?2:price<1000000?2:0)}
            onChange={e => {
              const dollars = parseFloat(e.target.value)
              if (!isNaN(dollars) && dollars >= 0 && dollars <= 1000) {
                setPrice(Math.round(dollars * 1000000))
              }
            }}
            className="input"
            style={{width:'110px',fontFamily:'var(--font-mono)',fontSize:'12px',padding:'4px 8px'}}
          />
          <span style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)'}}>
            Free or 0.10 – 1,000.00
          </span>
        </div>
        {price > 100000000 && (
          <div style={{marginTop:'5px',fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--warning,#FFB020)',letterSpacing:'0.04em'}}>
            ⚠ High price — readers will see a warning before paying
          </div>
        )}
        <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'4px'}}>
          You earn 97% · Protocol fee 3%
        </div>
      </div>

      {/* Media attachment */}
      <div className="field" style={{marginBottom:'11px'}}>
        <label className="field-label">Attachment <span className="field-cost">optional · stored on Walrus</span></label>
        <MediaUpload
          onUpload={setMedia}
          onRemove={() => setMedia(null)}
          uploaded={media}
          label="Attach image or file"
        />
      </div>

      <div className="field" style={{marginBottom:'11px'}}>
        <label className="field-label">Mode</label>
        <div className="mode-cards">
          {MODES.map(m => (
            <button key={m.id} className={`mode-card ${mode===m.id?'active':''}`} onClick={() => setMode(m.id)}>
              <span className="mode-card-icon">{m.icon}</span>
              <div><div className="mode-card-name">{m.label}</div><div className="mode-card-desc">{m.desc}</div></div>
            </button>
          ))}
        </div>
        {modeInfo.note && (
          <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:mode==='burn'?'var(--burn)':'var(--eyes)',marginTop:'6px',lineHeight:1.6,padding:'6px 9px',background:mode==='burn'?'var(--burn-dim)':'var(--eyes-dim)',border:`1px solid ${mode==='burn'?'rgba(255,45,85,0.15)':'rgba(255,176,32,0.15)'}`,borderRadius:'var(--radius)'}}>
            {modeInfo.note}
          </div>
        )}
      </div>

      <div className="field" style={{marginBottom:'12px'}}>
        <label className="field-label">Duration</label>
        <div style={{display:'flex',gap:'5px'}}>
          {(['24h','48h','7d'] as const).map(d => (
            <button key={d} className={`chip ${dur===d?'active':''}`} onClick={() => setDur(d)}>{d}</button>
          ))}
        </div>
      </div>

      {/* Security question — opt in */}
      <div style={{marginBottom:'14px',padding:'12px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom: useSecQ ? '12px' : '0'}}>
          <div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)'}}>Security gate <span style={{color:'var(--sealed)',fontSize:'9px'}}>optional</span></div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'1px'}}>Reader must answer before access. Wrong answers are not refunded.</div>
          </div>
          <button onClick={() => setUseSecQ(!useSecQ)}
            style={{width:'36px',height:'20px',borderRadius:'100px',background:useSecQ?'var(--sealed)':'var(--surface3)',border:`1px solid ${useSecQ?'var(--sealed)':'var(--border)'}`,position:'relative',cursor:'pointer',transition:'all 0.2s',flexShrink:0,padding:0}}>
            <div style={{width:'14px',height:'14px',background:useSecQ?'var(--bg)':'var(--text-dim)',borderRadius:'50%',position:'absolute',top:'2px',left:useSecQ?'19px':'2px',transition:'all 0.2s'}}/>
          </button>
        </div>
        {useSecQ && (
          <>
            <div className="field" style={{marginBottom:'8px'}}>
              <label className="field-label">Question</label>
              <input className="input" placeholder="What must the reader know?" value={secQ} onChange={e=>setSecQ(e.target.value)} style={{height:'36px'}}/>
            </div>
            <div className="field">
              <label className="field-label">Answer <span style={{color:'var(--text-off)',fontWeight:400,fontSize:'9px',letterSpacing:0,textTransform:'none'}}>case-insensitive</span></label>
              <input className="input" placeholder="The correct answer..." value={secA} onChange={e=>setSecA(e.target.value)} style={{height:'36px'}}/>
            </div>
          </>
        )}
      </div>

      {/* Keywords — searchable metadata, not shown to readers */}
      <div style={{marginBottom:'14px',padding:'12px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
        <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)',marginBottom:'4px'}}>
          Keywords <span style={{color:'var(--text-off)',fontSize:'9px'}}>optional · searchable · not shown to readers</span>
        </div>
        <input className="input" style={{height:'34px'}}
          placeholder="privacy, agents, protocol (comma separated)"
          value={keywords} onChange={e=>setKeywords(e.target.value)}/>
      </div>

      {/* Future release */}
      <div style={{marginBottom:'14px',padding:'12px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:useFuture?'12px':'0'}}>
          <div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)'}}>Future Release <span style={{color:'var(--text-off)',fontSize:'9px'}}>optional</span></div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'1px'}}>Lock signal until a future time. Shows countdown to readers.</div>
          </div>
          <button onClick={()=>setUseFuture(!useFuture)}
            style={{width:'36px',height:'20px',borderRadius:'100px',background:useFuture?'var(--teal)':'var(--surface3)',border:`1px solid ${useFuture?'var(--teal)':'var(--border)'}`,position:'relative',cursor:'pointer',transition:'all 0.2s',flexShrink:0,padding:0}}>
            <div style={{width:'14px',height:'14px',background:useFuture?'var(--bg)':'var(--text-dim)',borderRadius:'50%',position:'absolute',top:'2px',left:useFuture?'19px':'2px',transition:'all 0.2s'}}/>
          </button>
        </div>
        {useFuture&&(
          <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)'}}>Unlock in</div>
            <div style={{display:'flex',gap:'5px'}}>
              {[1,6,12,24,48].map(h=>(
                <button key={h} className={`chip ${futureHrs===h?'active':''}`} style={{fontSize:'10px'}} onClick={()=>setFutureHrs(h)}>
                  {h}h
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {lowFuel && <div style={{padding:'8px 10px',background:'var(--burn-dim)',border:'1px solid var(--burn-line)',borderRadius:'var(--radius)',fontFamily:'var(--font-mono)',fontSize:'11px',color:'var(--burn)',marginBottom:'10px'}}>Vessel fuel empty. Draw fuel from Harbor first.</div>}

      {/* Auto-response / Cascade */}
      <div style={{marginBottom:'14px',padding:'12px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:useCascade?'12px':'0'}}>
          <div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)'}}>
              Auto-response <span style={{color:'var(--teal)',fontSize:'9px'}}>optional · commerce</span>
            </div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'1px'}}>
              Send a message to every reader after they pay. Use for receipts, delivery info, or contact details.
            </div>
          </div>
          <button onClick={() => setUseCascade(!useCascade)}
            style={{width:'36px',height:'20px',borderRadius:'100px',background:useCascade?'var(--teal)':'var(--surface3)',border:`1px solid ${useCascade?'var(--teal)':'var(--border)'}`,position:'relative',cursor:'pointer',transition:'all 0.2s',flexShrink:0,padding:0}}>
            <div style={{width:'14px',height:'14px',background:useCascade?'var(--bg)':'var(--text-dim)',borderRadius:'50%',position:'absolute',top:'2px',left:useCascade?'19px':'2px',transition:'all 0.2s'}}/>
          </button>
        </div>
        {useCascade && (
          <>
            <div className="field" style={{marginBottom:'8px'}}>
              <label className="field-label">
                Message to reader <span style={{color:'var(--text-off)',fontWeight:400,fontSize:'9px',textTransform:'none',letterSpacing:0}}>sent after every read</span>
              </label>
              <textarea className="input" rows={3}
                placeholder={"Thank you for your purchase.\nFor delivery or support, contact: agent@seller.com\nYour order will be fulfilled within 24 hours."}
                value={cascadeBody} onChange={e => setCascadeBody(e.target.value)}/>
            </div>
            <div className="field" style={{marginBottom:'8px'}}>
              <label className="field-label">
                Subject / Hook <span style={{color:'var(--text-off)',fontWeight:400,fontSize:'9px',textTransform:'none',letterSpacing:0}}>reader sees this first</span>
              </label>
              <input className="input" style={{height:'34px'}}
                placeholder="Order confirmed ✓"
                value={cascadeHook} onChange={e => setCascadeHook(e.target.value)}/>
            </div>
            <div className="field">
              <label className="field-label">
                Trigger <span style={{color:'var(--text-off)',fontWeight:400,fontSize:'9px',textTransform:'none',letterSpacing:0}}>when to send</span>
              </label>
              <div style={{display:'flex',gap:'5px',flexWrap:'wrap'}}>
                {[
                  {label:'Every read', value:1},
                  {label:'At 10 reads', value:10},
                  {label:'At 100 reads', value:100},
                  {label:'At 1,000 reads', value:1000},
                ].map(t => (
                  <button key={t.value} onClick={() => setCascadeThreshold(t.value)}
                    className={`chip ${cascadeThreshold===t.value?'active':''}`}
                    style={{fontSize:'10px'}}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'6px',lineHeight:1.6}}>
                {cascadeThreshold === 1
                  ? '→ Every reader receives your message after paying. Best for commerce and receipts.'
                  : `→ Fires once when your cast reaches ${cascadeThreshold.toLocaleString()} reads. Best for milestones and announcements.`}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Flare email field — auto-shown when mode === eyes_only */}
      {mode === 'eyes_only' && (
        <div style={{marginBottom:'14px',padding:'12px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)'}}>
          <div style={{marginBottom:'12px'}}>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'10px',color:'var(--text-dim)'}}>
              Recipient email <span style={{color:'var(--teal)',fontSize:'9px'}}>{isReply ? 'optional · notify by email' : 'required · $0.05 to send'}</span>
            </div>
            <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',marginTop:'1px'}}>
              We'll send them a CONK Flare invitation. Only they can read this cast.
            </div>
          </div>
          <input
            className="input"
            type="email"
            style={{height:'36px',marginBottom:'6px'}}
            placeholder="recipient@example.com"
            value={flare}
            onChange={e => setFlare(e.target.value)}
          />
          <div style={{fontFamily:'var(--font-mono)',fontSize:'9px',color:'var(--text-off)',lineHeight:1.6}}>
            $0.05 charged at publish · reader pays $0.10+ to unlock · 97% of read price to you
          </div>
        </div>
      )}

      <button data-testid="cast-review-btn" className="btn btn-primary btn-full" onClick={() => { if (!hook.trim()) return; setStep('confirm') }} disabled={!hook.trim()||lowFuel||(useSecQ&&(!secQ.trim()||!secA.trim()))||(mode==='eyes_only'&&!isReply&&!flare.trim())}>
        Review →
      </button>
    </>
  )
}
