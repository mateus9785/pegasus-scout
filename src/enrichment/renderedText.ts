import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { loadEnv } from '../config/env.js'
import { childLogger } from '../logger/logger.js'
import { squish } from '../utils/text.js'

const log = childLogger({ mod: 'render' })

/**
 * Extrai o texto visivel de uma pagina EXECUTANDO o JavaScript dela.
 *
 * Existe por causa de um resultado concreto da primeira varredura: a analise da
 * loja do Petz voltou com todo campo "indefinido" e confianca 0,05. O modelo nao
 * errou -- o HTML servido por aquele site tem quase nenhum texto, porque o conteudo
 * e montado no navegador. O fetch HTTP cru recebia um casco vazio.
 *
 * Isso NAO substitui o fetch cru, complementa. Os detectores deterministicos
 * dependem do HTML original (a assinatura do widget de chat esta no `src` do script
 * e no snippet inline, ambos presentes antes de qualquer JS rodar). O que se ganha
 * aqui e so o texto para a analise interpretativa.
 *
 * Por isso e um FALLBACK e nao o caminho padrao: abrir um navegador por empresa
 * custa segundos e memoria, e a maioria dos sites de comercio local e HTML servido
 * pronto. So paga esse custo quem precisa.
 */

/** Abaixo disto, o texto nao sustenta analise nenhuma e vale tentar renderizar. */
export const MIN_TEXT_CHARS = 600

let browser: Browser | null = null

/**
 * Um navegador para todo o lote, nao um por pagina.
 *
 * Sem contexto persistido de proposito: aqui nao ha sessao de conta nenhuma
 * envolvida, e um contexto limpo por pagina evita que cookie de um site vaze para
 * a analise do proximo.
 */
async function getBrowser(): Promise<Browser> {
  browser ??= await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  return browser
}

export async function closeRenderer(): Promise<void> {
  const open = browser
  browser = null
  await open?.close()
}

export async function renderPageText(url: string): Promise<string> {
  const env = loadEnv()
  const context = await (
    await getBrowser()
  ).newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    userAgent: `Mozilla/5.0 (compatible; pegasus-scout/0.1; +mailto:${env.SCOUT_NOMINATIM_EMAIL || 'sem-contato'})`,
  })

  try {
    const page = await context.newPage()
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      // Imagem, fonte e video nao viram texto. Bloquear corta o tempo por site
      // sem perder nada da analise.
      if (type === 'image' || type === 'font' || type === 'media') return route.abort()
      return route.continue()
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // `networkidle` trava em site com polling ou chat aberto -- exatamente o tipo
    // de site que interessa aqui. Um tempo curto e fixo e mais previsivel.
    await page.waitForTimeout(2_500)

    const text = await page.evaluate(() => {
      document.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove())
      return document.body?.innerText ?? ''
    })

    const limpo = squish(text)
    log.debug({ url, chars: limpo.length }, 'texto renderizado')
    return limpo
  } finally {
    await context.close()
  }
}
