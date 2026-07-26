import { loadEnv } from '../config/env.js'
import { assertConnection, closePools, getPool } from '../db/pool.js'
import { findMissingTables, REQUIRED_TABLES } from '../db/assertSchema.js'
import { listProfiles } from '../browser/profile.js'
import type { RowDataPacket } from 'mysql2/promise'

/**
 * Diagnostico de ambiente. Existe porque as tres primeiras coisas que quebram num
 * projeto assim sao sempre as mesmas -- .env incompleto, docker parado, migracao
 * nao aplicada -- e cada uma delas, sem diagnostico, aparece como um erro
 * diferente e obscuro no meio de outro comando.
 *
 * Coleta TODOS os problemas antes de decidir o codigo de saida, em vez de abortar
 * no primeiro: se faltam duas coisas, o usuario deve ver as duas de uma vez.
 */

type Check = { label: string; ok: boolean; detail: string; hint?: string }

export async function run(_argv: string[]): Promise<void> {
  const checks: Check[] = []

  const env = loadEnv()
  checks.push({
    label: 'Ambiente (.env)',
    ok: true,
    detail: `log=${env.SCOUT_LOG_LEVEL} headless=${env.SCOUT_HEADLESS} delay=${env.SCOUT_MIN_DELAY_MS}-${env.SCOUT_MAX_DELAY_MS}ms`,
  })

  const nominatim = env.SCOUT_NOMINATIM_EMAIL.trim()
  checks.push({
    label: 'Contato do Nominatim',
    ok: nominatim !== '',
    detail: nominatim || '(vazio)',
    ...(nominatim === ''
      ? {
          hint: 'Preencha SCOUT_NOMINATIM_EMAIL no .env. A politica de uso do OpenStreetMap exige um User-Agent com contato real, e sem isso eles podem bloquear seu IP.',
        }
      : {}),
  })

  let dbOk = false
  try {
    await assertConnection()
    dbOk = true
    checks.push({
      label: 'Conexao MySQL',
      ok: true,
      detail: `${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
    })
  } catch (err) {
    const e = err as { message: string; hint?: string }
    const check: Check = { label: 'Conexao MySQL', ok: false, detail: e.message }
    if (e.hint) check.hint = e.hint
    checks.push(check)
  }

  if (dbOk) {
    const missing = await findMissingTables()
    const found = REQUIRED_TABLES.length - missing.length
    const check: Check = {
      label: 'Tabelas scout_*',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${found}/${REQUIRED_TABLES.length} presentes`
          : `faltam: ${missing.join(', ')}`,
    }
    if (missing.length > 0) {
      check.hint = 'Rode `npm run migrate` dentro de artificialstudio/backend/.'
    }
    checks.push(check)

    if (missing.length === 0) {
      const [rows] = await getPool().query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM scout_searches)  AS searches,
           (SELECT COUNT(*) FROM scout_prospects) AS prospects,
           (SELECT COUNT(*) FROM scout_prospects WHERE enrichment_status = 'done') AS enriched,
           (SELECT COUNT(*) FROM scout_blocklist) AS blocked`,
      )
      const r = rows[0]
      checks.push({
        label: 'Dados atuais',
        ok: true,
        detail: `${r?.['searches'] ?? 0} buscas, ${r?.['prospects'] ?? 0} empresas (${r?.['enriched'] ?? 0} enriquecidas), ${r?.['blocked'] ?? 0} na blocklist`,
      })
    }
  }

  const profiles = await listProfiles()
  const loggedIn = profiles.filter((p) => p.exists).map((p) => p.target)
  checks.push({
    label: 'Sessoes de navegador',
    ok: true, // ausencia de sessao nao e erro: e o estado inicial
    detail: loggedIn.length > 0 ? loggedIn.join(', ') : 'nenhuma ainda',
    ...(loggedIn.length === 0
      ? { hint: 'Rode `npm run scout -- login maps` quando chegar a hora de buscar. O navegador abre visivel para voce logar uma vez.' }
      : {}),
  })

  render(checks)

  await closePools()

  const failed = checks.filter((c) => !c.ok)
  if (failed.length > 0) {
    process.stderr.write(`${failed.length} verificacao(oes) falhou(aram).\n`)
    process.exitCode = 1
  }
}

function render(checks: Check[]): void {
  const width = Math.max(...checks.map((c) => c.label.length))
  const out: string[] = ['']
  for (const c of checks) {
    out.push(`  ${c.ok ? '✔' : '✖'} ${c.label.padEnd(width)}  ${c.detail}`)
    if (!c.ok && c.hint) out.push(`      → ${c.hint}`)
    if (c.ok && c.hint) out.push(`      ⓘ ${c.hint}`)
  }
  out.push('')
  process.stdout.write(out.join('\n'))
}
