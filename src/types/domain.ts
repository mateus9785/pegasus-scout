import type { Pool, PoolConnection } from 'mysql2/promise'

/**
 * Tudo que fala com o MySQL recebe um `Queryable` explicito em vez de importar o
 * pool global. E o que permite os testes de integracao apontarem para o banco
 * DB_NAME_TEST sem monkey-patch e sem risco de uma suite truncar tabela do banco
 * de trabalho por engano.
 */
export type Queryable = Pool | PoolConnection

export type SourceKind = 'google_maps' | 'manual'
export type PhoneKind = 'mobile' | 'fixed' | 'unknown'
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type SearchStatus = 'running' | 'completed' | 'partial' | 'failed' | 'canceled'
export type SignalStage = 'discovery' | 'enrichment' | 'social' | 'whatsapp_check' | 'scoring'
export type AutomationVerdict =
  | 'indefinido'
  | 'provavelmente_manual'
  | 'provavelmente_automatizado'
export type PipelineStatus = 'novo' | 'qualificado' | 'descartado' | 'em_atendimento'
export type WhatsappSource = 'maps_phone' | 'site_link' | 'business_profile' | 'manual'

/** Horario de funcionamento como o Maps expoe: um rotulo por dia da semana. */
export type OpeningHours = Record<string, string>

/** Um item do painel lateral de resultados do Maps, ja parseado. */
export type MapsFeedItem = {
  placeFtid: string | null
  name: string
  category: string | null
  rating: number | null
  reviewsCount: number | null
  addressHint: string | null
  mapsUrl: string | null
  position: number
}

/** A ficha completa de um lugar, parseada do painel de detalhe do Maps. */
export type MapsPlaceDetail = {
  placeFtid: string | null
  name: string
  category: string | null
  rating: number | null
  reviewsCount: number | null
  address: string | null
  phoneRaw: string | null
  website: string | null
  plusCode: string | null
  hours: OpeningHours | null
  lat: number | null
  lng: number | null
}

/** O que o discovery grava. Campos nulos nao sobrescrevem valor ja existente. */
export type ProspectInput = {
  source: SourceKind
  dedupeKey: string
  placeFtid: string | null
  name: string
  category: string | null
  mapsUrl: string | null
  phoneRaw: string | null
  phoneE164: string | null
  phoneKind: PhoneKind
  website: string | null
  domain: string | null
  address: string | null
  city: string | null
  state: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  reviewsCount: number | null
  hours: OpeningHours | null
}

export type UpsertResult = { id: number; isNew: boolean }

export type SignalInput = {
  prospectId: number
  stage: SignalStage
  key: string
  value?: string | null
  confidence?: number
  evidence?: string | null
  sourceUrl?: string | null
}

export type SearchInput = {
  niche: string
  city: string
  state: string | null
  queryText: string
  centerLat: number | null
  centerLng: number | null
  radiusKm: number
  tileCount: number
  maxResults: number
  params: Record<string, unknown>
}

export type SearchOutcome = {
  status: SearchStatus
  discoveredCount: number
  newCount: number
  updatedCount: number
  error?: string | null
}

export type WhatsappCheckInput = {
  prospectId: number
  phoneE164: string
  existsOnWhatsapp: boolean | null
  isBusiness: boolean | null
  hasCatalog: boolean | null
  hasAwayMessageHint: boolean | null
  profileDescription: string | null
  businessCategory: string | null
  declaredHours: OpeningHours | null
  status: 'ok' | 'not_found' | 'failed' | 'skipped'
  error?: string | null
}
