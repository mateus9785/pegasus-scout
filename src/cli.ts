#!/usr/bin/env node
import { ScoutError } from './errors.js'

/**
 * Dispatcher de subcomandos. Cada comando e importado sob demanda (`await import`)
 * de proposito: `scout doctor` nao deve pagar o custo de carregar o Playwright, e
 * um erro de digitacao num modulo de scraping nao deve impedir o diagnostico de
 * ambiente de rodar.
 */

type CommandModule = { run: (argv: string[]) => Promise<void> }

const COMMANDS: Record<string, { summary: string; load: () => Promise<CommandModule> }> = {
  doctor: {
    summary: 'Verifica ambiente, conexao com o MySQL e presenca das tabelas scout_*',
    load: () => import('./commands/doctor.js'),
  },
  login: {
    summary: 'Abre o navegador visivel para voce logar uma vez (maps|whatsapp|instagram|facebook)',
    load: () => import('./commands/login.js'),
  },
  'check:selectors': {
    summary: 'Canario do scraper: prova que os seletores do Google Maps ainda casam',
    load: () => import('./commands/checkSelectors.js'),
  },
  discover: {
    summary: 'Mapeia empresas no Google Maps por nicho e cidade',
    load: () => import('./commands/discover.js'),
  },
  enrich: {
    summary: 'Le o site de cada empresa e detecta como o atendimento dela funciona hoje',
    load: () => import('./commands/enrich.js'),
  },
  score: {
    summary: 'Pontua cada empresa de 0 a 100 e classifica o tipo de oportunidade',
    load: () => import('./commands/score.js'),
  },
  report: {
    summary: 'Gera o Markdown com as empresas mais promissoras e o que vender para cada',
    load: () => import('./commands/report.js'),
  },
  run: {
    summary: 'Roda a Etapa 1 inteira: discover -> enrich -> score',
    load: () => import('./commands/run.js'),
  },
}

function printHelp(): void {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length))
  const lines = Object.entries(COMMANDS).map(
    ([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}`,
  )
  process.stdout.write(
    [
      'pegasus-scout — Etapa 1 do Projeto Pegasus (prospeccao passiva)',
      '',
      'Uso: npm run scout -- <comando> [opcoes]',
      '',
      'Comandos:',
      ...lines,
      '',
      'Rode `npm run scout -- <comando> --help` para as opcoes de cada um.',
      '',
    ].join('\n'),
  )
}

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2)

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    printHelp()
    return 0
  }

  const command = COMMANDS[name]
  if (!command) {
    process.stderr.write(`Comando desconhecido: ${name}\n\n`)
    printHelp()
    return 1
  }

  const mod = await command.load()
  await mod.run(rest)

  // Um comando pode falhar parcialmente sem lancar (o `doctor` roda todas as
  // verificacoes e so entao reprova). Se ele setou exitCode, respeite: sem isto,
  // o process.exit(0) abaixo apagaria a falha e o comando "passaria" no CI.
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Erro esperado do dominio: mensagem limpa + o que fazer. Stack trace de um
    // ConfigError so afoga a instrucao que resolve o problema.
    if (err instanceof ScoutError) {
      process.stderr.write(`\n✖ ${err.message}\n`)
      if (err.hint) process.stderr.write(`\n→ ${err.hint}\n`)
      process.stderr.write('\n')
      process.exit(1)
    }
    process.stderr.write('\n✖ Erro inesperado:\n')
    console.error(err)
    process.exit(1)
  })
