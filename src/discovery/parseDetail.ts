import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { MapsPlaceDetail, OpeningHours } from '../types/domain.js'
import { squish } from '../utils/text.js'
import { parseMapCenter, parsePlaceRef } from './mapsUrl.js'

/**
 * Parser da ficha do lugar. Funcao pura -- testada contra
 * tests/fixtures/maps/detail-*.html.
 *
 * Aqui a ancoragem e melhor que no feed: o Google marca os campos da ficha com
 * `data-item-id` semantico (`address`, `authority`, `phone:tel:`, `oloc`), atributo
 * que ele usa ha anos e que sobrevive as trocas de nome de classe.
 *
 * O valor vem do `aria-label` e nao do texto visivel porque o texto e truncado com
 * elipse em tela estreita, enquanto o aria-label carrega o conteudo integral -- foi
 * assim que enderecos apareceram cortados na primeira versao.
 */

/** "Endereco: Rua X, 100 " -> "Rua X, 100". Devolve null se o rotulo nao casar. */
function valueAfterLabel(ariaLabel: string | undefined, label: string): string | null {
  if (!ariaLabel) return null
  const prefix = `${label}:`
  const index = ariaLabel.indexOf(prefix)
  if (index < 0) return squish(ariaLabel) || null
  return squish(ariaLabel.slice(index + prefix.length)) || null
}

function parseRating($: CheerioAPI): number | null {
  const candidates = [
    $('div.F7nice span[aria-hidden="true"]').first().text(),
    $('[aria-label*="estrela"]').first().attr('aria-label') ?? '',
  ]
  for (const candidate of candidates) {
    const match = squish(candidate).match(/(\d+[,.]\d+|\d+)/)
    if (!match?.[1]) continue
    const value = Number(match[1].replace(',', '.'))
    if (Number.isFinite(value) && value > 0 && value <= 5) return value
  }
  return null
}

/**
 * Contagem de avaliacoes. Frequentemente ausente: o bloco de avaliacoes entra por
 * XHR depois do resto da ficha, e a captura nao espera por ele de proposito (nao
 * vale segundos por prospect por um campo que o scoring trata como opcional).
 */
function parseReviewsCount($: CheerioAPI): number | null {
  const fromAria = $('[aria-label*="avaliaç"], [aria-label*="avaliac"]')
    .first()
    .attr('aria-label')
  const ariaMatch = squish(fromAria ?? '').match(/([\d.]+)\s*avalia/i)
  if (ariaMatch?.[1]) return Number(ariaMatch[1].replace(/\./g, ''))

  let found: number | null = null
  $('div.F7nice span, button[jsaction*="reviewChart"] span').each((_, el) => {
    if (found !== null) return
    const match = squish($(el).text()).match(/^\((\d{1,3}(?:\.\d{3})*|\d+)\)$/)
    if (match?.[1]) found = Number(match[1].replace(/\./g, ''))
  })
  return found
}

/**
 * Horario de funcionamento.
 *
 * Atencao: na ficha recem-aberta a tabela vem COLAPSADA, com apenas a linha de
 * hoje. Expandir exigiria um clique por prospect. O que interessa a Etapa 1 e se a
 * empresa declara horario (sinal de organizacao), nao a semana completa -- entao o
 * parser aceita o parcial e nao finge que tem sete dias.
 */
function parseHours($: CheerioAPI): OpeningHours | null {
  const hours: OpeningHours = {}

  $('table.eK4R0e tr, table[aria-label*="orário"] tr, table[aria-label*="orario"] tr').each(
    (_, tr) => {
      const cells = $(tr)
        .find('td')
        .map((__, td) => squish($(td).text()))
        .get()
        .filter(Boolean)

      const [day, value] = cells
      if (day && value) hours[day.toLowerCase()] = value
    },
  )

  return Object.keys(hours).length > 0 ? hours : null
}

export function parseDetail(html: string, pageUrl?: string): MapsPlaceDetail {
  const $ = cheerio.load(html)

  const name = squish($('h1').first().text())
  const category = squish($('button[jsaction*="category"]').first().text()) || null

  const address = valueAfterLabel(
    $('button[data-item-id="address"]').first().attr('aria-label'),
    'Endereço',
  )
  const plusCode = valueAfterLabel(
    $('button[data-item-id="oloc"]').first().attr('aria-label'),
    'Plus Code',
  )
  const phoneRaw = valueAfterLabel(
    $('button[data-item-id^="phone:tel:"]').first().attr('aria-label'),
    'Telefone',
  )

  // O href tem a URL real com esquema e caminho. O aria-label so tem o dominio
  // ("Website: petz.com.br"), que perderia o caminho da loja especifica.
  const website = $('a[data-item-id="authority"]').first().attr('href')?.trim() || null

  // A coordenada nao esta no HTML da ficha -- ela vive na URL. O !3d/!4d do link do
  // card e o mais preciso; o centro do mapa (`/@lat,lng`) e o fallback.
  const ref = pageUrl ? parsePlaceRef(pageUrl) : null
  const center = pageUrl ? parseMapCenter(pageUrl) : null

  return {
    placeFtid: ref?.ftid ?? null,
    name,
    category,
    rating: parseRating($),
    reviewsCount: parseReviewsCount($),
    address,
    phoneRaw,
    website,
    plusCode,
    hours: parseHours($),
    lat: ref?.lat ?? center?.lat ?? null,
    lng: ref?.lng ?? center?.lng ?? null,
  }
}
