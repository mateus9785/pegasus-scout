import type { RowDataPacket } from 'mysql2/promise'
import type { Queryable } from '../../types/domain.js'

export type GeocodeHit = { lat: number; lng: number; displayName: string | null }

export async function getCachedGeocode(db: Queryable, query: string): Promise<GeocodeHit | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT lat, lng, display_name FROM scout_geocode_cache WHERE query = ? LIMIT 1`,
    [query],
  )
  const row = rows[0]
  if (!row) return null
  return {
    lat: Number(row['lat']),
    lng: Number(row['lng']),
    displayName: (row['display_name'] as string | null) ?? null,
  }
}

export async function cacheGeocode(
  db: Queryable,
  query: string,
  hit: GeocodeHit,
  provider = 'nominatim',
): Promise<void> {
  await db.query(
    `INSERT INTO scout_geocode_cache (query, lat, lng, display_name, provider)
     VALUES (?, ?, ?, ?, ?) AS novo
     ON DUPLICATE KEY UPDATE
       lat = novo.lat, lng = novo.lng, display_name = novo.display_name, provider = novo.provider`,
    [query, hit.lat, hit.lng, hit.displayName, provider],
  )
}
