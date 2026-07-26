/**
 * Dominios que o Google Maps devolve no campo "site" mas que NAO sao o site da
 * empresa -- sao a presenca dela numa plataforma de terceiro. Enriquecer esses
 * dominios seria enriquecer o Instagram, nao o negocio, e pior: o detector de
 * widget de chat acharia o widget da plataforma e classificaria a empresa como
 * "ja automatizada" por engano.
 */
const NOT_OWN_SITE = [
  // Redes sociais
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'tiktok.com',

  // Mensageria
  'wa.me',
  'api.whatsapp.com',
  'whatsapp.com',
  'm.me',

  // Sites gerados pelo proprio Google / Meta
  'business.site',
  'negocio.site',
  'google.com',
  'goo.gl',
  'maps.app.goo.gl',

  // Agregadores link-in-bio. Encontrados na varredura real de Brasilia: uma pet
  // shop tinha `linkr.bio` no campo de site do Maps, e sem esta entrada o
  // enrichment iria analisar a pagina do agregador -- achando o widget de chat
  // DELE e concluindo que a empresa ja tem atendimento automatizado.
  'linktr.ee',
  'linkr.bio',
  'bio.link',
  'lnk.bio',
  'beacons.ai',
  'campsite.bio',
  'linklist.bio',
  'taplink.cc',
  'solo.to',
  'znap.link',
  'milkshake.app',
  'about.me',

  // Marketplaces e delivery: a presenca da empresa la nao e site dela
  'ifood.com.br',
  'rappi.com.br',
  'aiqfome.com',
  'mercadolivre.com.br',
  'elo7.com.br',
  'olx.com.br',
  'doctoralia.com.br',
  'booksy.com',
  'trinks.com',
]

export function parseUrlSafe(value: string | null | undefined): URL | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  try {
    return new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
}

/**
 * Um hostname plausivel: rotulos separados por ponto, com pelo menos um ponto e um
 * sufixo de 2+ letras.
 *
 * Existe porque `new URL('https://' + x)` aceita qualquer palavra como hostname.
 * O campo "site" do Google Maps as vezes vem com texto que a empresa digitou
 * errado ("consulte", "em breve"), e sem esta checagem o enrichment sairia
 * tentando resolver DNS de "consulte" e marcando o prospect como falha de rede.
 */
const PLAUSIBLE_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/

/** Host sem `www.`, em minusculas. Null se nao for um dominio plausivel. */
export function extractDomain(value: string | null | undefined): string | null {
  const url = parseUrlSafe(value)
  if (!url) return null

  const hostname = url.hostname.replace(/^www\./, '').toLowerCase()
  if (!PLAUSIBLE_HOSTNAME.test(hostname)) return null
  return hostname
}

export function isOwnWebsite(value: string | null | undefined): boolean {
  const domain = extractDomain(value)
  if (!domain) return false
  return !NOT_OWN_SITE.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/** Resolve href relativo contra a pagina onde apareceu. */
export function absolutize(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return null
  }
}

/** Descarta query e fragmento -- eles carregam rastreio (utm, fbclid) e nao identidade. */
export function stripTracking(value: string): string {
  const url = parseUrlSafe(value)
  if (!url) return value
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
