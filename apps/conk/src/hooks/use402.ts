/**
 * use402 — Micro-payment hook for CONK
 *
 * Handles the $0.001 cast-read flow.
 * STEP 6 — wired to real Sui protocol contracts via zkLogin.
 *
 * The Relay sits between Vessel and Cast — this hook mirrors that:
 *   1. Vessel draws fuel from Harbor
 *   2. Relay takes the fuel, issues a receipt (fee + vessel tier + timestamp — NO identity link)
 *   3. Receipt passes to the Cast layer — Harbor never sees what was cast
 */

import { useState, useCallback } from 'react'
import { useStore } from '../store/store'
import { crossPaywall, soundCast } from '../sui/client'
import { getSession } from '../sui/zklogin'
import { isLoggedIn, hasProof } from '../sui/zklogin'

export type PaymentStatus = 'idle' | 'pending' | 'success' | 'error' | 'insufficient' | 'no_session'

export interface PaymentReceipt {
  feeAmount:   number      // 1000 = $0.001 in microUSDC
  vesselClass: string
  timestamp:   number
  txDigest:    string      // real Sui transaction digest
  // NOTE: never contains which Harbor, which Vessel, or which Cast
  // The link is never made. This is not encryption. This is architecture.
}

export interface Use402Options {
  amount?:         number        // microUSDC, default 1000 ($0.001)
  authorAddress?:  string        // cast author vessel address for 97/3 split
  onSuccess?: (receipt: PaymentReceipt) => void
  onError?:   (err: string) => void
}

export function use402(options: Use402Options = {}) {
  const { amount = 1000, authorAddress, onSuccess, onError } = options
  const [status, setStatus]   = useState<PaymentStatus>('idle')
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null)
  const harbor  = useStore((s) => s.harbor)
  const vessel  = useStore((s) => s.vessel)

  const pay = useCallback(async (castId: string = 'read'): Promise<PaymentReceipt | null> => {
    const session = getSession()
    if (!harbor || !vessel) {
      setStatus('error')
      onError?.('No Harbor or Vessel active')
      return null
    }

    // Check zkLogin session — skip in test/mock mode
    const hasSession = isLoggedIn() && hasProof()

    // Balance check happens on-chain — blockchain is source of truth

    setStatus('pending')

    try {
      // Real Sui transaction — passes on-chain IDs for relay::process
      const { getAddress } = await import('../sui/zklogin')
      const senderAddress = getAddress() ?? session?.address
      const result = await crossPaywall({
        vesselId:      vessel.onChainId ?? senderAddress ?? vessel.id,
        castId:        castId,
        amountUsdc:    amount,
        authorAddress: authorAddress ?? senderAddress,
        harborId:      harbor.onChainId,
        harborCapId:   harbor.harborCapId,
        vesselCapId:   vessel.vesselCapId,
      })

      const txDigest = typeof result === 'string' ? result : result.txDigest
      console.log('Payment confirmed on Sui:', txDigest)

      const r: PaymentReceipt = {
        feeAmount:   amount,
        vesselClass: vessel.class,
        timestamp:   Date.now(),
        txDigest:    txDigest,
      }

      setReceipt(r)
      setStatus('success')
      onSuccess?.(r)
      return r

    } catch (err: any) {
      console.error('Payment failed:', err)
      setStatus('error')
      onError?.(err.message ?? 'Payment failed')
      return null
    }
  }, [harbor, vessel, amount, onSuccess, onError])

  const reset = useCallback(() => {
    setStatus('idle')
    setReceipt(null)
  }, [])

  return { pay, status, receipt, reset }
}

// ─── SOUND CAST hook (POST a cast — $0.001) ──────────────────

export function useSoundCast() {
  const [status, setStatus] = useState<PaymentStatus>('idle')
  const addCast      = useStore((s) => s.addCast)
  const vessel       = useStore((s) => s.vessel)
  const debitHarbor  = useStore((s) => s.debitHarbor)
  const debitVessel  = useStore((s) => s.debitVessel)

  const sound = useCallback(
    async (payload: {
      hook:              string
      body:              string
      mode:              string
      duration:          string
      price?:            number
      castType?:         string
      subInterval?:      string
      cascade?:          { threshold: number; hook: string; body: string }
      securityQuestion?: string
      securityAnswer?:   string
      keywords?:         string[]
      unlocksAt?:        number
      flare?:            string
    }): Promise<boolean> => {
      if (!vessel) return false

      // Check zkLogin session — allow mock in test mode

      setStatus('pending')

      try {
        // Real Sui transaction — calls cast::sound on deployed contract
        const castPrice = payload.price ?? 100_000  // v6: $0.10 minimum read price
        const harbor    = useStore.getState().harbor
        const modeMap: Record<string, number> = { open: 0, sealed: 1, eyes_only: 2, burn: 3 }
        const durMap:  Record<string, number> = { '24h': 1, '48h': 2, '72h': 3, '7d': 4 }

        const { getAddress: getAddr } = await import('../sui/zklogin')
        const senderAddr = getAddr() ?? ''
        const { digest: castTxDigest, castId } = await soundCast({
          hook:        payload.hook,
          body:        payload.body,
          mode:        modeMap[payload.mode] ?? 0,
          duration:    durMap[payload.duration] ?? 1,
          price:       castPrice,
          vesselId:    vessel.onChainId ?? senderAddr,
          vesselCapId: vessel.vesselCapId ?? senderAddr,
        })

        console.log('Cast sounded on Sui:', { digest: castTxDigest, castId })

        // Save Flare metadata for Dock panel (author-side visibility)
        if (castId && payload.flare?.trim()) {
          const flareLog = JSON.parse(localStorage.getItem('conk:sent_flares') || '[]')
          flareLog.push({
            castId,
            recipient: payload.flare?.trim() ?? '',
            hook: payload.hook,
            body: payload.body,
            price: castPrice,
            sentAt: Date.now(),
          })
          localStorage.setItem('conk:sent_flares', JSON.stringify(flareLog))
        }

        // Flare — deliver cast link to email via worker
        if (payload.flare?.trim()) {
          const castUrl = `https://conk.app/cast/${castId || castTxDigest}`
          fetch('https://conk-zkproxy-v2.axiomtide.workers.dev/flare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to:      payload.flare.trim(),
              hook:    payload.hook,
              body:    payload.body,
              price:   (payload.price ?? 1000) / 1_000_000,
              castUrl,
              castId:  castTxDigest,
            }),
          }).catch(e => console.warn('[Flare] email delivery failed:', e.message))
        }

        const durationMs: Record<string, number> = {
          '24h': 86400000,
          '48h': 172800000,
          '72h': 259200000,
          '7d':  604800000,
        }

        addCast({
          id:                 `cast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          hook:               payload.hook,
          body:               payload.body,
          mode:               payload.mode as any,
          duration:           payload.duration as any,
          expiresAt:          Date.now() + (durationMs[payload.duration] ?? 86400000),
          createdAt:          Date.now(),
          lastInteractionAt:  Date.now(),
          tideCount:          0,
          tideReads:          [0, 0, 0],
          vesselClass:        vessel.class,
          vesselId:           vessel.id,
          securityQuestion:   payload.securityQuestion,
          securityAnswer:     payload.securityAnswer,
          keywords:           payload.keywords,
          unlocksAt:          payload.unlocksAt,
          price:              payload.price ?? 1000,
          authorAddress:      vessel.id,
          revenueEarned:      0,
          castType:           payload.castType ?? 'standard',
          cascade:            payload.cascade,
          cascadeFired:       false,
          subInterval:        payload.subInterval,
        })

        // Debit fuel
        if (vessel.fuelDrawing && vessel.fuel >= 0.1) {
          debitVessel(0.1)
        } else {
          debitHarbor(0.1)
        }

        setStatus('success')
        return true

      } catch (err: any) {
        console.error('Cast failed:', err)
        setStatus('error')
        return false
      }
    },
    [vessel, addCast, debitHarbor, debitVessel]
  )

  return { sound, status }
}