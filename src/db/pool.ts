import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import { loadEnv } from '../config/env.js'
import { DatabaseError } from '../errors.js'

/**
 * Espelha artificialstudio/backend/src/db/pool.js de proposito: e o MESMO banco.
 * As unicas adicoes sao o parametro `database` (para os testes de integracao
 * apontarem para DB_NAME_TEST sem tocar nos dados de trabalho) e o wrapper de
 * erro de conexao, que traduz ECONNREFUSED em "suba o docker" em vez de deixar o
 * stack trace cru do mysql2 na cara do usuario.
 */

const pools = new Map<string, Pool>()

export function getPool(database?: string): Pool {
  const env = loadEnv()
  const dbName = database ?? env.DB_NAME

  let pool = pools.get(dbName)
  if (!pool) {
    pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
    })
    pools.set(dbName, pool)
  }
  return pool
}

/** Fecha todos os pools abertos. O CLI precisa disso para o processo terminar. */
export async function closePools(): Promise<void> {
  const open = [...pools.values()]
  pools.clear()
  await Promise.all(open.map((p) => p.end()))
}

/** Faz um SELECT 1 e traduz as falhas comuns em instrucao acionavel. */
export async function assertConnection(database?: string): Promise<void> {
  const env = loadEnv()
  const dbName = database ?? env.DB_NAME
  try {
    await getPool(dbName).query('SELECT 1')
  } catch (err) {
    const code = (err as { code?: string }).code
    const where = `${env.DB_HOST}:${env.DB_PORT}/${dbName}`

    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
      throw new DatabaseError(
        `Nao consegui conectar no MySQL em ${where}.`,
        'Suba o banco com `docker compose up -d` dentro de artificialstudio/ e confira DB_HOST/DB_PORT no .env.',
      )
    }
    if (code === 'ER_BAD_DB_ERROR') {
      throw new DatabaseError(
        `O banco "${dbName}" nao existe em ${env.DB_HOST}:${env.DB_PORT}.`,
        'Confira DB_NAME no .env. Se o container acabou de subir, o docker-compose cria o banco "artificialcode" automaticamente.',
      )
    }
    if (code === 'ER_ACCESS_DENIED_ERROR') {
      throw new DatabaseError(
        `Usuario ou senha recusados pelo MySQL em ${where}.`,
        'Confira DB_USER/DB_PASSWORD no .env — devem bater com o docker-compose.yml do artificialstudio.',
      )
    }
    throw new DatabaseError(`Falha ao conectar no MySQL em ${where}: ${String(err)}`)
  }
}
