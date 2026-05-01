/**
 * DockPanel — Author's Flare management + Reader's claimed Docks
 *
 * Two sections:
 *   SENT — Flares the author published (CastSounded events, mode=EYES_ONLY)
 *          Enhanced with localStorage metadata (recipient email, price)
 *   CLAIMED — Docks the reader entered (DockClaimed events)
 *
 * Data sources:
 *   - On-chain: suix_queryEvents for CastSounded + DockClaimed
 *   - Local: conk:sent_flares in localStorage for recipient emails
 *   - Per-cast: fetchCastById for live status checks
 */
import React, { useEffect, useState } from 'react'
import { IconDock } from '../components/Icons'
import { fetchSentFlares, fetchClaimedDocks, fetchCastById, fetchDockClaimsByCastId, payReturnFlareFee } from '../sui/client'
import { getAddress } from '../sui/zklogin'

interface SentFlare {
  castId: string
  hook: string
  body?: string
  createdAt: number
  expiresAt: number
  recipient?: string
  price?: number
  sentAt?: number
  // Live status from on-chain
  status?: 'live' | 'claimed' | 'expired' | 'burned'
  claimsUsed?: number
  maxClaims?: number
  revenue?: number
  claimedAt?: number
}

interface ClaimedDock {
  castId: string
  claimsUsed: number
  maxClaims: number
  claimedAt: number
  // Enriched from fetchCastById or localStorage
  hook?: string
  body?: string
  feePaid?: number
  author?: string
}

type DockTab = 'sent' | 'claimed'

export function DockPanel() {
  const [tab, setTab]             = useState<DockTab>('sent')
  const [sent, setSent]           = useState<SentFlare[]>([])
  const [claimed, setClaimed]     = useState<ClaimedDock[]>([])
  const [loading, setLoading]     = useState(true)
  const [expandedId, setExpandedId] = useState<string|null>(null)
  const [returningId, setReturningId] = useState<string|null>(null)
  const [returnStatus, setReturnStatus] = useState<Record<string, string>>({})

  useEffect(() => {
    loadDockData()
  }, [])

  async function loadDockData() {
    setLoading(true)

    // Always load localStorage received flares — even without zkLogin session
    const localReceived: Record<string, any> = {}
    try {
      const raw = JSON.parse(localStorage.getItem('conk:received_flares') || '[]')
      for (const r of raw) {
        if (r.castId) localReceived[r.castId] = r
      }
      // Immediately populate claimed tab from localStorage
      const localClaimed: ClaimedDock[] = Object.entries(localReceived).map(([castId, r]: [string, any]) => ({
        castId,
        claimsUsed: 1,
        maxClaims: 1,
        claimedAt: r.readAt ?? 0,
        hook: r.hook ?? '(no hook)',
        body: r.body ?? '',
        feePaid: r.feePaid ?? 0,
        author: r.author ?? '',
      }))
      localClaimed.sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0))
      setClaimed(localClaimed)
    } catch {}

    const addr = getAddress()
    if (!addr) { setLoading(false); return }

    // Load localStorage flare metadata
    const localFlares: Record<string, any> = {}
    try {
      const raw = JSON.parse(localStorage.getItem('conk:sent_flares') || '[]')
      for (const f of raw) {
        if (f.castId) localFlares[f.castId] = f
      }
    } catch {}

    // Fetch sent flares from on-chain events
    const sentEvents = await fetchSentFlares(addr)
    const enrichedSent: SentFlare[] = []

    for (const ev of sentEvents) {
      const local = localFlares[ev.castId]
      const now = Date.now()
      let status: SentFlare['status'] = 'live'
      let claimsUsed = 0
      let maxClaims = 1
      let revenue = 0
      let claimedAt = 0

      // Fetch live cast status
      const cast = await fetchCastById(ev.castId)
      if (cast) {
        claimsUsed = cast.claimsUsed
        maxClaims  = cast.maxClaims
        if (cast.burned) status = 'burned'
        else if (cast.isDockFull) { status = 'claimed'; revenue = Math.floor(cast.feePaid * 0.97) * claimsUsed }
        else if (!cast.isLighthouse && cast.expiresAt < now) status = 'expired'
      }

      if (claimsUsed > 0) {
        const claims = await fetchDockClaimsByCastId(ev.castId)
        claimedAt = claims
          .map(c => c.claimedAt)
          .filter(Boolean)
          .sort((a, b) => b - a)[0] ?? 0
      }

      enrichedSent.push({
        castId:     ev.castId,
        hook:       ev.hook,
        body:       local?.body ?? cast?.body ?? '',
        createdAt:  ev.createdAt,
        expiresAt:  ev.expiresAt,
        recipient:  local?.recipient,
        price:      local?.price ?? cast?.feePaid,
        sentAt:     local?.sentAt,
        status,
        claimsUsed,
        maxClaims,
        revenue,
        claimedAt,
      })
    }
    setSent(enrichedSent)

    // Enrich claimed tab with on-chain DockClaimed events
    const claimedEvents = await fetchClaimedDocks(addr)

    // Rebuild from localStorage (state may not have updated yet)
    const enrichedClaimed: ClaimedDock[] = Object.entries(localReceived).map(([castId, r]: [string, any]) => ({
      castId,
      claimsUsed: 1,
      maxClaims: 1,
      claimedAt: r.readAt ?? 0,
      hook: r.hook ?? '(no hook)',
      body: r.body ?? '',
      feePaid: r.feePaid ?? 0,
      author: r.author ?? '',
    }))
    const seen = new Set<string>(enrichedClaimed.map(c => c.castId))

    // Add on-chain events not already loaded from localStorage
    for (const ev of claimedEvents) {
      if (seen.has(ev.castId)) continue
      const cast = await fetchCastById(ev.castId)
      enrichedClaimed.push({
        ...ev,
        hook:    cast?.hook ?? '(burned)',
        body:    cast?.body ?? '',
        feePaid: cast?.feePaid ?? 0,
        author:  cast?.author ?? '',
      })
    }

    // Sort by most recent first
    enrichedClaimed.sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0))
    setClaimed(enrichedClaimed)
    setLoading(false)
  }

  const formatTime = (ms: number) => {
    if (!ms) return '—'
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  const statusColor: Record<string, string> = {
    live:    'var(--teal)',
    claimed: 'var(--eyes)',
    expired: 'var(--text-off)',
    burned:  'var(--burn)',
  }

  const statusLabel: Record<string, string> = {
    live:    'LIVE',
    claimed: 'CLAIMED',
    expired: 'EXPIRED',
    burned:  'BURNED',
  }

  const RETURN_FLARE_WINDOW_MS = 48 * 60 * 60 * 1000

  function returnFlareEligibility(f: SentFlare): { ok: boolean; label: string } {
    if (!f.recipient) return { ok: false, label: 'missing recipient email' }
    if ((f.claimsUsed ?? 0) <= 0 || !f.claimedAt) return { ok: false, label: 'not claimed yet' }
    const remaining = RETURN_FLARE_WINDOW_MS - (Date.now() - f.claimedAt)
    if (remaining <= 0) return { ok: false, label: '48h window closed' }
    const hours = Math.ceil(remaining / 3_600_000)
    return { ok: true, label: `${hours}h left` }
  }

  async function sendReturnFlare(f: SentFlare) {
    const eligibility = returnFlareEligibility(f)
    if (!eligibility.ok) {
      setReturnStatus(s => ({ ...s, [f.castId]: eligibility.label }))
      return
    }

    setReturningId(f.castId)
    setReturnStatus(s => ({ ...s, [f.castId]: 'sending…' }))
    try {
      setReturnStatus(s => ({ ...s, [f.castId]: 'paying $0.05 fee…' }))
      const txDigest = await payReturnFlareFee()
      setReturnStatus(s => ({ ...s, [f.castId]: 'sending…' }))

      const res = await fetch('https://conk-zkproxy-v2.italktonumbers.workers.dev/return-flare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:        f.recipient,
          hook:      f.hook,
          castId:    f.castId,
          amount:    (f.price ?? 0) / 1_000_000,
          claimedAt: f.claimedAt,
          txDigest,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.error ?? `Return Flare failed (${res.status})`)
      }
      setReturnStatus(s => ({ ...s, [f.castId]: 'Return Flare sent' }))
    } catch (err: any) {
      setReturnStatus(s => ({ ...s, [f.castId]: err?.message ?? 'Return Flare failed' }))
    } finally {
      setReturningId(null)
    }
  }

  return (
    <div data-testid="dock-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Tab switcher */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--border2)',
        fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.08em',
      }}>
        {(['sent', 'claimed'] as DockTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '10px 0', background: 'transparent', border: 'none',
            color: tab === t ? 'var(--teal)' : 'var(--text-off)',
            borderBottom: tab === t ? '2px solid var(--teal)' : '2px solid transparent',
            cursor: 'pointer', textTransform: 'uppercase',
          }}>
            {t === 'sent' ? `Sent (${sent.length})` : `Claimed (${claimed.length})`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>

        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-off)' }}>
            Loading Dock data from Sui...
          </div>
        )}

        {/* ── SENT TAB ── */}
        {!loading && tab === 'sent' && (
          <>
            {sent.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <IconDock size={24} color="var(--text-off)" />
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-off)', marginTop: '12px' }}>
                  No Flares sent yet
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)', marginTop: '4px' }}>
                  Go to Cast → Flare to send your first
                </div>
              </div>
            )}
            {sent.map(f => {
              const eligibility = returnFlareEligibility(f)
              return (
              <div key={f.castId} onClick={() => setExpandedId(expandedId === f.castId ? null : f.castId)} style={{
                padding: '12px', marginBottom: '8px',
                background: 'var(--surface)', border: expandedId === f.castId ? '1px solid var(--teal)' : '1px solid var(--border2)',
                borderRadius: 'var(--radius-lg)', cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: '8px', letterSpacing: '0.1em',
                    color: statusColor[f.status ?? 'live'],
                    border: `1px solid ${statusColor[f.status ?? 'live']}`,
                    borderRadius: '100px', padding: '1px 6px',
                  }}>
                    {statusLabel[f.status ?? 'live']}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)' }}>
                    {formatTime(f.sentAt ?? f.createdAt)}
                  </span>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--text)', marginBottom: '6px', wordBreak: 'break-word' }}>
                  {f.hook}
                </div>
                <div style={{ display: 'flex', gap: '16px', fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)', flexWrap: 'wrap' }}>
                  {f.recipient && <span>To: {f.recipient}</span>}
                  <span>Price: ${((f.price ?? 0) / 1_000_000).toFixed(2)}</span>
                  <span>Dock: {f.claimsUsed ?? 0}/{f.maxClaims ?? 1}</span>
                  {f.claimedAt ? <span>Claimed: {formatTime(f.claimedAt)}</span> : null}
                  {(f.revenue ?? 0) > 0 && <span style={{ color: 'var(--teal)' }}>Earned: ${((f.revenue ?? 0) / 1_000_000).toFixed(2)}</span>}
                </div>
                {expandedId === f.castId && (
                  <div onClick={e => e.stopPropagation()} style={{ marginTop: '10px' }}>
                    {f.body && (
                      <div style={{ padding: '12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', fontSize: '13px', color: 'var(--text-dim)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '10px' }}>
                        {f.body}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => sendReturnFlare(f)}
                        disabled={!eligibility.ok || returningId === f.castId}
                        style={{
                          padding: '7px 11px', borderRadius: 'var(--radius)',
                          border: `1px solid ${eligibility.ok ? 'var(--teal)' : 'var(--border)'}`,
                          background: eligibility.ok ? 'rgba(0,184,230,0.08)' : 'var(--surface2)',
                          color: eligibility.ok ? 'var(--teal)' : 'var(--text-off)',
                          fontFamily: 'var(--font-mono)', fontSize: '10px', cursor: eligibility.ok ? 'pointer' : 'not-allowed',
                          letterSpacing: '0.04em',
                        }}>
                        {returningId === f.castId ? 'Sending…' : 'Return Flare'}
                      </button>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: eligibility.ok ? 'var(--teal)' : 'var(--text-off)' }}>
                        {returnStatus[f.castId] ?? eligibility.label}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )})}
          </>
        )}

        {/* ── CLAIMED TAB ── */}
        {!loading && tab === 'claimed' && (
          <>
            {claimed.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <IconDock size={24} color="var(--text-off)" />
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-off)', marginTop: '12px' }}>
                  No Docks claimed yet
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)', marginTop: '4px' }}>
                  Claim Docks by opening Flare links from your email
                </div>
              </div>
            )}
            {claimed.map(d => (
              <div key={d.castId} onClick={() => setExpandedId(expandedId === d.castId ? null : d.castId)} style={{
                padding: '12px', marginBottom: '8px',
                background: 'var(--surface)', border: expandedId === d.castId ? '1px solid var(--eyes)' : '1px solid var(--border2)',
                borderRadius: 'var(--radius-lg)', cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: '8px', letterSpacing: '0.1em',
                    color: 'var(--eyes)',
                    border: '1px solid var(--eyes)',
                    borderRadius: '100px', padding: '1px 6px',
                  }}>
                    ENTERED
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)' }}>
                    {formatTime(d.claimedAt)}
                  </span>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--text)', marginBottom: '6px', wordBreak: 'break-word' }}>
                  {d.hook}
                </div>
                <div style={{ display: 'flex', gap: '16px', fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)' }}>
                  <span>Paid: ${((d.feePaid ?? 0) / 1_000_000).toFixed(2)}</span>
                  <span>Dock: {d.claimsUsed}/{d.maxClaims}</span>
                </div>
                {expandedId === d.castId && d.body && (
                  <div style={{ marginTop: '10px', padding: '12px', background: 'var(--surface2)', borderRadius: 'var(--radius)', fontSize: '13px', color: 'var(--text-dim)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {d.body}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

      </div>
    </div>
  )
}
