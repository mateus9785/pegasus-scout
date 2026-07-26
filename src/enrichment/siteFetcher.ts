import { fetchPage, getRobots, isAllowedByRobots } from './httpClient.js'
import type { FetchedPage } from './httpClient.js'
import { analyzeSite } from './detectors.js'
import type { SiteAnalysis } from './detectors.js'
import { absolutize, extractDomain, parseUrlSafe } from '../utils/url.js'
import { normalizeText } from '../utils/text.js'
import { humanPause } from '../browser/humanize.js'
import { childLogger } from '../logger/logger.js'
import { FetchError } from '../errors.js'
import * as cheerio from 'cheerio'

const log = childLogger({ mod: 'siteFetcher' })

/**
 * Busca a home e, quando existirem, as paginas de contato e sobre.
 *
 * Por que mais de uma pagina: o telefone de WhatsApp e o e-mail quase nunca estao na
 * home -- estao em /contato. E a home de loja virtual moderna e um carrossel sem
 * texto, enquanto /sobre diz o que a empresa faz, que e o insumo da analise por LLM.
 *
 * Por que no maximo tres: cada pagina e uma requisicao ao servidor de um terceiro.
 * Tres cobre o essencial sem parecer varredura.
 */

const MAX_EXTRA_PAGES = 2

/** Rotulos de link, em texto normalizado, que apontam para as paginas que interessam. */
const WANTED_LINK_LABELS = [
  'contato',
  'fale conosco',
  'atendimento',
  'sobre',
  'sobre nos',
  'quem somos',
  'a empresa',
]

export type SiteSnapshot = {
  /** Analise combinada de todas as paginas buscadas. */
  analysis: SiteAnalysis
  pages: Array<{ url: string; status: number; bytes: number }>
  /** Paginas que o robots.txt pediu para nao acessar. */
  blockedByRobots: string[]
}

export async function fetchSite(websiteUrl: string): Promise<SiteSnapshot> {
  const url = parseUrlSafe(websiteUrl)
  if (!url) throw new FetchError(websiteUrl, 'URL do site nao e parseavel')

  const origin = url.origin
  const robots = await getRobots(origin)
  const blockedByRobots: string[] = []

  if (!isAllowedByRobots(robots, url.pathname)) {
    blockedByRobots.push(url.pathname)
    throw new FetchError(websiteUrl, `robots.txt de ${origin} nao permite ${url.pathname}`)
  }

  const home = await fetchPage(url.toString())
  const fetched: FetchedPage[] = [home]

  for (const extraUrl of discoverInternalPages(home)) {
    if (fetched.length > MAX_EXTRA_PAGES) break

    const parsed = parseUrlSafe(extraUrl)
    if (!parsed) continue
    if (!isAllowedByRobots(robots, parsed.pathname)) {
      blockedByRobots.push(parsed.pathname)
      continue
    }

    await humanPause(0.3)
    try {
      const page = await fetchPage(extraUrl)
      if (page.status < 400) fetched.push(page)
    } catch (err) {
      // Pagina interna que nao abre nao invalida a analise da home.
      log.debug({ extraUrl, err: String(err) }, 'pagina interna ignorada')
    }
  }

  return {
    analysis: mergeAnalyses(fetched),
    pages: fetched.map((p) => ({ url: p.finalUrl, status: p.status, bytes: p.html.length })),
    blockedByRobots,
  }
}

/** Links internos de contato/sobre, na ordem em que aparecem, sem repetir. */
function discoverInternalPages(home: FetchedPage): string[] {
  const $ = cheerio.load(home.html)
  const homeDomain = extractDomain(home.finalUrl)
  const found = new Set<string>()

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return

    const label = normalizeText($(el).text())
    const absolute = absolutize(href, home.finalUrl)
    if (!absolute) return

    // Fora do dominio nao interessa, e evita seguir link para rede social.
    if (extractDomain(absolute) !== homeDomain) return

    const path = normalizeText(new URL(absolute).pathname)
    const matchesLabel = WANTED_LINK_LABELS.some((w) => label === w || label.startsWith(w))
    const matchesPath = WANTED_LINK_LABELS.some((w) => path.includes(w.replace(/\s+/g, '-')))

    if (matchesLabel || matchesPath) found.add(absolute.split('#')[0]!)
  })

  return [...found]
}

/**
 * Combina a analise das paginas numa so.
 *
 * A regra e "primeira ocorrencia ganha, e a home vem primeiro" para plataforma e
 * widget, porque esses sao propriedades do site inteiro. Para telefone, e-mail e
 * WhatsApp e o contrario: acumula tudo, porque estao espalhados entre home e
 * /contato e cada um pode trazer um numero diferente.
 */
const uniq = (values: string[]): string[] => [...new Set(values)]

function mergeAnalyses(pages: FetchedPage[]): SiteAnalysis {
  const analyses = pages.map((p) => analyzeSite(p.html, p.finalUrl))
  const first = analyses[0]
  if (!first) throw new Error('mergeAnalyses chamado sem paginas')

  return {
    chatWidget: analyses.find((a) => a.chatWidget)?.chatWidget ?? null,
    siteBuilder: analyses.find((a) => a.siteBuilder)?.siteBuilder ?? null,
    whatsappWidget: analyses.find((a) => a.whatsappWidget)?.whatsappWidget ?? null,
    ecommercePlatform: analyses.find((a) => a.ecommercePlatform)?.ecommercePlatform ?? null,
    paymentProviders: uniq(analyses.flatMap((a) => a.paymentProviders)),
    whatsappNumbers: uniq(analyses.flatMap((a) => a.whatsappNumbers)),
    phones: uniq(analyses.flatMap((a) => a.phones)),
    emails: uniq(analyses.flatMap((a) => a.emails)),
    instagramUrl: analyses.find((a) => a.instagramUrl)?.instagramUrl ?? null,
    facebookUrl: analyses.find((a) => a.facebookUrl)?.facebookUrl ?? null,
    title: first.title,
    metaDescription: first.metaDescription,
    // Texto de todas as paginas, separado, para a analise por LLM ter o contexto de
    // /sobre junto com o da home.
    text: analyses.map((a) => a.text).join('\n\n---\n\n'),
    signals: dedupeSignals(analyses.flatMap((a) => a.signals)),
  }
}

function dedupeSignals(signals: SiteAnalysis['signals']): SiteAnalysis['signals'] {
  const byKey = new Map<string, SiteAnalysis['signals'][number]>()
  for (const signal of signals) {
    const existing = byKey.get(signal.key)
    if (!existing || signal.confidence > existing.confidence) byKey.set(signal.key, signal)
  }
  return [...byKey.values()]
}
