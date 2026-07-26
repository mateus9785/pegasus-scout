import { describe, expect, it } from 'vitest'
import { scoreProspect, SCORE_VERSION, OPORTUNIDADE_LABEL } from '../../src/scoring/score.js'
import type { ScoreInput } from '../../src/scoring/score.js'
import { buildScoreInput } from '../../src/scoring/scoringService.js'

const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  temWidgetChat: false,
  widgetChatNome: null,
  temWhatsapp: false,
  temBotaoWhatsappPlugin: false,
  temSiteProprio: true,
  siteForaDoAr: false,
  siteEmPlataformaTerceiro: false,
  plataformaEcommerce: null,
  construtorDeSite: null,
  meiosPagamento: [],
  temInstagram: false,
  avaliacoes: null,
  nota: null,
  horarioDeclarado: false,
  porteLlm: null,
  catalogoLlm: null,
  contatoLocal: null,
  ...over,
})

describe('scoreProspect — o sinal que nao pode errar', () => {
  it('derruba o score de quem ja tem widget de chat', () => {
    const comWidget = scoreProspect(base({ temWidgetChat: true, widgetChatNome: 'tawk' }))
    const semWidget = scoreProspect(base({ temWhatsapp: true }))

    expect(comWidget.verdict).toBe('provavelmente_automatizado')
    expect(comWidget.score).toBeLessThan(semWidget.score)
    expect(comWidget.motivos[0]?.motivo).toContain('tawk')
  })

  it('widget de chat vence todos os sinais positivos somados', () => {
    // Uma loja grande, bem avaliada, com e-commerce e WhatsApp -- mas com widget.
    // Se o score dela subisse, o robo abordaria quem ja tem automacao.
    const r = scoreProspect(
      base({
        temWidgetChat: true,
        widgetChatNome: 'jivochat',
        temWhatsapp: true,
        temBotaoWhatsappPlugin: true,
        plataformaEcommerce: 'nuvemshop',
        meiosPagamento: ['mercadopago'],
        temInstagram: true,
        avaliacoes: 900,
        nota: 4.9,
        horarioDeclarado: true,
      }),
    )
    expect(r.verdict).toBe('provavelmente_automatizado')
    expect(r.score).toBeLessThan(50)
  })

  it('nao oferece robo de atendimento para quem ja tem widget', () => {
    const r = scoreProspect(base({ temWidgetChat: true, temWhatsapp: true }))
    expect(r.oportunidades).not.toContain('robo_atendimento')
  })
})

describe('scoreProspect — alvos bons', () => {
  it('WhatsApp sem automacao e o perfil alvo', () => {
    const r = scoreProspect(base({ temWhatsapp: true }))
    expect(r.verdict).toBe('provavelmente_manual')
    expect(r.oportunidades).toContain('robo_atendimento')
    expect(r.motivos.some((m) => m.motivo.includes('sem nenhuma automacao'))).toBe(true)
  })

  it('loja virtual soma porque ha ERP e frete para integrar', () => {
    const comLoja = scoreProspect(base({ temWhatsapp: true, plataformaEcommerce: 'nuvemshop' }))
    const semLoja = scoreProspect(base({ temWhatsapp: true }))

    expect(comLoja.score).toBeGreaterThan(semLoja.score)
    expect(comLoja.oportunidades).toContain('integracao_ecommerce')
  })

  it('volume alto de avaliacoes indica dor de atendimento real', () => {
    const muitas = scoreProspect(base({ temWhatsapp: true, avaliacoes: 800 }))
    const algumas = scoreProspect(base({ temWhatsapp: true, avaliacoes: 100 }))
    const poucas = scoreProspect(base({ temWhatsapp: true, avaliacoes: 3 }))

    expect(muitas.score).toBeGreaterThan(algumas.score)
    expect(algumas.score).toBeGreaterThan(poucas.score)
  })
})

describe('scoreProspect — site fora do ar e uma venda diferente', () => {
  it('pontua positivo e propoe site novo junto do robo', () => {
    const r = scoreProspect(base({ siteForaDoAr: true, temWhatsapp: true }))

    expect(r.verdict).toBe('provavelmente_manual')
    expect(r.oportunidades).toContain('site_novo')
    expect(r.oportunidades).toContain('robo_atendimento')
    expect(r.motivos.some((m) => m.motivo.includes('fora do ar') && m.peso > 0)).toBe(true)
  })

  it('quem nao tem site nenhum recebe presenca digital, nao site novo', () => {
    const r = scoreProspect(base({ temSiteProprio: false, temWhatsapp: true }))
    expect(r.oportunidades).toContain('presenca_digital')
    expect(r.oportunidades).not.toContain('site_novo')
  })

  it('site fora do ar tem prioridade sobre "nao tem site"', () => {
    // Os dois sinais coexistem no banco: o website esta preenchido mas o dominio
    // morreu. Somar os dois pesos contaria a mesma coisa duas vezes.
    const r = scoreProspect(base({ temSiteProprio: false, siteForaDoAr: true }))
    expect(r.oportunidades).toContain('site_novo')
    expect(r.oportunidades).not.toContain('presenca_digital')
    expect(r.motivos.filter((m) => m.motivo.toLowerCase().includes('site'))).toHaveLength(1)
  })
})

describe('scoreProspect — porte vindo da analise por LLM', () => {
  it('MEI perde pontos e rede grande perde mais', () => {
    const normal = scoreProspect(base({ temWhatsapp: true }))
    const mei = scoreProspect(base({ temWhatsapp: true, porteLlm: 'mei' }))
    const grande = scoreProspect(base({ temWhatsapp: true, porteLlm: 'grande' }))

    expect(mei.score).toBeLessThan(normal.score)
    expect(grande.score).toBeLessThan(mei.score)
  })

  it('rede nacional nao lidera o ranking, mesmo com todos os sinais positivos', () => {
    // Caso real da primeira varredura: a Cobasi apareceu em 1o lugar com 84/100 por
    // ter WhatsApp, VTEX, Instagram e catalogo grande. E o pior alvo possivel -- a
    // decisao de automacao de uma rede de 240 lojas nao passa pela loja de Brasilia.
    const redeNacional = scoreProspect(
      base({
        temWhatsapp: true,
        plataformaEcommerce: 'vtex',
        temInstagram: true,
        horarioDeclarado: true,
        catalogoLlm: 'grande',
        porteLlm: 'grande',
        contatoLocal: false,
      }),
    )
    const comercioLocal = scoreProspect(base({ temWhatsapp: true, contatoLocal: true }))

    expect(redeNacional.score).toBeLessThan(comercioLocal.score)
  })

  it('DDD de outro estado derruba o score por ser central de rede', () => {
    const local = scoreProspect(base({ temWhatsapp: true, contatoLocal: true }))
    const foraDoEstado = scoreProspect(base({ temWhatsapp: true, contatoLocal: false }))
    const indefinido = scoreProspect(base({ temWhatsapp: true, contatoLocal: null }))

    expect(foraDoEstado.score).toBeLessThan(local.score)
    // "nao sei" nao pode ser tratado como "e de fora".
    expect(indefinido.score).toBe(local.score)
    expect(foraDoEstado.motivos.some((m) => m.motivo.includes('central da rede'))).toBe(true)
  })

  it('catalogo grande soma e sugere catalogo online quando nao ha loja virtual', () => {
    const r = scoreProspect(base({ temWhatsapp: true, catalogoLlm: 'grande' }))
    expect(r.oportunidades).toContain('catalogo_online')
    expect(r.motivos.some((m) => m.motivo.includes('Catalogo grande'))).toBe(true)
  })

  it('sem brief da LLM, o score continua funcionando', () => {
    const r = scoreProspect(base({ temWhatsapp: true, porteLlm: null, catalogoLlm: null }))
    expect(r.score).toBeGreaterThan(0)
    expect(r.verdict).toBe('provavelmente_manual')
  })
})

describe('scoreProspect — invariantes', () => {
  it('o score fica sempre entre 0 e 100', () => {
    const pior = scoreProspect(
      base({ temWidgetChat: true, porteLlm: 'grande', temSiteProprio: true }),
    )
    const melhor = scoreProspect(
      base({
        temWhatsapp: true,
        temBotaoWhatsappPlugin: true,
        plataformaEcommerce: 'nuvemshop',
        meiosPagamento: ['mercadopago', 'pagseguro'],
        siteForaDoAr: true,
        temInstagram: true,
        avaliacoes: 5000,
        nota: 5,
        horarioDeclarado: true,
        catalogoLlm: 'grande',
      }),
    )

    expect(pior.score).toBeGreaterThanOrEqual(0)
    expect(melhor.score).toBeLessThanOrEqual(100)
    expect(melhor.score).toBeGreaterThan(pior.score)
  })

  it('e deterministico: mesma entrada, mesma saida', () => {
    const input = base({ temWhatsapp: true, avaliacoes: 120, nota: 4.7 })
    expect(scoreProspect(input)).toEqual(scoreProspect(input))
  })

  it('sem sinal nenhum, o veredito e indefinido e nao ha oportunidade inventada', () => {
    const r = scoreProspect(base())
    expect(r.verdict).toBe('indefinido')
    expect(r.oportunidades).toEqual([])
  })

  it('grava a versao do score para permitir reprocessar o historico', () => {
    expect(scoreProspect(base()).version).toBe(SCORE_VERSION)
  })

  it('toda oportunidade possivel tem rotulo legivel', () => {
    const todas = new Set<string>()
    for (const input of [
      base({ temWhatsapp: true }),
      base({ siteForaDoAr: true }),
      base({ temSiteProprio: false }),
      base({ plataformaEcommerce: 'shopify' }),
      base({ catalogoLlm: 'medio' }),
    ]) {
      for (const o of scoreProspect(input).oportunidades) todas.add(o)
    }
    expect(todas.size).toBeGreaterThan(0)
    for (const o of todas) {
      expect(OPORTUNIDADE_LABEL[o as keyof typeof OPORTUNIDADE_LABEL]).toBeTruthy()
    }
  })
})

describe('buildScoreInput — traducao do banco para o scoring', () => {
  const row = {
    website: 'https://a.com.br',
    chat_widget: null,
    ecommerce_platform: null,
    whatsapp_phone_e164: null,
    instagram_url: null,
    reviews_count: null,
    rating: null,
    porte: null,
    catalogo: null,
    state: 'DF',
    phone_e164: null,
  }

  it('reconhece WhatsApp tanto pela coluna quanto pelo sinal do site', () => {
    expect(buildScoreInput({ ...row, whatsapp_phone_e164: '+5561999998888' }, new Map()).temWhatsapp).toBe(true)
    expect(buildScoreInput(row, new Map([['whatsapp_no_site', '+5561999998888']])).temWhatsapp).toBe(true)
    expect(buildScoreInput(row, new Map()).temWhatsapp).toBe(false)
  })

  it('separa os meios de pagamento gravados em lista', () => {
    const input = buildScoreInput(row, new Map([['meios_pagamento', 'mercadopago,stripe']]))
    expect(input.meiosPagamento).toEqual(['mercadopago', 'stripe'])
  })

  it('nao transforma sinal de pagamento vazio em lista com string vazia', () => {
    expect(buildScoreInput(row, new Map([['meios_pagamento', '']])).meiosPagamento).toEqual([])
  })

  it('converte a nota, que o mysql devolve como string decimal', () => {
    expect(buildScoreInput({ ...row, rating: '4.5' }, new Map()).nota).toBe(4.5)
    expect(buildScoreInput(row, new Map()).nota).toBeNull()
  })

  it('usa o sinal volume_avaliacoes quando a coluna esta vazia', () => {
    expect(buildScoreInput(row, new Map([['volume_avaliacoes', '340']])).avaliacoes).toBe(340)
    expect(buildScoreInput({ ...row, reviews_count: 12 }, new Map()).avaliacoes).toBe(12)
  })

  it('detecta site fora do ar pelo sinal do enrichment', () => {
    expect(buildScoreInput(row, new Map([['site_fora_do_ar', 'ENOTFOUND']])).siteForaDoAr).toBe(true)
  })
})
