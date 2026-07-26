import type { ResultSetHeader } from 'mysql2/promise'
import type { Queryable, SearchInput, SearchOutcome } from '../../types/domain.js'

export async function createSearch(db: Queryable, input: SearchInput): Promise<number> {
  const [res] = await db.query<ResultSetHeader>(
    `INSERT INTO scout_searches (
       niche, city, state, query_text, center_lat, center_lng,
       radius_km, tile_count, max_results, params_json, status, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'running', CURRENT_TIMESTAMP)`,
    [
      input.niche,
      input.city,
      input.state,
      input.queryText,
      input.centerLat,
      input.centerLng,
      input.radiusKm,
      input.tileCount,
      input.maxResults,
      JSON.stringify(input.params),
    ],
  )
  return res.insertId
}

export async function finishSearch(
  db: Queryable,
  searchId: number,
  outcome: SearchOutcome,
): Promise<void> {
  await db.query(
    `UPDATE scout_searches
        SET status = ?, discovered_count = ?, new_count = ?, updated_count = ?,
            error = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      outcome.status,
      outcome.discoveredCount,
      outcome.newCount,
      outcome.updatedCount,
      outcome.error ?? null,
      searchId,
    ],
  )
}

export type LinkOptions = {
  position?: number | null
  tileIndex?: number | null
  distanceKm?: number | null
  isNew?: boolean
  snapshot?: unknown
}

/**
 * Liga busca e prospect. O ON DUPLICATE KEY existe porque a mesma empresa aparece
 * duas vezes num mesmo `discover` quando dois tiles se sobrepoem -- e sobreposicao
 * de tiles e proposital, para nao perder quem fica na fronteira.
 */
export async function linkProspect(
  db: Queryable,
  searchId: number,
  prospectId: number,
  options: LinkOptions = {},
): Promise<void> {
  await db.query(
    `INSERT INTO scout_search_prospects (
       search_id, prospect_id, position, tile_index, distance_km, is_new, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON)) AS novo
     ON DUPLICATE KEY UPDATE
       position      = COALESCE(scout_search_prospects.position, novo.position),
       tile_index    = COALESCE(scout_search_prospects.tile_index, novo.tile_index),
       distance_km   = COALESCE(scout_search_prospects.distance_km, novo.distance_km),
       snapshot_json = COALESCE(scout_search_prospects.snapshot_json, novo.snapshot_json)`,
    [
      searchId,
      prospectId,
      options.position ?? null,
      options.tileIndex ?? null,
      options.distanceKm ?? null,
      options.isNew ?? false,
      options.snapshot === undefined ? null : JSON.stringify(options.snapshot),
    ],
  )
}
