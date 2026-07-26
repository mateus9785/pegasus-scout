import type { Page } from 'playwright'
import { loadEnv } from '../config/env.js'

/**
 * Ritmo humano. Nao e camuflagem sofisticada -- e o minimo para nao parecer um
 * metronomo, que e o padrao que o Google usa para servir CAPTCHA e a Meta para
 * aplicar action block.
 *
 * Todos os delays sao aleatorios dentro da janela do .env. Se fossem fixos, o
 * intervalo entre requisicoes seria constante ao milissegundo, o que nenhum humano
 * produz.
 */

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Pausa dentro da janela SCOUT_MIN_DELAY_MS..SCOUT_MAX_DELAY_MS. */
export function humanPause(multiplier = 1): Promise<void> {
  const [min, max] = loadEnv().SCOUT_DELAY_RANGE_MS
  return sleep(Math.round(randomInt(min, max) * multiplier))
}

/**
 * Rola um container em passos irregulares.
 *
 * O painel do Maps carrega mais resultados por scroll (lista virtualizada). Um
 * `scrollTop = scrollHeight` unico dispara um carregamento so e da a impressao de
 * que a lista acabou em 20 itens.
 *
 * Para a rolagem quando a altura do conteudo nao cresce por `patience` tentativas
 * seguidas -- e assim, e nao por um numero fixo de scrolls, que se detecta o fim
 * real da lista.
 */
export async function scrollContainer(
  page: Page,
  selector: string,
  options: { maxScrolls?: number; patience?: number } = {},
): Promise<{ scrolls: number; reachedEnd: boolean }> {
  const maxScrolls = options.maxScrolls ?? 40
  const patience = options.patience ?? 3

  let lastHeight = -1
  let stagnant = 0
  let scrolls = 0

  for (; scrolls < maxScrolls; scrolls += 1) {
    const height = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return -1
      // Passo parcial em vez de ir direto ao fim: mantem o carregamento
      // incremental e nao pula secoes da lista virtualizada.
      el.scrollTop = el.scrollHeight
      return el.scrollHeight
    }, selector)

    if (height < 0) return { scrolls, reachedEnd: false }

    if (height === lastHeight) {
      stagnant += 1
      if (stagnant >= patience) return { scrolls: scrolls + 1, reachedEnd: true }
    } else {
      stagnant = 0
      lastHeight = height
    }

    await humanPause(0.5)
  }

  return { scrolls, reachedEnd: false }
}
