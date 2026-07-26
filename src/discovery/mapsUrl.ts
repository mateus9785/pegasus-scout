import type { LatLng } from '../utils/geo.js'

/**
 * URLs do Google Maps.
 *
 * `hl=pt-BR` e `gl=BR` sao obrigatorios, nao cosmeticos: os parsers dependem dos
 * rotulos em portugues ("Telefone:", "Fechado", "aberto 24 horas"). Se a sessao
 * cair para ingles, parseDetail para de achar campo.
 */

export function buildSearchUrl(query: string, center: LatLng, zoom: number): string {
  const at = `@${center.lat.toFixed(7)},${center.lng.toFixed(7)},${zoom}z`
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/${at}?hl=pt-BR&gl=BR`
}

/** Monta o texto da busca do jeito que um humano digitaria. */
export function buildQueryText(niche: string, city: string, state: string | null): string {
  const local = state ? `${city}, ${state}` : city
  return `${niche} em ${local}`
}

/**
 * Extrai identidade e coordenada de uma URL de lugar do Maps.
 *
 * O `href` de cada card carrega tudo no segmento `/data=`, num formato posicional
 * do proprio Google:
 *   !1s0x94ce...:0x8f2b...   -> ftid (identificador estavel do lugar)
 *   !3d-15.7942 !4d-47.8822  -> latitude e longitude
 *
 * Nao e documentado e pode mudar, e por isso cada campo e opcional e o parser
 * nunca lanca: sem ftid o dedupeKey cai para nome+coordenada, e sem coordenada cai
 * para o nome. Degradar e melhor que abortar a busca inteira.
 */
export type PlaceRef = {
  ftid: string | null
  lat: number | null
  lng: number | null
  nameFromUrl: string | null
}

export function parsePlaceRef(href: string): PlaceRef {
  const ftidMatch = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)
  const latMatch = href.match(/!3d(-?\d+\.\d+)/)
  const lngMatch = href.match(/!4d(-?\d+\.\d+)/)
  const nameMatch = href.match(/\/maps\/place\/([^/]+)/)

  let nameFromUrl: string | null = null
  if (nameMatch?.[1]) {
    try {
      nameFromUrl = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '))
    } catch {
      nameFromUrl = nameMatch[1].replace(/\+/g, ' ')
    }
  }

  return {
    ftid: ftidMatch?.[1]?.toLowerCase() ?? null,
    lat: latMatch?.[1] ? Number(latMatch[1]) : null,
    lng: lngMatch?.[1] ? Number(lngMatch[1]) : null,
    nameFromUrl,
  }
}

/**
 * Coordenada do centro do mapa, lida da URL da propria pagina (`/@lat,lng,zoom`).
 * Serve de fallback quando o href do card nao trouxe !3d/!4d.
 */
export function parseMapCenter(url: string): LatLng | null {
  const match = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (!match?.[1] || !match[2]) return null
  return { lat: Number(match[1]), lng: Number(match[2]) }
}
