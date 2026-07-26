import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Queryable, ProspectInput, UpsertResult, StageStatus } from '../../types/domain.js'

/**
 * Upsert pela chave natural (source, dedupe_key).
 *
 * Duas decisoes que definem o comportamento de re-scraping:
 *
 * 1. Todo campo opcional usa COALESCE(new.col, scout_prospects.col). Sem isso, um
 *    segundo `discover` em que o Maps nao mostrou o telefone (acontece: o painel
 *    varia) apagaria o telefone que o run anterior tinha achado. Dado bom nunca e
 *    substituido por NULL.
 *
 * 2. `name` e `updated_at` sao sempre sobrescritos, e `last_seen_at` marcado. E
 *    assim que "rodar de novo = 0 novos, todos revistos" fica verificavel.
 *
 * Usa o alias de linha `AS novo` (MySQL 8.0.19+) em vez de VALUES(), que esta
 * depreciado desde a 8.0.20 e emite warning no 8.4.
 */

const UPSERT_SQL = `
INSERT INTO scout_prospects (
  source, dedupe_key, place_ftid, name, category, maps_url,
  phone_raw, phone_e164, phone_kind, website, domain,
  address, city, state, lat, lng, rating, reviews_count, hours_json,
  first_seen_at, last_seen_at
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON),
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
) AS novo
ON DUPLICATE KEY UPDATE
  name          = novo.name,
  place_ftid    = COALESCE(novo.place_ftid, scout_prospects.place_ftid),
  category      = COALESCE(novo.category, scout_prospects.category),
  maps_url      = COALESCE(novo.maps_url, scout_prospects.maps_url),
  phone_raw     = COALESCE(novo.phone_raw, scout_prospects.phone_raw),
  phone_e164    = COALESCE(novo.phone_e164, scout_prospects.phone_e164),
  phone_kind    = IF(novo.phone_kind = 'unknown', scout_prospects.phone_kind, novo.phone_kind),
  website       = COALESCE(novo.website, scout_prospects.website),
  domain        = COALESCE(novo.domain, scout_prospects.domain),
  address       = COALESCE(novo.address, scout_prospects.address),
  city          = COALESCE(novo.city, scout_prospects.city),
  state         = COALESCE(novo.state, scout_prospects.state),
  lat           = COALESCE(novo.lat, scout_prospects.lat),
  lng           = COALESCE(novo.lng, scout_prospects.lng),
  rating        = COALESCE(novo.rating, scout_prospects.rating),
  reviews_count = COALESCE(novo.reviews_count, scout_prospects.reviews_count),
  hours_json    = COALESCE(novo.hours_json, scout_prospects.hours_json),
  last_seen_at  = CURRENT_TIMESTAMP,
  id            = LAST_INSERT_ID(scout_prospects.id)
`

export async function upsertProspect(db: Queryable, input: ProspectInput): Promise<UpsertResult> {
  const [res] = await db.query<ResultSetHeader>(UPSERT_SQL, [
    input.source,
    input.dedupeKey,
    input.placeFtid,
    input.name,
    input.category,
    input.mapsUrl,
    input.phoneRaw,
    input.phoneE164,
    input.phoneKind,
    input.website,
    input.domain,
    input.address,
    input.city,
    input.state,
    input.lat,
    input.lng,
    input.rating,
    input.reviewsCount,
    input.hours ? JSON.stringify(input.hours) : null,
  ])

  // affectedRows: 1 = inseriu, 2 = atualizou, 0 = casou mas nada mudou (o UPDATE
  // sempre toca last_seen_at, entao 0 na pratica so aparece em re-run no mesmo
  // segundo). Tratar 0 como "nao e novo" e o correto nos dois casos.
  return { id: res.insertId, isNew: res.affectedRows === 1 }
}

export type ProspectRow = RowDataPacket & {
  id: number
  name: string
  website: string | null
  domain: string | null
  phone_e164: string | null
  whatsapp_phone_e164: string | null
  instagram_url: string | null
  facebook_url: string | null
  enrichment_status: StageStatus
  social_status: StageStatus
  wa_check_status: StageStatus
}

/** Prospects que ainda precisam de um estagio. Ordem estavel para lotes retomaveis. */
export async function findPendingForStage(
  db: Queryable,
  stage: 'enrichment' | 'social' | 'wa_check',
  limit: number,
  options: { retryFailed?: boolean; includeDone?: boolean } = {},
): Promise<ProspectRow[]> {
  const column = `${stage}_status`

  // `includeDone` existe para o --force-llm: regerar a analise de uma empresa ja
  // enriquecida nao e reprocessar uma falha, e sem isto seria impossivel -- ela
  // nunca mais apareceria na fila.
  const allowed = new Set(['pending'])
  if (options.retryFailed) allowed.add('failed')
  if (options.includeDone) { allowed.add('done'); allowed.add('failed') }
  const estados = [...allowed]

  // `column` nao vem do usuario -- e derivado de uma union de tres literais --
  // mas fica interpolado, entao a restricao esta declarada aqui de proposito.
  const extra =
    stage === 'enrichment'
      ? 'AND website IS NOT NULL'
      : stage === 'social'
        ? 'AND (instagram_url IS NOT NULL OR facebook_url IS NOT NULL)'
        : 'AND whatsapp_phone_e164 IS NOT NULL'

  const [rows] = await db.query<ProspectRow[]>(
    `SELECT * FROM scout_prospects
      WHERE ${column} IN (${estados.map(() => '?').join(', ')})
        AND pipeline_status <> 'descartado'
        ${extra}
      ORDER BY id ASC
      LIMIT ?`,
    [...estados, limit],
  )
  return rows
}

export async function setStageStatus(
  db: Queryable,
  prospectId: number,
  stage: 'enrichment' | 'social' | 'wa_check',
  status: StageStatus,
): Promise<void> {
  const timestampColumn = stage === 'enrichment' ? 'enriched_at' : `${stage === 'social' ? 'social_checked' : 'wa_checked'}_at`
  await db.query(
    `UPDATE scout_prospects
        SET ${stage}_status = ?,
            ${timestampColumn} = IF(? IN ('done', 'failed'), CURRENT_TIMESTAMP, ${timestampColumn})
      WHERE id = ?`,
    [status, status, prospectId],
  )
}

export type ProspectPatch = {
  website?: string | null
  domain?: string | null
  email?: string | null
  phoneE164?: string | null
  phoneKind?: string | null
  whatsappPhoneE164?: string | null
  whatsappSource?: string | null
  instagramUrl?: string | null
  instagramFollowers?: number | null
  facebookUrl?: string | null
  facebookResponseTime?: string | null
  chatWidget?: string | null
  ecommercePlatform?: string | null
}

const PATCH_COLUMNS: Record<keyof ProspectPatch, string> = {
  website: 'website',
  domain: 'domain',
  email: 'email',
  phoneE164: 'phone_e164',
  phoneKind: 'phone_kind',
  whatsappPhoneE164: 'whatsapp_phone_e164',
  whatsappSource: 'whatsapp_source',
  instagramUrl: 'instagram_url',
  instagramFollowers: 'instagram_followers',
  facebookUrl: 'facebook_url',
  facebookResponseTime: 'facebook_response_time',
  chatWidget: 'chat_widget',
  ecommercePlatform: 'ecommerce_platform',
}

/** Atualiza so as chaves presentes no patch. `undefined` = nao mexe, `null` = limpa. */
export async function patchProspect(
  db: Queryable,
  prospectId: number,
  patch: ProspectPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return

  const sets = entries.map(([k]) => `${PATCH_COLUMNS[k as keyof ProspectPatch]} = ?`)
  const values = entries.map(([, v]) => v)
  await db.query(`UPDATE scout_prospects SET ${sets.join(', ')} WHERE id = ?`, [
    ...values,
    prospectId,
  ])
}
