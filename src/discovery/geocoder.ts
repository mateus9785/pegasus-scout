import axios from 'axios'
import { loadEnv } from '../config/env.js'
import { cacheGeocode, getCachedGeocode } from '../db/repositories/geocodeRepo.js'
import type { Queryable } from '../types/domain.js'
import type { LatLng } from '../utils/geo.js'
import { childLogger } from '../logger/logger.js'
import { ScoutError } from '../errors.js'
import { sleep } from '../browser/humanize.js'

const log = childLogger({ mod: 'geocoder' })

/**
 * Resolve "Brasilia, DF" em coordenada, usando o Nominatim do OpenStreetMap.
 *
 * Nominatim e gratuito, e por isso a politica de uso e estrita: no maximo 1
 * requisicao por segundo e um User-Agent identificavel com contato real. Quem ignora
 * leva bloqueio de IP. As duas regras estao implementadas aqui -- o cache em tabela
 * garante que a mesma cidade nunca seja consultada duas vezes, e a pausa de 1s
 * cobre o caso de varias cidades numa mesma sessao.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const MIN_INTERVAL_MS = 1_100

let lastRequestAt = 0

export type GeocodeResult = LatLng & { displayName: string | null; fromCache: boolean }

export async function geocodeCity(
  db: Queryable,
  city: string,
  state: string | null,
): Promise<GeocodeResult> {
  const env = loadEnv()
  const query = state ? `${city}, ${state}, Brasil` : `${city}, Brasil`

  const cached = await getCachedGeocode(db, query)
  if (cached) {
    log.debug({ query }, 'geocode do cache')
    return { ...cached, fromCache: true }
  }

  if (env.SCOUT_NOMINATIM_EMAIL.trim() === '') {
    throw new ScoutError(
      'SCOUT_NOMINATIM_EMAIL esta vazio e a cidade nao esta no cache.',
      'Preencha SCOUT_NOMINATIM_EMAIL no .env (a politica do OpenStreetMap exige contato real), ou passe --lat e --lng direto para pular o geocoding.',
    )
  }

  const espera = MIN_INTERVAL_MS - (Date.now() - lastRequestAt)
  if (espera > 0) await sleep(espera)
  lastRequestAt = Date.now()

  log.info({ query }, 'consultando Nominatim')
  const response = await axios.get<Array<{ lat: string; lon: string; display_name: string }>>(
    NOMINATIM_URL,
    {
      params: { q: query, format: 'json', limit: 1, countrycodes: 'br' },
      timeout: env.SCOUT_HTTP_TIMEOUT_MS,
      headers: {
        // Identificacao exigida pela politica de uso. Sem isso o Nominatim
        // responde 403 depois de algumas chamadas.
        'User-Agent': `pegasus-scout/0.1 (${env.SCOUT_NOMINATIM_EMAIL.trim()})`,
        'Accept-Language': 'pt-BR',
      },
      validateStatus: (status) => status < 500,
    },
  )

  const hit = response.data?.[0]
  if (!hit) {
    throw new ScoutError(
      `Nao encontrei a cidade "${query}" no OpenStreetMap.`,
      'Confira a grafia de --city e --state, ou passe --lat e --lng direto.',
    )
  }

  const result: LatLng & { displayName: string | null } = {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    displayName: hit.display_name ?? null,
  }
  await cacheGeocode(db, query, result)
  return { ...result, fromCache: false }
}
