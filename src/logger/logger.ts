import pino from 'pino'
import { loadEnv } from '../config/env.js'

/**
 * O chatbot_7m usa `console.log` com prefixo de canal. Funciona para um bot com
 * um usuario por vez, mas aqui um `scout discover` percorre centenas de empresas
 * e a gente precisa filtrar por nivel e correlacionar por prospect. Por isso pino.
 *
 * `redact` existe porque os logs registram telefone e nome de empresa. Telefone
 * completo em log de arquivo e dado pessoal de contato vazando de graca — a
 * mascara mantem o final, que e o suficiente para depurar.
 */

function buildLogger(): pino.Logger {
  const env = loadEnv()

  const options: pino.LoggerOptions = {
    level: env.SCOUT_LOG_LEVEL,
    base: undefined, // sem pid/hostname: e um CLI local, nao um servico
    redact: {
      paths: ['phone', 'phoneE164', 'whatsappPhoneE164', '*.phone', '*.phoneE164'],
      censor: (value) => (typeof value === 'string' ? maskPhone(value) : '[oculto]'),
    },
  }

  if (env.SCOUT_LOG_JSON) return pino(options)

  return pino({
    ...options,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  })
}

/** +5561999998888 -> +55619****8888 */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) return '*'.repeat(phone.length)
  return `${phone.slice(0, 6)}${'*'.repeat(phone.length - 10)}${phone.slice(-4)}`
}

let cached: pino.Logger | null = null

export function getLogger(): pino.Logger {
  cached ??= buildLogger()
  return cached
}

/** Logger filho com contexto fixo, ex.: `childLogger({ stage: 'discovery' })`. */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings)
}
