import type { AutomationVerdict } from '../types/domain.js'

/**
 * Scoring deterministico e versionado.
 *
 * Deterministico de proposito, apesar de a LLM estar disponivel: o score decide a
 * ordem em que as empresas vao ser abordadas, e essa decisao precisa ser auditavel
 * ("por que essa ficou em primeiro?") e reproduzivel. Regra em codigo responde isso
 * com uma lista de motivos. Modelo responde com uma opiniao que muda entre chamadas.
 *
 * `SCORE_VERSION` fica gravado em cada prospect. Quando os pesos mudarem, da para
 * reprocessar o historico e comparar as duas versoes em vez de perder a anterior.
 */

export const SCORE_VERSION = 'score-v1'

/**
 * O que vender para esta empresa.
 *
 * Existe porque site fora do ar nao e so "alvo bom" -- e uma venda DIFERENTE. Quem
 * deixou o dominio cair precisa de site novo junto com o robo, e o orcamento e a
 * abordagem da Etapa 2 mudam por causa disso.
 */
export type Oportunidade =
  | 'robo_atendimento'
  | 'site_novo'
  | 'presenca_digital'
  | 'integracao_ecommerce'
  | 'catalogo_online'

export const OPORTUNIDADE_LABEL: Record<Oportunidade, string> = {
  robo_atendimento: 'Robo de atendimento no WhatsApp',
  site_novo: 'Site novo (o atual esta fora do ar)',
  presenca_digital: 'Presenca digital do zero (nao tem site)',
  integracao_ecommerce: 'Integracao com a loja virtual (pedido, estoque, frete, pagamento)',
  catalogo_online: 'Catalogo e venda online',
}

/** Sinais que o scoring consome, achatados em booleanos e numeros. */
export type ScoreInput = {
  temWidgetChat: boolean
  widgetChatNome: string | null
  temWhatsapp: boolean
  temBotaoWhatsappPlugin: boolean
  temSiteProprio: boolean
  siteForaDoAr: boolean
  siteEmPlataformaTerceiro: boolean
  plataformaEcommerce: string | null
  /**
   * Site montado em construtor drag-and-drop (Wix, Squarespace...). Aponta
   * operacao sem equipe tecnica, o que reforca a hipotese de atendimento manual.
   * NAO e o mesmo que loja virtual -- confundir os dois inflava o score e sugeria
   * "integrar com a loja" para site institucional sem loja alguma.
   */
  construtorDeSite: string | null
  meiosPagamento: string[]
  temInstagram: boolean
  avaliacoes: number | null
  nota: number | null
  horarioDeclarado: boolean
  /** Vindo do brief da LLM, quando existir. */
  porteLlm: string | null
  catalogoLlm: string | null
  /**
   * O DDD do contato bate com a UF pesquisada? `null` quando nao da para saber.
   *
   * Achado da primeira varredura real: a Cobasi de Brasilia anunciava WhatsApp com
   * DDD 11. Nao e a loja -- e a central da rede em Sao Paulo. Comercio local atende
   * em DDD local, e numero de outro estado significa que quem responde e um call
   * center corporativo, nao quem decide a compra.
   */
  contatoLocal: boolean | null
}

export type ScoreResult = {
  score: number
  verdict: AutomationVerdict
  version: string
  oportunidades: Oportunidade[]
  /** Cada motivo com o peso que aplicou. E o que torna o ranking explicavel. */
  motivos: Array<{ motivo: string; peso: number }>
}

/**
 * Pesos.
 *
 * O sinal dominante e negativo e nao positivo: a presenca de um widget de chat
 * derruba o score para o chao. E deliberado -- abordar quem JA tem automacao
 * dizendo "vi que voce atende manualmente" queima a empresa e o remetente. E melhor
 * perder um alvo duvidoso que errar esse.
 */
const PESOS = {
  widgetChat: -70,
  whatsappSemWidget: 30,
  botaoWhatsappPlugin: 10,
  ecommerce: 20,
  meiosPagamento: 8,
  semSiteProprio: 12,
  siteForaDoAr: 18,
  siteEmPlataformaTerceiro: 10,
  construtorDeSite: 6,
  instagram: 5,
  volumeAvaliacoesAlto: 15,
  volumeAvaliacoesMedio: 8,
  notaAlta: 5,
  horarioDeclarado: 4,
  porteMuitoPequeno: -8,
  porteGrande: -45,
  contatoForaDaRegiao: -25,
  catalogoGrande: 10,
} as const

const BASE = 35

export function scoreProspect(input: ScoreInput): ScoreResult {
  const motivos: ScoreResult['motivos'] = []
  const add = (motivo: string, peso: number): void => {
    if (peso !== 0) motivos.push({ motivo, peso })
  }

  if (input.temWidgetChat) {
    add(`Ja tem widget de atendimento (${input.widgetChatNome ?? 'detectado'}) — nao abordar`, PESOS.widgetChat)
  }

  if (input.temWhatsapp && !input.temWidgetChat) {
    add('Atende por WhatsApp sem nenhuma automacao por tras', PESOS.whatsappSemWidget)
  }
  if (input.temBotaoWhatsappPlugin && !input.temWidgetChat) {
    add('Botao flutuante de WhatsApp no site (tudo cai no atendimento humano)', PESOS.botaoWhatsappPlugin)
  }

  if (input.plataformaEcommerce) {
    add(`Loja virtual em ${input.plataformaEcommerce} — ha ERP, estoque e frete para integrar`, PESOS.ecommerce)
  }
  if (input.construtorDeSite && !input.plataformaEcommerce) {
    add(`Site montado em ${input.construtorDeSite} — operacao sem equipe tecnica`, PESOS.construtorDeSite)
  }
  if (input.meiosPagamento.length > 0) {
    add(`Ja usa ${input.meiosPagamento.join(', ')} — link de pagamento e integravel`, PESOS.meiosPagamento)
  }

  if (input.siteForaDoAr) {
    add('Site anunciado no Maps esta fora do ar — precisa de site novo tambem', PESOS.siteForaDoAr)
  } else if (!input.temSiteProprio) {
    if (input.siteEmPlataformaTerceiro) {
      add('So tem presenca em plataforma de terceiro, sem site proprio', PESOS.siteEmPlataformaTerceiro)
    } else {
      add('Nao tem site nenhum — maturidade digital baixa', PESOS.semSiteProprio)
    }
  }

  if (input.temInstagram) add('Tem Instagram (canal ativo para abordar)', PESOS.instagram)

  if (input.avaliacoes !== null) {
    if (input.avaliacoes >= 300) {
      add(`${input.avaliacoes} avaliacoes no Maps — volume alto de clientes, dor de atendimento real`, PESOS.volumeAvaliacoesAlto)
    } else if (input.avaliacoes >= 60) {
      add(`${input.avaliacoes} avaliacoes no Maps — movimento consistente`, PESOS.volumeAvaliacoesMedio)
    }
  }
  if (input.nota !== null && input.nota >= 4.5) {
    add(`Nota ${input.nota.toFixed(1)} — cliente satisfeito, vale preservar o atendimento`, PESOS.notaAlta)
  }
  if (input.horarioDeclarado) {
    add('Declara horario de funcionamento (fora dele, ninguem atende)', PESOS.horarioDeclarado)
  }

  // Porte, vindo do brief da LLM. MEI raramente fecha o ticket, e rede grande
  // costuma ter contrato de automacao fechado com fornecedor.
  if (input.porteLlm === 'mei') add('Porte MEI — ticket provavelmente baixo', PESOS.porteMuitoPequeno)
  if (input.porteLlm === 'grande') {
    add('Porte grande (rede nacional) — decisao de automacao nao passa pela loja local', PESOS.porteGrande)
  }
  if (input.contatoLocal === false) {
    add('Contato com DDD de outro estado — e a central da rede, nao a loja', PESOS.contatoForaDaRegiao)
  }
  if (input.catalogoLlm === 'grande') add('Catalogo grande — muito produto para o robo consultar', PESOS.catalogoGrande)

  const bruto = BASE + motivos.reduce((soma, m) => soma + m.peso, 0)
  const score = Math.max(0, Math.min(100, Math.round(bruto)))

  return {
    score,
    verdict: decideVerdict(input),
    version: SCORE_VERSION,
    oportunidades: decideOportunidades(input),
    motivos,
  }
}

/**
 * Veredito sobre a automacao.
 *
 * Nunca afirma o que a Etapa 1 nao mediu. Ninguem mandou mensagem para ninguem
 * aqui, entao "atendimento humano e lento" e uma HIPOTESE -- por isso os rotulos
 * comecam com "provavelmente", e existe `indefinido` de verdade para o caso em que
 * nao ha sinal nenhum. Confirmar e trabalho da Etapa 2.
 */
function decideVerdict(input: ScoreInput): AutomationVerdict {
  if (input.temWidgetChat) return 'provavelmente_automatizado'
  if (input.temWhatsapp || input.temBotaoWhatsappPlugin) return 'provavelmente_manual'
  if (input.siteForaDoAr || !input.temSiteProprio) return 'provavelmente_manual'
  return 'indefinido'
}

function decideOportunidades(input: ScoreInput): Oportunidade[] {
  const out: Oportunidade[] = []

  if (!input.temWidgetChat && (input.temWhatsapp || input.temBotaoWhatsappPlugin)) {
    out.push('robo_atendimento')
  }
  if (input.siteForaDoAr) out.push('site_novo')
  else if (!input.temSiteProprio) out.push('presenca_digital')

  if (input.plataformaEcommerce) out.push('integracao_ecommerce')
  else if (input.catalogoLlm === 'grande' || input.catalogoLlm === 'medio') {
    out.push('catalogo_online')
  }

  // Sem nenhum canal detectado nao ha o que propor com honestidade -- melhor lista
  // vazia que uma oportunidade inventada.
  return out
}
