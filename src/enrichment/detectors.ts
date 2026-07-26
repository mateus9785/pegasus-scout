import * as cheerio from 'cheerio'
import { extractBrazilPhones } from '../utils/phone.js'
import { absolutize, extractDomain, stripTracking } from '../utils/url.js'
import { squish } from '../utils/text.js'

/**
 * Detectores deterministicos sobre o HTML do site da empresa.
 *
 * A escolha aqui e deliberada: o que e EXATO fica em tabela de assinatura, e o que
 * e INTERPRETATIVO ("o que essa empresa vende", "qual a dor dela") vai para a
 * analise por LLM em src/enrichment/llmAnalyzer.ts.
 *
 * Detectar "o site carrega embed.tawk.to" e um fato binario, gratuito, instantaneo e
 * testavel. Pedir isso a um modelo seria mais lento, mais caro e menos confiavel.
 */

export type DetectedSignal = {
  key: string
  value: string | null
  confidence: number
  evidence: string | null
}

type Signature = {
  /** Nome que vai para o banco. */
  name: string
  /** Trechos que, presentes no HTML, provam a plataforma. Comparados em minusculas. */
  needles: string[]
}

/**
 * Widgets de atendimento. Presenca de qualquer um destes e o sinal mais forte de
 * "essa empresa JA tem atendimento automatizado" -- ou seja, de que ela deve ser
 * DESCARTADA da lista, nao abordada.
 */
/**
 * Cada assinatura lista o `src` do script E o nome da variavel global que o
 * snippet cria.
 *
 * A global e essencial, nao redundancia: a instalacao mais comum destes widgets e
 * um snippet inline que injeta o script em runtime, e nesse caso o HTML servido nao
 * contem a URL do CDN nenhuma vez. Detectar so pelo `src` deixaria passar boa parte
 * das empresas que JA tem atendimento automatizado -- e classificar uma delas como
 * alvo e a pior falha possivel deste projeto: o robo abordaria dizendo "vi que voce
 * atende manualmente" para quem nao atende.
 */
export const CHAT_WIDGETS: Signature[] = [
  { name: 'tawk', needles: ['embed.tawk.to', 'tawk.to/chat', 'tawk_api', 'tawk_loadstart'] },
  { name: 'jivochat', needles: ['code.jivosite.com', 'jivosite', 'jivochat', 'jivo_api'] },
  { name: 'crisp', needles: ['client.crisp.chat', 'crisp.chat', '$crisp', 'crisp_website_id'] },
  {
    name: 'intercom',
    needles: ['widget.intercom.io', 'intercomcdn', 'intercomsettings', 'window.intercom'],
  },
  {
    name: 'zendesk',
    needles: ['static.zdassets.com', 'zopim', 'zendesk.com/embeddable', 'zesettings'],
  },
  { name: 'drift', needles: ['js.driftt.com', 'drift.com', 'drift.load'] },
  { name: 'tidio', needles: ['code.tidio.co', 'tidiochat'] },
  { name: 'livechat', needles: ['cdn.livechatinc.com', 'livechatinc'] },
  { name: 'freshchat', needles: ['wchat.freshchat.com', 'freshchat', 'fcwidget'] },
  { name: 'hubspot', needles: ['js.hs-scripts.com', 'hs-analytics', 'hubspot.com/conversations'] },
  { name: 'blip', needles: ['builder.blip.ai', 'blip.ai', 'take.net'] },
  { name: 'zenvia', needles: ['zenvia.com', 'zenvia-chat'] },
  { name: 'rdstation', needles: ['rdstation', 'd335luupugsy2.cloudfront.net'] },
  { name: 'octadesk', needles: ['octadesk'] },
  { name: 'movidesk', needles: ['movidesk'] },
  { name: 'huggy', needles: ['huggy.io', 'huggy.chat'] },
  { name: 'leadster', needles: ['leadster', 'cdn.leadster.com.br'] },
  { name: 'manychat', needles: ['manychat.com'] },
  { name: 'chatbase', needles: ['chatbase.co'] },
  { name: 'botpress', needles: ['botpress', 'cdn.botpress.cloud'] },
  { name: 'botmaker', needles: ['botmaker.com'] },
  { name: 'weni', needles: ['weni.ai'] },
]

/**
 * Botao flutuante de WhatsApp em plugin. Diferente dos widgets acima, isto NAO e
 * automatizacao -- e o oposto: e uma empresa direcionando tudo para o WhatsApp
 * humano dela. E o perfil de alvo mais promissor que existe.
 */
export const WHATSAPP_WIDGETS: Signature[] = [
  { name: 'joinchat', needles: ['joinchat', 'creame.joinchat'] },
  { name: 'click-to-chat', needles: ['ht-ctc', 'click-to-chat'] },
  { name: 'wa-widget-generico', needles: ['whatsapp-widget', 'wa-float', 'btn-whatsapp'] },
]

export const ECOMMERCE_PLATFORMS: Signature[] = [
  { name: 'nuvemshop', needles: ['nuvemshop', 'tiendanube', 'nuvemshop.com.br'] },
  { name: 'shopify', needles: ['cdn.shopify.com', 'shopify.theme', 'myshopify.com'] },
  { name: 'tray', needles: ['tray.com.br', 'traycommerce', 'commercetray'] },
  { name: 'vtex', needles: ['vtexassets', 'vteximg', 'vtex.com'] },
  { name: 'woocommerce', needles: ['woocommerce', 'wp-content/plugins/woocommerce'] },
  { name: 'magento', needles: ['magento', 'mage/cookies'] },
  { name: 'loja-integrada', needles: ['lojaintegrada', 'loja-integrada'] },
  { name: 'yampi', needles: ['yampi.com.br', 'yampi.io'] },
  { name: 'cartpanda', needles: ['cartpanda'] },
  { name: 'bagy', needles: ['bagy.com.br'] },
  { name: 'irroba', needles: ['irroba'] },
  { name: 'opencart', needles: ['opencart'] },
]

/**
 * Construtores de site institucional.
 *
 * Separados das plataformas de e-commerce por uma razao encontrada em dado real:
 * `wixstatic.com` estava na lista de e-commerce, e o ZEISS Vision Center de Brasilia
 * ganhou +20 pontos e a oportunidade "integrar com a loja virtual" -- enquanto a
 * analise da propria pagina dizia "site institucional, sem loja virtual". Detectar
 * Wix prova que o site foi montado no Wix, nao que existe uma loja.
 *
 * Como sinal, isto vale o oposto: site em construtor drag-and-drop aponta operacao
 * sem equipe tecnica, o que reforca a hipotese de atendimento manual.
 */
export const SITE_BUILDERS: Signature[] = [
  { name: 'wix', needles: ['wixstatic.com', 'parastorage.com', 'wix.com'] },
  { name: 'squarespace', needles: ['squarespace.com', 'sqspcdn'] },
  // `website-files.com` e o CDN real do Webflow: um site publicado em dominio
  // proprio nunca cita "webflow.com" no HTML, so os assets.
  { name: 'webflow', needles: ['website-files.com', 'webflow.io', 'webflow.com'] },
  { name: 'google-sites', needles: ['sites.google.com', 'gstatic.com/atari'] },
  { name: 'wordpress', needles: ['wp-content/themes', 'wp-includes'] },
]

/**
 * Meios de pagamento. Entram porque o discurso da Etapa 2 fala em "gerar link de
 * pagamento" e "integrar com o ERP": saber que a empresa ja usa Mercado Pago diz
 * qual integracao propor, e o orcamento sai concreto em vez de generico.
 */
export const PAYMENT_PROVIDERS: Signature[] = [
  { name: 'mercadopago', needles: ['mercadopago', 'mercadolibre'] },
  { name: 'pagseguro', needles: ['pagseguro', 'uol.com.br/pagseguro'] },
  { name: 'pagarme', needles: ['pagar.me', 'pagarme'] },
  { name: 'stripe', needles: ['js.stripe.com', 'stripe.com'] },
  { name: 'cielo', needles: ['cielo.com.br'] },
  { name: 'getnet', needles: ['getnet.com.br'] },
  { name: 'asaas', needles: ['asaas.com'] },
  { name: 'iugu', needles: ['iugu.com'] },
  { name: 'efi', needles: ['gerencianet', 'sejaefi', 'efipay'] },
  { name: 'infinitepay', needles: ['infinitepay'] },
  { name: 'hotmart', needles: ['hotmart.com'] },
  { name: 'kiwify', needles: ['kiwify.com'] },
]

function matchSignature(haystack: string, signatures: Signature[]): { name: string; needle: string } | null {
  for (const signature of signatures) {
    for (const needle of signature.needles) {
      if (haystack.includes(needle)) return { name: signature.name, needle }
    }
  }
  return null
}

/** Recorte curto em volta do trecho encontrado, para o campo `evidence`. */
function evidenceAround(haystack: string, needle: string, radius = 90): string {
  const index = haystack.indexOf(needle)
  if (index < 0) return needle
  return haystack.slice(Math.max(0, index - radius), index + needle.length + radius)
}

export type SiteAnalysis = {
  chatWidget: string | null
  siteBuilder: string | null
  whatsappWidget: string | null
  ecommercePlatform: string | null
  paymentProviders: string[]
  whatsappNumbers: string[]
  phones: string[]
  emails: string[]
  instagramUrl: string | null
  facebookUrl: string | null
  /** Texto visivel da pagina, para a analise por LLM. */
  text: string
  title: string | null
  metaDescription: string | null
  signals: DetectedSignal[]
}

/**
 * Analisa o HTML de uma pagina. Funcao pura -- testada contra fixtures em
 * tests/fixtures/sites/.
 */
export function analyzeSite(html: string, pageUrl: string): SiteAnalysis {
  const $ = cheerio.load(html)

  // Scripts e comentarios sao removidos APENAS da extracao de texto. As assinaturas
  // rodam no HTML cru justamente porque o que as prova esta no src dos scripts.
  const haystack = html.toLowerCase()

  const chat = matchSignature(haystack, CHAT_WIDGETS)
  const waWidget = matchSignature(haystack, WHATSAPP_WIDGETS)
  const ecommerce = matchSignature(haystack, ECOMMERCE_PLATFORMS)
  const builder = matchSignature(haystack, SITE_BUILDERS)

  const payments: string[] = []
  for (const provider of PAYMENT_PROVIDERS) {
    if (provider.needles.some((n) => haystack.includes(n))) payments.push(provider.name)
  }

  const { whatsappNumbers, instagramUrl, facebookUrl } = collectLinks($, pageUrl)

  $('script, style, noscript, svg').remove()
  const text = squish($('body').text())
  const title = squish($('title').first().text()) || null
  const metaDescription = squish($('meta[name="description"]').attr('content') ?? '') || null

  const phones = extractBrazilPhones(text).map((p) => p.e164)
  const emails = collectEmails(html, text)

  const signals: DetectedSignal[] = []
  if (chat) {
    signals.push({
      key: 'chat_widget',
      value: chat.name,
      confidence: 1,
      evidence: evidenceAround(haystack, chat.needle),
    })
  }
  if (waWidget) {
    signals.push({
      key: 'botao_whatsapp',
      value: waWidget.name,
      confidence: 0.9,
      evidence: evidenceAround(haystack, waWidget.needle),
    })
  }
  if (ecommerce) {
    signals.push({
      key: 'plataforma_ecommerce',
      value: ecommerce.name,
      confidence: 1,
      evidence: evidenceAround(haystack, ecommerce.needle),
    })
  }
  if (builder && !ecommerce) {
    signals.push({
      key: 'construtor_de_site',
      value: builder.name,
      confidence: 0.9,
      evidence: evidenceAround(haystack, builder.needle),
    })
  }
  if (payments.length > 0) {
    signals.push({
      key: 'meios_pagamento',
      value: payments.join(','),
      confidence: 0.8,
      evidence: null,
    })
  }
  if (whatsappNumbers.length > 0) {
    signals.push({
      key: 'whatsapp_no_site',
      value: whatsappNumbers[0] ?? null,
      confidence: 1,
      evidence: whatsappNumbers.join(' '),
    })
  }
  if (!chat && (whatsappNumbers.length > 0 || waWidget)) {
    // O sinal que define um alvo bom: canal de atendimento presente, nenhuma
    // automacao por tras dele.
    signals.push({
      key: 'atendimento_manual_provavel',
      value: 'whatsapp sem widget de automacao',
      confidence: 0.75,
      evidence: null,
    })
  }

  return {
    chatWidget: chat?.name ?? null,
    siteBuilder: builder?.name ?? null,
    whatsappWidget: waWidget?.name ?? null,
    ecommercePlatform: ecommerce?.name ?? null,
    paymentProviders: payments,
    whatsappNumbers,
    phones,
    emails,
    instagramUrl,
    facebookUrl,
    text,
    title,
    metaDescription,
    signals,
  }
}

/**
 * Numero de WhatsApp e redes sociais a partir dos links da pagina.
 *
 * O numero do `wa.me` tem prioridade sobre o telefone do Google Maps em toda a
 * pipeline, e a razao e pratica: o telefone do Maps costuma ser o fixo comercial,
 * enquanto o `wa.me` e, por construcao, o numero que de fato atende no WhatsApp.
 */
function collectLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): { whatsappNumbers: string[]; instagramUrl: string | null; facebookUrl: string | null } {
  const whatsapp = new Set<string>()
  let instagramUrl: string | null = null
  let facebookUrl: string | null = null

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href')
    if (!raw) return
    const href = absolutize(raw, pageUrl) ?? raw
    const domain = extractDomain(href)

    if (domain === 'wa.me' || domain === 'api.whatsapp.com' || domain === 'web.whatsapp.com') {
      // wa.me/5561999998888  |  api.whatsapp.com/send?phone=5561999998888
      const digits = href.match(/(?:phone=|wa\.me\/)(\+?\d{10,15})/)?.[1]
      const parsed = digits ? extractBrazilPhones(digits) : []
      for (const phone of parsed) whatsapp.add(phone.e164)
      return
    }
    if (!instagramUrl && domain === 'instagram.com') {
      // Descarta link para post ou para a home do Instagram: interessa o perfil.
      const path = new URL(href).pathname.replace(/^\/+|\/+$/g, '')
      if (path !== '' && !path.startsWith('p/') && !path.startsWith('reel/')) {
        instagramUrl = stripTracking(href)
      }
      return
    }
    if (!facebookUrl && domain === 'facebook.com') {
      const path = new URL(href).pathname.replace(/^\/+|\/+$/g, '')
      if (path !== '' && !path.startsWith('sharer')) facebookUrl = stripTracking(href)
    }
  })

  return { whatsappNumbers: [...whatsapp], instagramUrl, facebookUrl }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/** Enderecos de e-mail que sao infraestrutura do site, nao contato da empresa. */
const EMAIL_NOISE = /(sentry|example|dominio|seudominio|yourdomain|noreply|no-reply|wordpress|sentry\.io)/i

function collectEmails(html: string, text: string): string[] {
  const found = new Set<string>()
  for (const source of [html, text]) {
    for (const match of source.match(EMAIL_RE) ?? []) {
      const email = match.toLowerCase()
      if (!EMAIL_NOISE.test(email) && !email.endsWith('.png') && !email.endsWith('.jpg')) {
        found.add(email)
      }
    }
  }
  return [...found].slice(0, 5)
}
