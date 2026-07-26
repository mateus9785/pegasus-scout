import 'dotenv/config'
import { z } from 'zod'
import { ConfigError } from '../errors.js'

/**
 * Validacao de ambiente fail-fast. O chatbot_7m le `process.env.X || default`
 * espalhado pelos modulos, e o efeito colateral disso e um bot que sobe "com
 * sucesso" e so quebra na primeira mensagem do cliente. Aqui todo o ambiente e
 * validado uma vez, no comeco, e o erro diz exatamente qual variavel falta.
 */

/** Aceita "true"/"1"/"yes" (e os negativos) como booleano. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback
      return ['true', '1', 'yes', 'y', 'on'].includes(v.trim().toLowerCase())
    })

const intish = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max))

const schema = z.object({
  DB_HOST: z.string().min(1, 'host do MySQL'),
  DB_PORT: intish(3306, 1, 65535),
  DB_USER: z.string().min(1, 'usuario do MySQL'),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1, 'banco do MySQL'),
  DB_NAME_TEST: z.string().min(1).default('artificialcode_test'),

  // Usadas SO pelo globalSetup dos testes de integracao, que precisa de CREATE
  // DATABASE -- privilegio que o usuario da aplicacao nao tem no docker-compose
  // (o MYSQL_USER recebe permissao apenas sobre MYSQL_DATABASE). Os defaults
  // batem com artificialstudio/docker-compose.yml.
  DB_ADMIN_USER: z.string().min(1).default('root'),
  DB_ADMIN_PASSWORD: z.string().default('artificialcode-root'),

  SCOUT_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  SCOUT_LOG_JSON: boolish(false),

  SCOUT_PROFILE_DIR: z.string().min(1).default('./data/profiles'),
  SCOUT_HEADLESS: boolish(true),
  SCOUT_MIN_DELAY_MS: intish(1200, 0, 60_000),
  SCOUT_MAX_DELAY_MS: intish(3500, 0, 120_000),

  SCOUT_SOCIAL_DAILY_LIMIT: intish(40, 0, 5_000),
  SCOUT_WA_DAILY_LIMIT: intish(40, 0, 5_000),

  SCOUT_HTTP_TIMEOUT_MS: intish(10_000, 500, 120_000),
  SCOUT_HTTP_MAX_BYTES: intish(2_000_000, 10_000, 100_000_000),

  SCOUT_NOMINATIM_EMAIL: z.string().default(''),
})

export type Env = z.infer<typeof schema> & { readonly SCOUT_DELAY_RANGE_MS: readonly [number, number] }

let cached: Env | null = null

export function loadEnv(): Env {
  if (cached) return cached

  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
    throw new ConfigError(
      `Ambiente invalido:\n${lines.join('\n')}`,
      'Copie .env.example para .env e preencha as variaveis citadas acima.',
    )
  }

  const env = parsed.data

  // Um intervalo invertido nao seria pego pelo schema (cada campo e valido
  // isolado) e faria o randomizador de delay devolver NaN silenciosamente.
  if (env.SCOUT_MIN_DELAY_MS > env.SCOUT_MAX_DELAY_MS) {
    throw new ConfigError(
      `SCOUT_MIN_DELAY_MS (${env.SCOUT_MIN_DELAY_MS}) e maior que SCOUT_MAX_DELAY_MS (${env.SCOUT_MAX_DELAY_MS}).`,
      'Inverta os valores no .env.',
    )
  }

  cached = { ...env, SCOUT_DELAY_RANGE_MS: [env.SCOUT_MIN_DELAY_MS, env.SCOUT_MAX_DELAY_MS] as const }
  return cached
}

/** Usado pelos testes para forcar releitura depois de mexer em process.env. */
export function resetEnvCache(): void {
  cached = null
}
