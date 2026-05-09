/**
 * HarborFundQR
 *
 * Shown when a human user has a zkLogin-derived Sui address
 * but the Harbor has not yet been funded with USDC.
 *
 * Agents use POST /bridge/provision and never see this screen.
 * CCTP (cross-chain) is Phase 2 — Sui USDC only for now.
 */
import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

interface Props {
  /** The zkLogin-derived Sui address (this IS the Harbor address) */
  address: string
  /** Optional: show a compact version in a sidebar/card */
  compact?: boolean
}

export function HarborFundQR({ address, compact = false }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied]   = useState(false)
  const [qrError, setQrError] = useState(false)

  useEffect(() => {
    if (!canvasRef.current || !address) return
    QRCode.toCanvas(canvasRef.current, address, {
      width:            compact ? 140 : 200,
      margin:           2,
      color: {
        dark:  '#00B8E6',   // CONK teal on dark
        light: '#05111C',   // match --bg
      },
      errorCorrectionLevel: 'M',
    }).catch(() => setQrError(true))
  }, [address, compact])

  const copy = () => {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const short = address
    ? `${address.slice(0, 10)}…${address.slice(-8)}`
    : ''

  if (compact) {
    return (
      <div style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        gap:            '10px',
        padding:        '14px',
        background:     'var(--surface)',
        border:         '1px solid var(--border2)',
        borderRadius:   'var(--radius-xl)',
      }}>
        <div style={{
          fontFamily:     'var(--font-mono)',
          fontSize:       '9px',
          fontWeight:     600,
          letterSpacing:  '0.12em',
          textTransform:  'uppercase',
          color:          'var(--teal)',
          marginBottom:   '2px',
        }}>
          Fund Harbor
        </div>

        {qrError ? (
          <div style={{ width: 140, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface2)', borderRadius: 'var(--radius)', border: '1px dashed var(--border2)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-off)', textAlign: 'center', padding: '8px' }}>QR unavailable</span>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            style={{ borderRadius: 'var(--radius)', display: 'block' }}
          />
        )}

        <div style={{
          fontFamily:   'var(--font-mono)',
          fontSize:     '9px',
          color:        'var(--text-dim)',
          textAlign:    'center',
          lineHeight:   1.6,
        }}>
          Send <span style={{ color: 'var(--teal)', fontWeight: 600 }}>USDC on Sui</span><br/>
          to activate your Harbor
        </div>

        <button
          onClick={copy}
          style={{
            width:          '100%',
            padding:        '7px 10px',
            background:     copied ? 'rgba(0,184,230,0.12)' : 'var(--surface2)',
            border:         `1px solid ${copied ? 'var(--teal)' : 'var(--border)'}`,
            borderRadius:   'var(--radius)',
            fontFamily:     'var(--font-mono)',
            fontSize:       '9px',
            color:          copied ? 'var(--teal)' : 'var(--text-dim)',
            cursor:         'pointer',
            letterSpacing:  '0.04em',
            textAlign:      'center',
            transition:     'all 0.15s',
          }}
        >
          {copied ? '✓ copied' : short}
        </button>
      </div>
    )
  }

  // Full version (Onboarding flow)
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      gap:            '16px',
      padding:        '24px 20px',
      background:     'var(--surface)',
      border:         '1px solid var(--border2)',
      borderRadius:   'var(--radius-xl)',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center' }}>
        <div style={{
          fontFamily:     'var(--font-display)',
          fontSize:       '18px',
          fontWeight:     600,
          color:          'var(--text)',
          marginBottom:   '6px',
        }}>
          Fund your Harbor
        </div>
        <div style={{
          fontFamily:   'var(--font-mono)',
          fontSize:     '10px',
          color:        'var(--text-dim)',
          lineHeight:   1.7,
          maxWidth:     '300px',
        }}>
          Your Sui address is live. Send <strong style={{ color: 'var(--teal)' }}>USDC on Sui mainnet</strong> to
          activate your Harbor and launch a Vessel.
        </div>
      </div>

      {/* QR */}
      <div style={{
        padding:      '12px',
        background:   '#05111C',
        borderRadius: 'var(--radius-lg)',
        border:       '1px solid var(--border2)',
        boxShadow:    '0 0 24px rgba(0,184,230,0.08)',
      }}>
        {qrError ? (
          <div style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-off)', textAlign: 'center' }}>
              QR unavailable<br/>copy address below
            </span>
          </div>
        ) : (
          <canvas ref={canvasRef} style={{ display: 'block' }} />
        )}
      </div>

      {/* Address copy */}
      <button
        onClick={copy}
        style={{
          width:          '100%',
          padding:        '10px 14px',
          background:     copied ? 'rgba(0,184,230,0.08)' : 'var(--surface2)',
          border:         `1px solid ${copied ? 'var(--teal)' : 'var(--border2)'}`,
          borderRadius:   'var(--radius-lg)',
          fontFamily:     'var(--font-mono)',
          fontSize:       '10px',
          color:          copied ? 'var(--teal)' : 'var(--text-dim)',
          cursor:         'pointer',
          letterSpacing:  '0.06em',
          textAlign:      'center',
          transition:     'all 0.15s',
        }}
        title={address}
      >
        {copied ? '✓ Address copied' : short}
      </button>

      {/* Network badge */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        gap:            '8px',
        padding:        '8px 14px',
        background:     'rgba(0,184,230,0.04)',
        border:         '1px solid var(--border)',
        borderRadius:   'var(--radius-lg)',
        width:          '100%',
        boxSizing:      'border-box',
      }}>
        <div style={{
          width:        '6px',
          height:       '6px',
          borderRadius: '50%',
          background:   'var(--teal)',
          flexShrink:   0,
        }}/>
        <span style={{
          fontFamily:   'var(--font-mono)',
          fontSize:     '9px',
          color:        'var(--text-dim)',
          lineHeight:   1.6,
        }}>
          <span style={{ color: 'var(--teal)', fontWeight: 600 }}>Sui mainnet only</span>
          {' '}· USDC (native Circle) · $0.06 minimum to open Harbor + Vessel
        </span>
      </div>

      {/* Privacy note */}
      <div style={{
        fontFamily:   'var(--font-mono)',
        fontSize:     '9px',
        color:        'var(--text-off)',
        textAlign:    'center',
        lineHeight:   1.7,
        opacity:      0.7,
      }}>
        This address is structurally isolated from your casts.<br/>
        Harbor sees only that balance decreased — nothing else.
      </div>
    </div>
  )
}
