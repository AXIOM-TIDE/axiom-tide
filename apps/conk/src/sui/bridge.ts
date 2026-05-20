/**
 * CONK Bridge — Auto-Provision Module
 * Phase 1: Google sign-in → real Harbor + Vessel on-chain
 *
 * provisionOnChainIdentity(session) is idempotent:
 *   - Harbor already exists  → returns existing IDs, skips harbor::open
 *   - Vessel already exists  → returns existing IDs, skips vessel::launch
 *   - No USDC               → funded: false, harborId/vesselId: null, UI prompts funding
 *   - Success               → funded: true, real on-chain object IDs returned
 */

import { openHarbor, launchVessel, getSuiClient } from './client'
import type { ZkLoginSession } from './zklogin'
import { PACKAGES } from './index'

const PACKAGE = PACKAGES.CONK

// ── Result shape ───────────────────────────────────────────────

export interface ProvisionResult {
  address:        string
  harborId:       string | null   // Harbor shared object ID (null = unfunded)
  harborCapId:    string | null   // HarborCap owned object ID (null = unfunded)
  vesselId:       string | null   // Vessel shared object ID (null = unfunded)
  vesselCapId:    string | null   // VesselCap owned object ID (null = unfunded)
  alreadyExisted: boolean         // true if Harbor was already on-chain before this call
  funded:         boolean         // false if no USDC — UI should prompt funding
}

// ── On-chain existence check ───────────────────────────────────

interface ExistingIdentity {
  harborId:    string | null
  harborCapId: string | null
  vesselId:    string | null
  vesselCapId: string | null
}

async function findExistingIdentity(address: string): Promise<ExistingIdentity> {
  const none: ExistingIdentity = {
    harborId:    null,
    harborCapId: null,
    vesselId:    null,
    vesselCapId: null,
  }

  try {
    const client = await getSuiClient()

    // Fetch ALL owned objects and match by type suffix — this is package-version
    // agnostic. Filtering by exact StructType breaks when the user's Harbor/Vessel
    // was created under a different package version (v1–v8 vs current v9+).
    const allObjects = await (client as any).getOwnedObjects({
      owner:   address,
      options: { showType: true, showContent: true },
      limit:   50,
    })
    const allData: any[] = allObjects?.data ?? []

    // HarborCap — type ends in ::harbor::HarborCap regardless of package version
    const harborCapRaw = allData.find(
      (o: any) => (o?.data?.type ?? '').includes('::harbor::HarborCap')
    )?.data ?? null
    if (!harborCapRaw) return none

    const harborCapId = harborCapRaw.objectId as string | null ?? null
    const harborId =
      (harborCapRaw.content as any)?.fields?.harbor_id ??
      (harborCapRaw.content as any)?.fields?.for ??
      null

    // VesselCap — type ends in ::vessel::VesselCap
    const vesselCapRaw = allData.find(
      (o: any) => (o?.data?.type ?? '').includes('::vessel::VesselCap')
    )?.data ?? null
    const vesselCapId = vesselCapRaw?.objectId ?? null
    const vesselId =
      (vesselCapRaw?.content as any)?.fields?.vessel_id ??
      (vesselCapRaw?.content as any)?.fields?.for ??
      null

    return { harborId, harborCapId, vesselId, vesselCapId }

  } catch (err) {
    console.warn('[bridge] Identity lookup failed:', err)
    return none
  }
}

// ── Main provision function ────────────────────────────────────

export async function provisionOnChainIdentity(
  session: ZkLoginSession
): Promise<ProvisionResult> {
  const { address } = session

  // 1. Idempotency check — query on-chain state first
  const existing = await findExistingIdentity(address)

  if (existing.harborCapId) {
    console.log('[bridge] Harbor already exists for', address, '— harborId:', existing.harborId)

    // Harbor exists. Check if Vessel is also present.
    if (existing.vesselCapId) {
      return {
        address,
        harborId:       existing.harborId,
        harborCapId:    existing.harborCapId,
        vesselId:       existing.vesselId,
        vesselCapId:    existing.vesselCapId,
        alreadyExisted: true,
        funded:         true,
      }
    }

    // Harbor exists but no Vessel — launch one now
    if (existing.harborId && existing.harborCapId) {
      try {
        const { vesselId, vesselCapId } = await launchVessel(
          existing.harborId,
          existing.harborCapId
        )
        return {
          address,
          harborId:       existing.harborId,
          harborCapId:    existing.harborCapId,
          vesselId,
          vesselCapId,
          alreadyExisted: true,
          funded:         true,
        }
      } catch (err) {
        console.warn('[bridge] Vessel launch for existing Harbor failed:', err)
        // Return partial — Harbor exists, Vessel creation failed
        return {
          address,
          harborId:       existing.harborId,
          harborCapId:    existing.harborCapId,
          vesselId:       null,
          vesselCapId:    null,
          alreadyExisted: true,
          funded:         true,
        }
      }
    }

    // Harbor confirmed (by cap) but ID not extractable from fields — return cap only
    return {
      address,
      harborId:       existing.harborId,
      harborCapId:    existing.harborCapId,
      vesselId:       existing.vesselId,
      vesselCapId:    existing.vesselCapId,
      alreadyExisted: true,
      funded:         true,
    }
  }

  // 2. No Harbor — attempt creation
  try {
    const { harborId, harborCapId } = await openHarbor(1)
    const { vesselId, vesselCapId } = await launchVessel(harborId, harborCapId)

    console.log('[bridge] Provisioned Harbor:', harborId, 'Vessel:', vesselId)

    return {
      address,
      harborId,
      harborCapId,
      vesselId,
      vesselCapId,
      alreadyExisted: false,
      funded:         true,
    }
  } catch (err: any) {
    const msg: string = err?.message ?? ''

    // No USDC — return partial result, UI prompts user to fund before activating
    if (msg.includes('No USDC') || msg.includes('fund')) {
      console.warn('[bridge] Unfunded address — Harbor not provisioned:', address)
      return {
        address,
        harborId:       null,
        harborCapId:    null,
        vesselId:       null,
        vesselCapId:    null,
        alreadyExisted: false,
        funded:         false,
      }
    }

    // Any other error propagates — caller decides fallback
    throw err
  }
}
