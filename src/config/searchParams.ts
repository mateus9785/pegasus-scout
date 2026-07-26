import { parseArgs } from 'node:util'
import { UsageError } from '../errors.js'
import type { LatLng } from '../utils/geo.js'

/**
 * Argumentos de linha de comando.
 *
 * Usa `parseArgs` do proprio Node em vez de commander/yargs: sao ~10 flags, o
 * modulo e nativo desde a 18 e nao adiciona dependencia a um projeto que ja carrega
 * um navegador inteiro.
 *
 * Nada de nicho, cidade ou raio esta hardcoded em nenhum lugar do codigo -- foi
 * requisito explicito. O que existe aqui e default de conveniencia por comando,
 * sempre sobrescritivel.
 */

export type SearchParams = {
  niche: string
  city: string
  state: string | null
  radiusKm: number
  tileKm: number
  maxResults: number
  /** Quando dado, evita a chamada ao geocoder. */
  center: LatLng | null
  withDetails: boolean
}

const OPTIONS = {
  niche: { type: 'string' },
  city: { type: 'string' },
  state: { type: 'string' },
  'radius-km': { type: 'string' },
  'tile-km': { type: 'string' },
  max: { type: 'string' },
  lat: { type: 'string' },
  lng: { type: 'string' },
  'no-details': { type: 'boolean' },
  limit: { type: 'string' },
  'retry-failed': { type: 'boolean' },
  'with-llm': { type: 'boolean' },
  'force-llm': { type: 'boolean' },
  top: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

export type RawArgs = {
  values: Partial<Record<keyof typeof OPTIONS, string | boolean>>
  positionals: string[]
}

export function parseRawArgs(argv: string[]): RawArgs {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    })
    return { values, positionals }
  } catch (err) {
    throw new UsageError(
      `Argumento invalido: ${(err as Error).message}`,
      'Rode o comando com --help para ver as opcoes aceitas.',
    )
  }
}

function numberOption(
  values: RawArgs['values'],
  key: keyof typeof OPTIONS,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = values[key]
  if (raw === undefined || typeof raw === 'boolean') return fallback

  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${key} precisa ser um numero. Recebi "${raw}".`)
  }
  if (value < bounds.min || value > bounds.max) {
    throw new UsageError(
      `--${key} precisa estar entre ${bounds.min} e ${bounds.max}. Recebi ${value}.`,
    )
  }
  return value
}

function stringOption(values: RawArgs['values'], key: keyof typeof OPTIONS): string | null {
  const raw = values[key]
  if (raw === undefined || typeof raw === 'boolean') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

export function parseSearchArgs(
  argv: string[],
  defaults: { defaultNiche?: string; defaultCity?: string } = {},
): SearchParams {
  const { values } = parseRawArgs(argv)

  const niche = stringOption(values, 'niche') ?? defaults.defaultNiche
  const city = stringOption(values, 'city') ?? defaults.defaultCity

  if (!niche || !city) {
    throw new UsageError(
      'Faltam --niche e/ou --city.',
      'Exemplo: npm run scout -- discover --niche "pet shop" --city "Brasilia" --state DF --radius-km 5 --max 40',
    )
  }

  const state = stringOption(values, 'state')
  if (state !== null && !/^[A-Za-z]{2}$/.test(state)) {
    throw new UsageError(`--state precisa ser a sigla de 2 letras da UF. Recebi "${state}".`)
  }

  const lat = stringOption(values, 'lat')
  const lng = stringOption(values, 'lng')
  if ((lat === null) !== (lng === null)) {
    throw new UsageError(
      '--lat e --lng andam juntos.',
      'Passe os dois para pular o geocoding, ou nenhum para o robo resolver a cidade sozinho.',
    )
  }

  return {
    niche,
    city,
    state: state ? state.toUpperCase() : null,
    radiusKm: numberOption(values, 'radius-km', 5, { min: 0.2, max: 100 }),
    tileKm: numberOption(values, 'tile-km', 2, { min: 0.2, max: 20 }),
    maxResults: numberOption(values, 'max', 60, { min: 1, max: 5_000 }),
    center: lat && lng ? { lat: Number(lat), lng: Number(lng) } : null,
    withDetails: values['no-details'] !== true,
  }
}

export type BatchParams = {
  limit: number
  retryFailed: boolean
  withLlm: boolean
  forceLlm: boolean
}

export function parseBatchArgs(argv: string[], defaultLimit = 50): BatchParams {
  const { values } = parseRawArgs(argv)
  return {
    limit: numberOption(values, 'limit', defaultLimit, { min: 1, max: 5_000 }),
    retryFailed: values['retry-failed'] === true,
    // --force-llm implica --with-llm: pedir para regerar o brief sem ligar a
    // analise nao faria nada, e o silencio seria confuso.
    withLlm: values['with-llm'] === true || values['force-llm'] === true,
    forceLlm: values['force-llm'] === true,
  }
}

export function wantsHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}
