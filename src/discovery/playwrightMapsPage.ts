import type { BrowserContext, Page } from 'playwright'
import type { MapsPage } from './mapsPage.js'
import type { LatLng } from '../utils/geo.js'
import { MAPS_SELECTORS } from './selectors.js'
import { buildSearchUrl } from './mapsUrl.js'
import { humanPause, scrollContainer } from '../browser/humanize.js'
import { launchProfile } from '../browser/profile.js'
import { SelectorError } from '../errors.js'
import { childLogger } from '../logger/logger.js'
import type { SelectorSpec } from './selectors.js'

const log = childLogger({ mod: 'mapsPage' })

/**
 * Resolve a cascata de candidatos de um seletor.
 *
 * Devolve o primeiro que existe na pagina. Para seletor `required`, nao achar nada
 * e SelectorError -- e o alarme de "o layout do Maps mudou", que precisa parar o
 * run em vez de silenciosamente gravar registros vazios.
 */
export async function resolveSelector(page: Page, spec: SelectorSpec): Promise<string | null> {
  for (const candidate of spec.candidates) {
    if ((await page.locator(candidate).count()) > 0) return candidate
  }
  if (spec.required) {
    throw new SelectorError(
      spec.key,
      `Nenhum seletor casou para "${spec.key}" (${spec.description}). Candidatos testados: ${spec.candidates.join(' | ')}.`,
      'O layout do Google Maps provavelmente mudou. Rode `npm run scout -- check:selectors` para o diagnostico completo e atualize src/discovery/selectors.ts.',
    )
  }
  return null
}

/**
 * Espera por QUALQUER candidato do seletor antes de resolver qual deles casou.
 *
 * Sem esta espera, `resolveSelector` roda logo depois do domcontentloaded e o Maps
 * ainda nao montou o painel via JS -- o que aparecia como SelectorError "o layout
 * mudou" quando na verdade o layout estava certo e a pagina so nao tinha carregado.
 * Diagnostico errado e pior que erro nenhum: manda voce mexer no arquivo de
 * seletores para consertar um problema de timing.
 *
 * A uniao por virgula funciona porque todos os candidatos sao CSS puro.
 */
async function waitForAnyCandidate(
  page: Page,
  spec: SelectorSpec,
  timeout: number,
): Promise<void> {
  try {
    await page
      .locator(spec.candidates.join(', '))
      .first()
      .waitFor({ state: 'attached', timeout })
  } catch {
    // Deixa resolveSelector decidir: para seletor `required` ele lanca o
    // SelectorError com o diagnostico completo, e para opcional devolve null.
  }
}

export class PlaywrightMapsPage implements MapsPage {
  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  static async open(options: { headless?: boolean } = {}): Promise<PlaywrightMapsPage> {
    const context = await launchProfile('maps', options)
    const page = context.pages()[0] ?? (await context.newPage())
    // Imagens e fontes sao 80% do peso de uma pagina do Maps e nao entram em
    // nenhum parser. Bloquear corta o tempo por tile e reduz a pegada da varredura.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      if (type === 'image' || type === 'font' || type === 'media') return route.abort()
      return route.continue()
    })
    return new PlaywrightMapsPage(context, page)
  }

  currentUrl(): string {
    return this.page.url()
  }

  async search(query: string, center: LatLng, zoom: number): Promise<void> {
    const url = buildSearchUrl(query, center, zoom)
    log.debug({ url }, 'abrindo busca')
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    await this.acceptConsentIfPresent()

    // O feed monta depois do JS. Sem esta espera, getFeedHtml devolveria o
    // esqueleto vazio e o parser reportaria "zero resultados" numa regiao cheia.
    await waitForAnyCandidate(this.page, MAPS_SELECTORS.feed, 30_000)
    const feed = await resolveSelector(this.page, MAPS_SELECTORS.feed)
    await this.page.locator(feed!).first().waitFor({ state: 'visible', timeout: 30_000 })

    // Os cards entram no feed depois do container. Esperar so pelo container
    // devolveria um feed vazio numa fracao dos runs.
    await waitForAnyCandidate(this.page, MAPS_SELECTORS.feedCardLink, 20_000)
    await humanPause()
  }

  private async acceptConsentIfPresent(): Promise<void> {
    // Janela curta: o banner, quando existe, aparece junto com a pagina. Esperar
    // 30s por ele atrasaria todo run em que ele nao existe -- o caso comum, ja que
    // o perfil e persistido e o consentimento fica salvo depois da primeira vez.
    await waitForAnyCandidate(this.page, MAPS_SELECTORS.consentAccept, 2_500)
    const selector = await resolveSelector(this.page, MAPS_SELECTORS.consentAccept)
    if (!selector) return

    log.info('aceitando consentimento de cookies (primeira visita deste perfil)')
    await humanPause(0.4)
    await this.page.locator(selector).first().click({ timeout: 10_000 }).catch(() => {
      // O banner pode desaparecer sozinho entre o count() e o click(). Nao e erro.
    })
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined)
  }

  async scrollFeed(options: { maxScrolls?: number } = {}): Promise<{ reachedEnd: boolean }> {
    const feed = await resolveSelector(this.page, MAPS_SELECTORS.feed)
    const result = await scrollContainer(this.page, feed!, options)
    log.debug(result, 'rolagem do feed concluida')
    return { reachedEnd: result.reachedEnd }
  }

  async getFeedHtml(): Promise<string> {
    const feed = await resolveSelector(this.page, MAPS_SELECTORS.feed)
    return this.page.locator(feed!).first().innerHTML()
  }

  async getPlaceHtml(placeUrl: string): Promise<string> {
    log.debug({ placeUrl }, 'abrindo ficha')
    await this.page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    await waitForAnyCandidate(this.page, MAPS_SELECTORS.detailPanel, 30_000)
    const panel = await resolveSelector(this.page, MAPS_SELECTORS.detailPanel)
    await this.page.locator(panel!).first().waitFor({ state: 'visible', timeout: 30_000 })

    // O nome chega antes do resto (telefone, site e horario entram por XHR). Sem
    // esperar por ele, a ficha vem pela metade de forma intermitente -- o pior
    // tipo de bug, porque parece funcionar na maioria das vezes.
    await waitForAnyCandidate(this.page, MAPS_SELECTORS.detailName, 20_000)
    const name = await resolveSelector(this.page, MAPS_SELECTORS.detailName)
    await this.page.locator(name!).first().waitFor({ state: 'visible', timeout: 20_000 })
    await humanPause(0.5)

    return this.page.locator(panel!).first().innerHTML()
  }

  async close(): Promise<void> {
    await this.context.close()
  }

  /** Exposto so para o comando check:selectors. */
  get rawPage(): Page {
    return this.page
  }
}
