import type { MapsPage } from './mapsPage.js'
import type { Queryable, ProspectInput, SearchOutcome } from '../types/domain.js'
import type { SearchParams } from '../config/searchParams.js'
import type { LatLng } from '../utils/geo.js'
import { buildTiles } from './tiling.js'
import { buildQueryText } from './mapsUrl.js'
import { parseFeed } from './parseFeed.js'
import type { ParsedFeedItem } from './parseFeed.js'
import { parseDetail } from './parseDetail.js'
import { buildDedupeKey } from './dedupeKey.js'
import { createSearch, finishSearch, linkProspect } from '../db/repositories/searchRepo.js'
import { upsertProspect } from '../db/repositories/prospectRepo.js'
import { upsertSignal } from '../db/repositories/signalRepo.js'
import { parseBrazilPhone } from '../utils/phone.js'
import { parseBrazilAddress } from '../utils/address.js'
import { extractDomain, isOwnWebsite } from '../utils/url.js'
import { distanceKm } from '../utils/geo.js'
import { humanPause } from '../browser/humanize.js'
import { childLogger } from '../logger/logger.js'
import { SelectorError } from '../errors.js'

const log = childLogger({ stage: 'discovery' })

export type DiscoveryProgress = (event: {
  tile: number
  totalTiles: number
  found: number
  novos: number
}) => void

export type DiscoveryResult = SearchOutcome & { searchId: number; tilesVisitados: number }

/**
 * Orquestra a descoberta: divide a regiao em tiles, varre cada um, abre a ficha de
 * quem for novo e grava.
 *
 * Duas propriedades de projeto, porque um scraper que roda 40 minutos vai ser
 * interrompido:
 *
 * 1. Cada prospect e gravado assim que e lido, nao no fim. Um Ctrl+C no tile 12
 *    preserva os 11 tiles anteriores.
 * 2. Falha num tile nao derruba a busca -- ela e registrada e o loop continua, e o
 *    status final vira 'partial'. A excecao e SelectorError, que significa "o layout
 *    do Google mudou": ai insistir nos tiles restantes so gera lixo, e a busca para.
 */
export async function runDiscovery(
  db: Queryable,
  maps: MapsPage,
  params: SearchParams,
  center: LatLng,
  onProgress?: DiscoveryProgress,
): Promise<DiscoveryResult> {
  const queryText = buildQueryText(params.niche, params.city, params.state)
  const tiles = buildTiles(center, params.radiusKm, { tileKm: params.tileKm })

  const searchId = await createSearch(db, {
    niche: params.niche,
    city: params.city,
    state: params.state,
    queryText,
    centerLat: center.lat,
    centerLng: center.lng,
    radiusKm: params.radiusKm,
    tileCount: tiles.length,
    maxResults: params.maxResults,
    params: { tileKm: params.tileKm, withDetails: params.withDetails },
  })

  log.info({ searchId, queryText, tiles: tiles.length }, 'busca iniciada')

  let discovered = 0
  let novos = 0
  let atualizados = 0
  let tilesVisitados = 0
  const erros: string[] = []
  const vistosNestaBusca = new Set<string>()

  for (const tile of tiles) {
    if (discovered >= params.maxResults) {
      log.info({ discovered, max: params.maxResults }, 'teto de resultados atingido')
      break
    }

    try {
      await maps.search(queryText, tile.center, tile.zoom)
      const { reachedEnd } = await maps.scrollFeed()
      const items = parseFeed(await maps.getFeedHtml())
      tilesVisitados += 1

      log.info(
        { tile: tile.index, itens: items.length, reachedEnd },
        `tile ${tile.index + 1}/${tiles.length} varrido`,
      )

      for (const item of items) {
        if (discovered >= params.maxResults) break

        // Dedupe DENTRO da busca antes de tocar o banco: tiles se sobrepoem de
        // proposito, entao a mesma loja aparece varias vezes num mesmo run e nao
        // faz sentido reabrir a ficha dela a cada aparicao.
        const provisoria = buildDedupeKey({
          placeFtid: item.placeFtid,
          name: item.name,
          lat: item.lat,
          lng: item.lng,
        })
        if (vistosNestaBusca.has(provisoria)) continue
        vistosNestaBusca.add(provisoria)

        const gravado = await persistItem(db, maps, searchId, item, tile.index, center, params)
        discovered += 1
        if (gravado.isNew) novos += 1
        else atualizados += 1

        onProgress?.({ tile: tile.index, totalTiles: tiles.length, found: discovered, novos })
      }

      await humanPause()
    } catch (err) {
      if (err instanceof SelectorError) {
        // Layout mudou: continuar so produziria registros vazios.
        erros.push(`tile ${tile.index}: ${err.message}`)
        log.error({ tile: tile.index, err: err.message }, 'seletor quebrado, abortando a busca')
        break
      }
      erros.push(`tile ${tile.index}: ${String(err)}`)
      log.warn({ tile: tile.index, err: String(err) }, 'tile falhou, seguindo para o proximo')
    }
  }

  const status: SearchOutcome['status'] =
    erros.length === 0 ? 'completed' : discovered > 0 ? 'partial' : 'failed'

  const outcome: SearchOutcome = {
    status,
    discoveredCount: discovered,
    newCount: novos,
    updatedCount: atualizados,
    error: erros.length > 0 ? erros.join('\n') : null,
  }
  await finishSearch(db, searchId, outcome)

  log.info({ searchId, ...outcome }, 'busca encerrada')
  return { ...outcome, searchId, tilesVisitados }
}

/**
 * Grava um item do feed, opcionalmente abrindo a ficha para completar os campos que
 * o card nao mostra.
 *
 * O site e o principal deles, e e o insumo do enrichment -- sem ele o prospect nao
 * avanca no pipeline. Por isso `--no-details` existe como modo rapido de
 * levantamento, e nao como padrao.
 */
async function persistItem(
  db: Queryable,
  maps: MapsPage,
  searchId: number,
  item: ParsedFeedItem,
  tileIndex: number,
  center: LatLng,
  params: SearchParams,
): Promise<{ id: number; isNew: boolean }> {
  let detail: ReturnType<typeof parseDetail> | null = null

  if (params.withDetails && item.mapsUrl) {
    const url = item.mapsUrl.startsWith('http')
      ? item.mapsUrl
      : `https://www.google.com${item.mapsUrl}`
    try {
      detail = parseDetail(await maps.getPlaceHtml(url), url)
      await humanPause(0.6)
    } catch (err) {
      // Ficha que nao abre nao invalida o card: o que o feed deu ja e util.
      log.warn({ nome: item.name, err: String(err) }, 'ficha nao abriu, seguindo com o card')
    }
  }

  const phoneRaw = detail?.phoneRaw ?? item.phoneRaw
  const phone = parseBrazilPhone(phoneRaw)
  const address = parseBrazilAddress(detail?.address ?? item.addressHint)

  // Site em plataforma de terceiro (Instagram, Linktree, business.site) nao entra
  // como website: enriquecer aquilo acharia o widget de chat da plataforma e
  // classificaria a empresa como ja automatizada. Mas a informacao nao se perde --
  // ela e gravada como sinal.
  const rawWebsite = detail?.website ?? null
  const website = rawWebsite && isOwnWebsite(rawWebsite) ? rawWebsite : null

  const lat = detail?.lat ?? item.lat
  const lng = detail?.lng ?? item.lng

  const input: ProspectInput = {
    source: 'google_maps',
    dedupeKey: buildDedupeKey({
      placeFtid: detail?.placeFtid ?? item.placeFtid,
      name: item.name,
      lat,
      lng,
    }),
    placeFtid: detail?.placeFtid ?? item.placeFtid,
    name: detail?.name || item.name,
    category: detail?.category ?? item.category,
    mapsUrl: item.mapsUrl,
    phoneRaw,
    phoneE164: phone?.e164 ?? null,
    phoneKind: phone?.kind ?? 'unknown',
    website,
    domain: extractDomain(website),
    address: address?.full ?? null,
    city: address?.city ?? params.city,
    state: address?.state ?? params.state,
    lat,
    lng,
    rating: detail?.rating ?? item.rating,
    reviewsCount: detail?.reviewsCount ?? item.reviewsCount,
    hours: detail?.hours ?? null,
  }

  const result = await upsertProspect(db, input)

  const distancia = lat !== null && lng !== null ? distanceKm(center, { lat, lng }) : null
  await linkProspect(db, searchId, result.id, {
    position: item.position,
    tileIndex,
    distanceKm: distancia,
    isNew: result.isNew,
    snapshot: {
      nome: item.name,
      categoria: item.category,
      nota: item.rating,
      status: item.openStatus,
      telefone: item.phoneRaw,
    },
  })

  await recordDiscoverySignals(db, result.id, item, detail, rawWebsite, website)

  return result
}

async function recordDiscoverySignals(
  db: Queryable,
  prospectId: number,
  item: ParsedFeedItem,
  detail: ReturnType<typeof parseDetail> | null,
  rawWebsite: string | null,
  website: string | null,
): Promise<void> {
  const sinais: Array<{ key: string; value: string | null; evidence?: string }> = []

  if (!website) {
    // Nao ter site proprio e um dos sinais mais fortes de maturidade digital baixa,
    // e portanto de atendimento manual.
    sinais.push({
      key: 'sem_site_proprio',
      value: rawWebsite ? 'apenas plataforma de terceiro' : 'nenhum site no Maps',
      ...(rawWebsite ? { evidence: rawWebsite } : {}),
    })
  }
  if (rawWebsite && !website) {
    sinais.push({ key: 'site_em_plataforma_terceiro', value: rawWebsite, evidence: rawWebsite })
  }
  if (item.openStatus) {
    sinais.push({ key: 'status_maps', value: item.openStatus })
  }
  if (detail?.hours) {
    sinais.push({
      key: 'horario_declarado_maps',
      value: `${Object.keys(detail.hours).length} dia(s)`,
      evidence: JSON.stringify(detail.hours),
    })
  }
  if ((detail?.reviewsCount ?? item.reviewsCount) !== null) {
    sinais.push({
      key: 'volume_avaliacoes',
      value: String(detail?.reviewsCount ?? item.reviewsCount),
    })
  }

  for (const sinal of sinais) {
    await upsertSignal(db, {
      prospectId,
      stage: 'discovery',
      key: sinal.key,
      value: sinal.value,
      evidence: sinal.evidence ?? null,
      sourceUrl: item.mapsUrl,
    })
  }
}
