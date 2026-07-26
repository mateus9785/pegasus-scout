import { describe, expect, it } from 'vitest'
import { analyzeSite } from '../../src/enrichment/detectors.js'
import { parseRobots, isAllowedByRobots } from '../../src/enrichment/httpClient.js'
import { extractJson } from '../../src/enrichment/llmAnalyzer.js'

const PAGE_URL = 'https://petshopalfa.com.br/'

const wrap = (body: string, head = ''): string =>
  `<!doctype html><html><head><title>Pet Shop Alfa</title><meta name="description" content="Racao e banho e tosa em Brasilia">${head}</head><body>${body}</body></html>`

describe('analyzeSite — widget de chat (empresa JA automatizada)', () => {
  it('detecta Tawk.to pelo src do script', () => {
    const html = wrap('<p>Bem-vindo</p>', '<script src="https://embed.tawk.to/abc/default"></script>')
    const a = analyzeSite(html, PAGE_URL)

    expect(a.chatWidget).toBe('tawk')
    const signal = a.signals.find((s) => s.key === 'chat_widget')
    expect(signal?.value).toBe('tawk')
    expect(signal?.evidence).toContain('tawk.to')
  })

  it('detecta os outros widgets brasileiros e internacionais', () => {
    const casos: Array<[string, string]> = [
      ['https://code.jivosite.com/widget/x', 'jivochat'],
      ['https://client.crisp.chat/l.js', 'crisp'],
      ['https://widget.intercom.io/widget/x', 'intercom'],
      ['https://static.zdassets.com/ekr/snippet.js', 'zendesk'],
      ['https://code.tidio.co/x.js', 'tidio'],
      ['https://builder.blip.ai/x.js', 'blip'],
      ['https://cdn.leadster.com.br/x.js', 'leadster'],
      ['https://js.hs-scripts.com/123.js', 'hubspot'],
      ['https://huggy.io/widget.js', 'huggy'],
      ['https://cdn.botpress.cloud/webchat/v1/inject.js', 'botpress'],
    ]

    for (const [src, esperado] of casos) {
      const a = analyzeSite(wrap('<p>x</p>', `<script src="${src}"></script>`), PAGE_URL)
      expect(a.chatWidget, src).toBe(esperado)
    }
  })

  it('encontra assinatura em script inline, nao so em src', () => {
    const html = wrap('<p>x</p>', '<script>window.$crisp=[];CRISP_WEBSITE_ID="x";</script>')
    // A busca e no HTML cru justamente para pegar este caso.
    expect(analyzeSite(html, PAGE_URL).chatWidget).toBe('crisp')
  })
})

describe('analyzeSite — WhatsApp (atendimento manual, alvo bom)', () => {
  it('extrai o numero do link wa.me e normaliza para E.164', () => {
    const a = analyzeSite(
      wrap('<a href="https://wa.me/5561999998888">Fale no WhatsApp</a>'),
      PAGE_URL,
    )
    expect(a.whatsappNumbers).toEqual(['+5561999998888'])
    expect(a.signals.find((s) => s.key === 'whatsapp_no_site')?.value).toBe('+5561999998888')
  })

  it('extrai o numero do formato api.whatsapp.com/send?phone=', () => {
    const a = analyzeSite(
      wrap('<a href="https://api.whatsapp.com/send?phone=5561988887777&text=oi">Chamar</a>'),
      PAGE_URL,
    )
    expect(a.whatsappNumbers).toEqual(['+5561988887777'])
  })

  it('marca atendimento_manual_provavel quando ha WhatsApp e nenhum widget', () => {
    const a = analyzeSite(wrap('<a href="https://wa.me/5561999998888">Zap</a>'), PAGE_URL)
    expect(a.signals.map((s) => s.key)).toContain('atendimento_manual_provavel')
  })

  it('NAO marca atendimento manual quando o site tem widget de chat', () => {
    // Este e o caso que separa alvo de nao-alvo. Errar aqui faz o robo abordar
    // quem ja tem automacao, que e a pior primeira impressao possivel.
    const html = wrap(
      '<a href="https://wa.me/5561999998888">Zap</a>',
      '<script src="https://embed.tawk.to/x"></script>',
    )
    const a = analyzeSite(html, PAGE_URL)
    expect(a.chatWidget).toBe('tawk')
    expect(a.signals.map((s) => s.key)).not.toContain('atendimento_manual_provavel')
  })

  it('detecta plugin de botao flutuante de WhatsApp', () => {
    const html = wrap('<div class="btn-whatsapp"></div>', '<script src="/wp-content/plugins/ht-ctc/x.js"></script>')
    const a = analyzeSite(html, PAGE_URL)
    expect(a.whatsappWidget).toBe('click-to-chat')
    expect(a.signals.map((s) => s.key)).toContain('atendimento_manual_provavel')
  })

  it('nao inventa numero quando o link de WhatsApp e generico', () => {
    const a = analyzeSite(wrap('<a href="https://wa.me/">WhatsApp</a>'), PAGE_URL)
    expect(a.whatsappNumbers).toEqual([])
  })
})

describe('analyzeSite — plataforma de e-commerce e pagamento', () => {
  it('detecta NuvemShop, Shopify, Tray, VTEX e Woo', () => {
    const casos: Array<[string, string]> = [
      ['https://d2r9epyceweg5n.cloudfront.net/nuvemshop.js', 'nuvemshop'],
      ['https://cdn.shopify.com/s/x.js', 'shopify'],
      ['https://www.tray.com.br/x.js', 'tray'],
      ['https://vtexassets.com/x.js', 'vtex'],
      ['/wp-content/plugins/woocommerce/assets/js/x.js', 'woocommerce'],
      ['https://cdn.lojaintegrada.com.br/x.js', 'loja-integrada'],
      ['https://api.yampi.io/x.js', 'yampi'],
    ]
    for (const [src, esperado] of casos) {
      const a = analyzeSite(wrap('<p>loja</p>', `<script src="${src}"></script>`), PAGE_URL)
      expect(a.ecommercePlatform, src).toBe(esperado)
    }
  })

  it('NAO trata construtor de site como loja virtual', () => {
    // Caso real: o ZEISS Vision Center de Brasilia ficou em 1o lugar com +20 pontos
    // e a oportunidade "integrar com a loja virtual" so por carregar wixstatic.com.
    // A analise da propria pagina dizia "site institucional, sem loja virtual".
    const a = analyzeSite(
      wrap('<p>Nossa otica</p>', '<script src="https://static.wixstatic.com/x.js"></script>'),
      PAGE_URL,
    )
    expect(a.ecommercePlatform).toBeNull()
    expect(a.siteBuilder).toBe('wix')
    expect(a.signals.find((s) => s.key === 'construtor_de_site')?.value).toBe('wix')
  })

  it('detecta os outros construtores de site', () => {
    const casos: Array<[string, string]> = [
      ['https://static1.squarespace.com/x.js', 'squarespace'],
      ['https://assets.website-files.com/webflow.js', 'webflow'],
      ['/wp-content/themes/tema/style.css', 'wordpress'],
    ]
    for (const [src, esperado] of casos) {
      const a = analyzeSite(wrap('<p>x</p>', `<script src="${src}"></script>`), PAGE_URL)
      expect(a.siteBuilder, src).toBe(esperado)
    }
  })

  it('quando ha loja virtual de verdade, ela prevalece sobre o construtor', () => {
    // WooCommerce roda sobre WordPress: os dois sinais aparecem juntos, e nesse caso
    // a loja e o fato que importa.
    const a = analyzeSite(
      wrap(
        '<p>loja</p>',
        '<script src="/wp-content/themes/t/x.js"></script><script src="/wp-content/plugins/woocommerce/x.js"></script>',
      ),
      PAGE_URL,
    )
    expect(a.ecommercePlatform).toBe('woocommerce')
    // O sinal de construtor nao e emitido quando ha e-commerce, para nao contar duas
    // vezes a mesma coisa no scoring.
    expect(a.signals.some((s) => s.key === 'construtor_de_site')).toBe(false)
  })

  it('acumula os meios de pagamento encontrados', () => {
    const html = wrap(
      '<p>Pague com</p>',
      '<script src="https://sdk.mercadopago.com/js/v2"></script><script src="https://js.stripe.com/v3"></script>',
    )
    const a = analyzeSite(html, PAGE_URL)
    expect(a.paymentProviders).toContain('mercadopago')
    expect(a.paymentProviders).toContain('stripe')
    expect(a.signals.find((s) => s.key === 'meios_pagamento')?.value).toContain('mercadopago')
  })
})

describe('analyzeSite — contato e redes sociais', () => {
  it('extrai telefone do texto visivel e descarta 0800', () => {
    const a = analyzeSite(
      wrap('<p>Ligue (61) 3333-4444 ou no 0800 555 1234</p>'),
      PAGE_URL,
    )
    expect(a.phones).toEqual(['+556133334444'])
  })

  it('extrai e-mail e filtra ruido de infraestrutura', () => {
    const html = wrap(
      '<p>contato@petshopalfa.com.br</p>',
      '<script>Sentry.init({dsn:"https://abc@o123.ingest.sentry.io/456"})</script>',
    )
    const a = analyzeSite(html, PAGE_URL)
    expect(a.emails).toContain('contato@petshopalfa.com.br')
    expect(a.emails.some((e) => e.includes('sentry'))).toBe(false)
  })

  it('pega o perfil do Instagram mas ignora link de post', () => {
    const html = wrap(`
      <a href="https://www.instagram.com/p/ABC123/">veja o post</a>
      <a href="https://www.instagram.com/petshopalfa/?utm_source=site">nosso perfil</a>
    `)
    const a = analyzeSite(html, PAGE_URL)
    // Rastreio removido, e o link de post descartado.
    expect(a.instagramUrl).toBe('https://www.instagram.com/petshopalfa')
  })

  it('pega a pagina do Facebook mas ignora o botao de compartilhar', () => {
    const html = wrap(`
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">compartilhar</a>
      <a href="https://www.facebook.com/petshopalfa">nossa pagina</a>
    `)
    expect(analyzeSite(html, PAGE_URL).facebookUrl).toBe('https://www.facebook.com/petshopalfa')
  })

  it('extrai titulo, meta description e texto visivel sem script', () => {
    const html = wrap(
      '<h1>Pet Shop Alfa</h1><p>Racao e banho.</p>',
      '<script>var segredo = "nao deve entrar no texto"</script>',
    )
    const a = analyzeSite(html, PAGE_URL)
    expect(a.title).toBe('Pet Shop Alfa')
    expect(a.metaDescription).toContain('Racao e banho e tosa')
    expect(a.text).toContain('Racao e banho.')
    expect(a.text).not.toContain('segredo')
  })

  it('nao lanca com HTML vazio ou lixo', () => {
    for (const html of ['', '<html></html>', 'nem html isso e']) {
      const a = analyzeSite(html, PAGE_URL)
      expect(a.chatWidget).toBeNull()
      expect(a.whatsappNumbers).toEqual([])
      expect(a.signals).toEqual([])
    }
  })
})

describe('robots.txt', () => {
  it('le os Disallow do bloco User-agent: *', () => {
    const rules = parseRobots(`
      User-agent: Googlebot
      Disallow: /so-para-google/

      User-agent: *
      Disallow: /admin/
      Disallow: /checkout
      Allow: /

      # comentario
      User-agent: Bingbot
      Disallow: /so-para-bing/
    `)
    expect(rules).toEqual(['/admin/', '/checkout'])
  })

  it('aplica os Disallow por prefixo', () => {
    const rules = { disallowed: ['/admin/', '/checkout'], fetched: true }
    expect(isAllowedByRobots(rules, '/')).toBe(true)
    expect(isAllowedByRobots(rules, '/contato')).toBe(true)
    expect(isAllowedByRobots(rules, '/admin/pedidos')).toBe(false)
    expect(isAllowedByRobots(rules, '/checkout')).toBe(false)
  })

  it('sem regra declarada, tudo e permitido', () => {
    expect(isAllowedByRobots({ disallowed: [], fetched: false }, '/qualquer')).toBe(true)
  })

  it('Disallow: / bloqueia o site inteiro', () => {
    expect(isAllowedByRobots({ disallowed: ['/'], fetched: true }, '/contato')).toBe(false)
  })

  it('ignora comentario e linha vazia sem explodir', () => {
    expect(parseRobots('# so um comentario\n\n\n')).toEqual([])
    expect(parseRobots('')).toEqual([])
  })
})

describe('extractJson (resposta do CLI claude)', () => {
  it('le o campo result do envelope --output-format json', () => {
    const stdout = JSON.stringify({ result: '{"segmento":"pet shop"}', is_error: false })
    expect(extractJson(stdout)).toEqual({ segmento: 'pet shop' })
  })

  it('tolera cerca de codigo em volta do JSON', () => {
    // O modelo as vezes embrulha em ```json apesar da instrucao contraria.
    const stdout = JSON.stringify({ result: '```json\n{"segmento":"otica"}\n```' })
    expect(extractJson(stdout)).toEqual({ segmento: 'otica' })
  })

  it('tolera texto explicativo antes do JSON', () => {
    const stdout = JSON.stringify({ result: 'Aqui esta a analise:\n{"segmento":"padaria"}' })
    expect(extractJson(stdout)).toEqual({ segmento: 'padaria' })
  })

  it('aceita stdout que ja e o proprio JSON, sem envelope', () => {
    expect(extractJson('{"segmento":"mercado"}')).toEqual({ segmento: 'mercado' })
  })

  it('lanca com mensagem util quando nao ha JSON nenhum', () => {
    expect(() => extractJson('nao consegui analisar')).toThrow(/nao contem JSON/)
  })
})
