/**
 * Classes de erro nomeadas, seguindo o padrao do chatbot_7m: o service lanca um
 * erro com nome proprio e quem chama decide o que fazer via `instanceof`, em vez
 * de comparar strings de mensagem.
 *
 * A diferenca aqui e que o consumidor nao e um controller HTTP, e o CLI. Por isso
 * cada erro carrega `hint`: o que o usuario deve FAZER para resolver. Um erro de
 * CLI sem instrucao de conserto e so um beco sem saida no terminal.
 */

export class ScoutError extends Error {
  readonly hint: string | undefined

  constructor(message: string, hint?: string) {
    super(message)
    this.name = new.target.name
    this.hint = hint
  }
}

/** Variavel de ambiente ausente ou invalida. Lancado por config/env.ts. */
export class ConfigError extends ScoutError {}

/** As tabelas scout_* nao existem no banco apontado. Lancado por db/assertSchema.ts. */
export class SchemaError extends ScoutError {}

/** Nao conseguiu falar com o MySQL. */
export class DatabaseError extends ScoutError {}

/** Argumento de linha de comando ausente ou fora do dominio permitido. */
export class UsageError extends ScoutError {}

/**
 * Um seletor obrigatorio do Google Maps (ou de uma pagina da Meta) nao casou com
 * nada. Nao e um erro de rede: e o sinal de que o layout mudou e o parser precisa
 * ser atualizado. Falhar aqui e melhor que gravar 40 registros vazios no banco.
 */
export class SelectorError extends ScoutError {
  readonly selectorKey: string

  constructor(selectorKey: string, message: string, hint?: string) {
    super(message, hint)
    this.selectorKey = selectorKey
  }
}

/** O perfil de navegador daquele alvo nao esta logado. */
export class NotLoggedInError extends ScoutError {}

/** Um teto de seguranca foi atingido (limite diario, blocklist). */
export class SafetyLimitError extends ScoutError {}

/** Falha ao buscar o site da empresa. Nao interrompe o lote — so marca o prospect. */
export class FetchError extends ScoutError {
  readonly url: string
  readonly status: number | undefined

  constructor(url: string, message: string, status?: number) {
    super(message)
    this.url = url
    this.status = status
  }
}
