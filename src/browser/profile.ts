import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import type { BrowserContext } from 'playwright'
import { loadEnv } from '../config/env.js'
import { UsageError } from '../errors.js'

/**
 * Sessoes de navegador persistidas -- e isto que torna a Etapa 1 gratuita.
 *
 * Em vez de pagar por APIs (Places, Instagram Graph, WhatsApp Cloud), o usuario
 * loga UMA VEZ nas contas dele num navegador visivel (`scout login <alvo>`) e o
 * Playwright guarda os cookies num diretorio de perfil. Os runs seguintes rodam
 * headless reaproveitando a sessao.
 *
 * Consequencia importante: `data/profiles/` contem as credenciais de sessao do
 * usuario. Esta no .gitignore, e nao deve sair da maquina dele.
 *
 * Um perfil por alvo, nunca um compartilhado: o Chromium trava o diretorio de
 * perfil enquanto usa, entao um perfil unico impediria rodar `social` e `wa:check`
 * ao mesmo tempo, e um logout no Google derrubaria a sessao do WhatsApp junto.
 */

export const PROFILE_TARGETS = ['maps', 'whatsapp', 'instagram', 'facebook'] as const
export type ProfileTarget = (typeof PROFILE_TARGETS)[number]

export function isProfileTarget(value: string): value is ProfileTarget {
  return (PROFILE_TARGETS as readonly string[]).includes(value)
}

export function assertProfileTarget(value: string | undefined): ProfileTarget {
  if (!value || !isProfileTarget(value)) {
    throw new UsageError(
      `Alvo invalido: ${value ?? '(nenhum)'}.`,
      `Alvos validos: ${PROFILE_TARGETS.join(', ')}.`,
    )
  }
  return value
}

export function profileDir(target: ProfileTarget): string {
  return path.resolve(loadEnv().SCOUT_PROFILE_DIR, target)
}

export type ProfileInfo = { target: ProfileTarget; dir: string; exists: boolean }

/** Um perfil "existe" quando o Chromium ja gravou estado nele. */
export async function listProfiles(): Promise<ProfileInfo[]> {
  return Promise.all(
    PROFILE_TARGETS.map(async (target) => {
      const dir = profileDir(target)
      let exists = false
      try {
        const s = await stat(dir)
        exists = s.isDirectory() && (await readdir(dir)).length > 0
      } catch {
        exists = false
      }
      return { target, dir, exists }
    }),
  )
}

export type LaunchOptions = {
  /** Sobrescreve SCOUT_HEADLESS. O comando `login` sempre passa false. */
  headless?: boolean
}

export async function launchProfile(
  target: ProfileTarget,
  options: LaunchOptions = {},
): Promise<BrowserContext> {
  const env = loadEnv()
  const dir = profileDir(target)
  await mkdir(dir, { recursive: true })

  return chromium.launchPersistentContext(dir, {
    headless: options.headless ?? env.SCOUT_HEADLESS,
    // pt-BR + fuso de Brasilia: o Google Maps devolve horario de funcionamento e
    // rotulos ("Aberto agora", "Nenhuma avaliacao") no idioma da sessao, e os
    // parsers dependem desses rotulos. Mudar isso quebra parseDetail.
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    args: [
      // Remove o navigator.webdriver que delata automacao. Nao e invisibilidade
      // -- e so nao entregar o jogo no primeiro byte.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })
}
