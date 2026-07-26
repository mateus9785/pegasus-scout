import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { MapsFeedItem } from '../types/domain.js'
import { squish } from '../utils/text.js'
import { extractBrazilPhones } from '../utils/phone.js'
import { parsePlaceRef } from './mapsUrl.js'

/**
 * Parser do painel lateral de resultados. Funcao pura sobre HTML -- testada contra
 * tests/fixtures/maps/feed.html, capturado do Maps de verdade.
 *
 * Estrategia deliberada: ancorar no que e semantico e ignorar classe gerada.
 *
 *   - identidade (ftid, coordenada) vem do href, que e um contrato do proprio
 *     Google e o dado mais estavel da pagina inteira
 *   - nome vem do aria-label da ancora
 *   - nota vem do aria-label "4,5 estrelas"
 *   - categoria, endereco e telefone vem do TEXTO do card
 *
 * Parsear texto parece fragil e e o contrario: `div.W4Efsd` muda a cada deploy do
 * Google, mas o layout visivel ("Pet Shop · Endereco" numa linha, "Aberto · Fecha
 * 20:00 · (61) 98126-5889" na outra) e o que o usuario final le e quase nao muda.
 */

const STATUS_KEYWORDS = /\b(aberto|fechado|abre|fecha|24\s*horas|encerrado|temporariamente)\b/i

/**
 * O tipo de uma selecao do cheerio, derivado da propria API.
 *
 * O cheerio 1.x nao exporta o tipo do no (`Element` vem de `domhandler`, uma
 * dependencia transitiva). Derivar de `ReturnType<CheerioAPI>` da o mesmo tipo sem
 * importar pacote que nao esta no package.json.
 */
type Selection = ReturnType<CheerioAPI>

/** Segmentos nao vazios de uma linha separada por `·`. */
function segments(line: string): string[] {
  return line.split('·').map(squish).filter(Boolean)
}

function longest(lines: string[]): string | null {
  return lines.reduce<string | null>((best, l) => (best && best.length >= l.length ? best : l), null)
}

/**
 * As duas linhas de informacao do card: "<categoria> · <endereco>" e
 * "<status> · <fecha as> · <telefone>".
 *
 * O caminho ingenuo -- pegar o texto mais curto que contem `·` -- nao funciona, e a
 * razao e sutil: o Maps renderiza cada separador como um span-folha proprio, entao
 * o HTML contem elementos cujo texto e literalmente "·" e fragmentos como
 * "· Fecha 00:00". O mais curto e sempre um desses, nunca a linha.
 *
 * Por isso o filtro e por ESTRUTURA e nao por tamanho:
 *
 *  - a linha precisa ter 2+ segmentos nao vazios (descarta "·" e "· Fecha 00:00")
 *  - nao pode conter o nome do estabelecimento (descarta o container do card todo)
 *  - entre as que sobram, a mais longa sem palavra de status e a de categoria, e a
 *    mais longa com palavra de status e a de horario -- excluindo as que contem a
 *    linha de categoria dentro de si, que sao a concatenacao das duas.
 */
function infoAndStatusLines(
  $: CheerioAPI,
  card: Selection,
  name: string,
): { infoLine: string | null; statusLine: string | null } {
  const seen = new Set<string>()
  card.find('*').each((_, el) => {
    const text = squish($(el).text())
    if (text.includes('·')) seen.add(text)
  })

  const candidates = [...seen].filter((l) => segments(l).length >= 2 && !l.includes(name))

  const infoLine = longest(candidates.filter((l) => !STATUS_KEYWORDS.test(l)))
  const statusLine = longest(
    candidates.filter((l) => STATUS_KEYWORDS.test(l) && (!infoLine || !l.includes(infoLine))),
  )

  return { infoLine, statusLine }
}

function parseRating(text: string | undefined): number | null {
  if (!text) return null
  // "4,5 estrelas" -> 4.5. Virgula decimal, sempre: a sessao e pt-BR.
  const match = text.match(/(\d+[,.]\d+|\d+)/)
  if (!match?.[1]) return null
  const value = Number(match[1].replace(',', '.'))
  return Number.isFinite(value) && value > 0 && value <= 5 ? value : null
}

/**
 * Contagem de avaliacoes quando o layout a inclui -- `(1.234)` ao lado da nota.
 *
 * O padrao exige que os parenteses contenham SO digitos e pontos de milhar. Sem
 * isso, "(61) 3221-7386" seria lido como 61 avaliacoes, o que ja aconteceu no
 * primeiro esboco deste parser.
 */
function parseReviewsCount($: CheerioAPI, card: Selection): number | null {
  let found: number | null = null
  card.find('span').each((_, el) => {
    if (found !== null) return
    const text = squish($(el).text())
    const match = text.match(/^\((\d{1,3}(?:\.\d{3})*|\d+)\)$/)
    if (match?.[1]) found = Number(match[1].replace(/\./g, ''))
  })
  return found
}

export type ParsedFeedItem = MapsFeedItem & {
  /** Telefone como aparece no card. Normalizado depois, por parseBrazilPhone. */
  phoneRaw: string | null
  openStatus: string | null
  lat: number | null
  lng: number | null
}

export function parseFeed(html: string): ParsedFeedItem[] {
  const $ = cheerio.load(html)
  const items: ParsedFeedItem[] = []
  const seenHrefs = new Set<string>()

  $('a[href*="/maps/place/"]').each((index, anchor) => {
    const link = $(anchor)
    const href = link.attr('href')
    if (!href || seenHrefs.has(href)) return
    seenHrefs.add(href)

    const name = squish(link.attr('aria-label') ?? '')
    if (name === '') return

    // O card e o pai da ancora: `div.Nv2PK > a.hfpxzc + <resto do card>`.
    const card = link.parent()
    const ref = parsePlaceRef(href)
    const { infoLine, statusLine } = infoAndStatusLines($, card, name)

    let category: string | null = null
    let addressHint: string | null = null
    if (infoLine) {
      // "Pet Shop ·  · Comercio Residencial Norte, 502 SHCN" -- o segmento do meio
      // vem vazio (e onde ficaria a faixa de preco), e `segments` ja o descarta.
      const parts = segments(infoLine)
      category = parts[0] ?? null
      addressHint = parts.length > 1 ? (parts.at(-1) ?? null) : null
    }

    const phones = extractBrazilPhones(statusLine ?? squish(card.text()))

    items.push({
      placeFtid: ref.ftid,
      name,
      category,
      addressHint,
      rating: parseRating(card.find('[aria-label*="estrela"]').attr('aria-label')),
      reviewsCount: parseReviewsCount($, card),
      mapsUrl: href,
      position: index,
      phoneRaw: phones[0] ? phones[0].e164 : null,
      openStatus: statusLine ? (segments(statusLine)[0] ?? null) : null,
      lat: ref.lat,
      lng: ref.lng,
    })
  })

  return items
}
