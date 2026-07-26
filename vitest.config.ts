import { defineConfig } from 'vitest/config'

/**
 * Dois projects com contratos diferentes:
 *
 * - `unit`: nenhuma rede, nenhum banco, nenhum navegador. E onde vive a maior
 *   parte do valor (parsers, detectores, normalizacao de telefone, scoring).
 *   Se algum teste daqui passar de segundos, ele esta no project errado.
 *
 * - `integration`: fala com o MySQL do docker, num banco separado criado pelo
 *   globalSetup. `fileParallelism: false` porque as suites compartilham o mesmo
 *   banco e truncam tabelas — rodar em paralelo daria corrida.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/globalSetup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
