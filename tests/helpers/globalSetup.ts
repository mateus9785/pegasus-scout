import { readFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { loadEnv } from '../../src/config/env.js'

/**
 * Cria (ou recria) o banco de teste e aplica nele o MESMO schema.sql do
 * artificialstudio.
 *
 * Duas propriedades importantes:
 *
 * 1. O DDL nao e duplicado. Se alguem mudar uma coluna scout_* no schema.sql e
 *    esquecer de atualizar um repositorio, o teste de integracao quebra -- que e
 *    exatamente o alarme que se quer. Um DDL copiado aqui esconderia isso.
 *
 * 2. O banco e OUTRO (DB_NAME_TEST). As suites truncam tabelas, e apontar isso
 *    para o banco de trabalho apagaria prospeccao real.
 */

const SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  '../../../artificialstudio/backend/src/db/schema.sql',
)

const IGNORABLE = new Set([
  'ER_DUP_FIELDNAME',
  'ER_DUP_KEYNAME',
  'ER_TABLE_EXISTS_ERROR',
  'ER_CANT_DROP_FIELD_OR_KEY',
])

export async function setup(): Promise<void> {
  const env = loadEnv()

  if (env.DB_NAME_TEST === env.DB_NAME) {
    throw new Error(
      `DB_NAME_TEST (${env.DB_NAME_TEST}) e igual a DB_NAME. Os testes truncam tabelas -- ` +
        'aponte DB_NAME_TEST para um banco separado no .env.',
    )
  }

  let schema: string
  try {
    schema = await readFile(SCHEMA_PATH, 'utf-8')
  } catch {
    throw new Error(
      `Nao achei o schema em ${SCHEMA_PATH}. Os testes de integracao dependem do ` +
        'artificialstudio estar ao lado do pegasus-scout na mesma pasta raiz.',
    )
  }

  // Conexao administrativa: CREATE DATABASE nao e permitido ao usuario da
  // aplicacao no docker-compose do artificialstudio.
  let admin: mysql.Connection
  try {
    admin = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_ADMIN_USER,
      password: env.DB_ADMIN_PASSWORD,
      multipleStatements: false,
    })
  } catch (err) {
    throw new Error(
      `Nao consegui conectar como administrador (${env.DB_ADMIN_USER}) em ` +
        `${env.DB_HOST}:${env.DB_PORT} para criar o banco de teste. ` +
        'Suba o MySQL com `docker compose up -d` em artificialstudio/ e confira ' +
        'DB_ADMIN_USER/DB_ADMIN_PASSWORD no .env.',
      { cause: err },
    )
  }

  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME_TEST}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    )
    // GRANT nao aceita placeholder para nome de usuario, entao o valor entra
    // interpolado -- e por isso passa por uma lista branca antes. Vem do .env do
    // proprio usuario, mas "vem de config" nao e o mesmo que "e seguro concatenar".
    if (!/^[A-Za-z0-9_.-]+$/.test(env.DB_USER)) {
      throw new Error(
        `DB_USER ("${env.DB_USER}") tem caracteres fora de [A-Za-z0-9_.-] e nao pode ser usado no GRANT do setup de teste.`,
      )
    }
    await admin.query(
      `GRANT ALL PRIVILEGES ON \`${env.DB_NAME_TEST}\`.* TO '${env.DB_USER}'@'%'`,
    )
    await admin.query('FLUSH PRIVILEGES')
  } finally {
    await admin.end()
  }

  // Aplica o schema com o mesmo algoritmo do migrate.js do artificialstudio:
  // corta em ponto e virgula e tolera os erros de "ja existe".
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_ADMIN_USER,
    password: env.DB_ADMIN_PASSWORD,
    database: env.DB_NAME_TEST,
  })

  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

  try {
    for (const statement of statements) {
      try {
        await conn.query(statement)
      } catch (err) {
        if (!IGNORABLE.has((err as { code?: string }).code ?? '')) throw err
      }
    }
  } finally {
    await conn.end()
  }
}
