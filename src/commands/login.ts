import { assertProfileTarget, launchProfile, profileDir } from '../browser/profile.js'
import type { ProfileTarget } from '../browser/profile.js'
import { getLogger } from '../logger/logger.js'
import { UsageError } from '../errors.js'

/**
 * Abre um navegador VISIVEL para o usuario logar na conta dele uma unica vez.
 *
 * E o mecanismo que torna a Etapa 1 gratuita: em vez de pagar Places API,
 * Instagram Graph API e WhatsApp Cloud API, o robo reaproveita as sessoes do
 * proprio usuario. Depois deste comando, os runs seguintes rodam headless.
 *
 * Nenhuma senha passa pelo codigo -- quem digita e o usuario, no navegador. O que
 * o projeto guarda e o diretorio de perfil do Chromium, que fica em data/ e esta
 * no .gitignore.
 *
 * O comando espera o usuario fechar a janela em vez de usar um timer: sao contas
 * diferentes, com 2FA, QR code, confirmacao por e-mail. Qualquer timeout que eu
 * escolhesse estaria errado para alguem.
 */

const START_URL: Record<ProfileTarget, string> = {
  maps: 'https://www.google.com/maps?hl=pt-BR&gl=BR',
  whatsapp: 'https://web.whatsapp.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
}

const INSTRUCTIONS: Record<ProfileTarget, string> = {
  maps: 'Aceite os cookies se aparecer o banner. Nao precisa fazer login em conta Google — o perfil serve so para guardar o consentimento e evitar CAPTCHA.',
  whatsapp: 'Escaneie o QR code com o seu WhatsApp (Aparelhos conectados > Conectar aparelho). O robo so LE perfis, nunca envia mensagem nesta etapa.',
  instagram: 'Faca login. Recomendacao seria: use uma conta secundaria, nao a principal — navegacao automatizada pode gerar bloqueio temporario de acoes.',
  facebook: 'Faca login. A pagina publica de cada empresa as vezes informa "normalmente responde em algumas horas", que e o sinal de lentidao mais direto que existe.',
}

export async function run(argv: string[]): Promise<void> {
  const log = getLogger()
  const target = assertProfileTarget(argv[0])

  if (argv.includes('--help')) {
    process.stdout.write('Uso: npm run scout -- login <maps|whatsapp|instagram|facebook>\n')
    return
  }

  const dir = profileDir(target)
  process.stdout.write(
    [
      '',
      `  Abrindo navegador para: ${target}`,
      `  Perfil salvo em: ${dir}`,
      '',
      `  ${INSTRUCTIONS[target]}`,
      '',
      '  Quando terminar, FECHE A JANELA do navegador para salvar a sessao.',
      '',
    ].join('\n'),
  )

  const context = await launchProfile(target, { headless: false })
  const page = context.pages()[0] ?? (await context.newPage())

  try {
    await page.goto(START_URL[target], { waitUntil: 'domcontentloaded', timeout: 60_000 })
  } catch (err) {
    log.warn({ err: String(err) }, 'a pagina inicial demorou, mas o navegador continua aberto')
  }

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve())
    // Fechar a ultima aba, sem fechar a janela, tambem deve encerrar a espera --
    // senao o comando fica pendurado para sempre.
    context.on('page', (p) => {
      p.on('close', () => {
        if (context.pages().length === 0) resolve()
      })
    })
  })

  // O contexto persistente grava cookies no fechamento. Sem este close, uma
  // sessao recem-criada pode nao ser gravada.
  await context.close().catch(() => undefined)

  process.stdout.write(`\n  ✔ Sessao de "${target}" salva.\n\n`)
  log.info({ target, dir }, 'sessao salva')
}

export function describeTargets(): string {
  return Object.keys(START_URL).join(', ')
}

/** Guarda contra alguem chamar `run` sem alvo em codigo. */
export function assertHasTarget(argv: string[]): void {
  if (argv.length === 0) {
    throw new UsageError('Falta o alvo do login.', `Alvos: ${describeTargets()}.`)
  }
}
