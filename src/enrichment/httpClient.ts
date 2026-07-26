import axios from 'axios'
import type { AxiosInstance } from 'axios'
import { loadEnv } from '../config/env.js'
import { FetchError } from '../errors.js'
import { childLogger } from '../logger/logger.js'

const log = childLogger({ mod: 'http' })

/**
 * Cliente HTTP para buscar o site das empresas.
 *
 * Tres limites que existem por motivo concreto:
 *
 *  - `timeout`: site de comercio pequeno em hospedagem barata as vezes leva 30s.
 *    Esperar isso vezes 200 empresas trava a varredura. 10s e o corte.
 *  - `maxContentLength`: um "site" as vezes e um PDF de catalogo de 80MB. Sem teto,
 *    uma empresa consome a memoria do processo inteiro.
 *  - `maxRedirects`: cadeia de redirect infinita existe, e e mais comum em dominio
 *    expirado apontando para parking page.
 *
 * O User-Agent se identifica de verdade. E o oposto de camuflagem: quem administra
 * o site precisa poder ver quem passou por la e ter um caminho de contato.
 */

let client: AxiosInstance | null = null

function getClient(): AxiosInstance {
  const env = loadEnv()
  client ??= axios.create({
    timeout: env.SCOUT_HTTP_TIMEOUT_MS,
    maxContentLength: env.SCOUT_HTTP_MAX_BYTES,
    maxBodyLength: env.SCOUT_HTTP_MAX_BYTES,
    maxRedirects: 5,
    // 4xx sao respostas de negocio (404 = pagina de contato nao existe) e nao
    // falhas de rede. Deixar o axios lancar nelas faria o codigo tratar "essa
    // empresa nao tem /contato" como erro de infraestrutura.
    validateStatus: (status) => status < 500,
    headers: {
      'User-Agent': `Mozilla/5.0 (compatible; pegasus-scout/0.1; +mailto:${env.SCOUT_NOMINATIM_EMAIL || 'sem-contato'})`,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    decompress: true,
  })
  return client
}

export type FetchedPage = {
  url: string
  finalUrl: string
  status: number
  html: string
  contentType: string
}

/**
 * O corpo comeca com HTML?
 *
 * Necessario porque servidor mal configurado mente no Content-Type. Na varredura
 * real de Brasilia, uma pet shop servia a home inteira como
 * `application/xml; charset=UTF-8`, e confiar no header fez o robo descartar um
 * prospect valido. O conteudo manda mais que o cabecalho.
 */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 1_000).toLowerCase()
  return head.includes('<!doctype html') || head.includes('<html') || head.includes('<body')
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  try {
    const response = await getClient().get<string>(url, { responseType: 'text' })
    const contentType = String(response.headers['content-type'] ?? '')
    const body = typeof response.data === 'string' ? response.data : ''

    // Só HTML interessa: passar um PDF ou uma imagem para o cheerio devolveria lixo
    // que os detectores leriam como ausencia de sinal. Mas o header sozinho nao
    // decide -- o corpo tem a palavra final.
    const declaredHtml = contentType === '' || contentType.includes('html')
    if (!declaredHtml && !looksLikeHtml(body)) {
      throw new FetchError(url, `Conteudo nao e HTML (${contentType})`, response.status)
    }

    return {
      url,
      finalUrl: String(response.request?.res?.responseUrl ?? url),
      status: response.status,
      html: body,
      contentType,
    }
  } catch (err) {
    if (err instanceof FetchError) throw err

    const code = (err as { code?: string }).code
    const status = (err as { response?: { status?: number } }).response?.status
    log.debug({ url, code, status }, 'falha ao buscar pagina')
    // O status entra na mensagem: sem ele, "ERR_BAD_RESPONSE" nao diz se foi 500,
    // 503 ou corpo maior que o teto, e as tres tem tratamento diferente.
    const sufixo = status ? ` (HTTP ${status})` : ''
    throw new FetchError(url, `${code ?? 'erro'} ao buscar ${url}${sufixo}`, status)
  }
}

/**
 * Falha definitiva (o dominio nao existe) versus temporaria (servidor fora do ar,
 * timeout).
 *
 * A distincao muda o que acontece com o prospect: dominio morto e um SINAL de
 * maturidade digital baixa e o prospect segue para o scoring, enquanto 503 e ruido
 * de infraestrutura que merece nova tentativa depois.
 */
export function isDefinitiveFailure(err: unknown): boolean {
  if (!(err instanceof FetchError)) return false
  return /ENOTFOUND|ERR_INVALID_URL|EAI_AGAIN|CERT_|ERR_TLS|nao e parseavel/i.test(err.message)
}

/**
 * Verifica robots.txt antes de buscar qualquer pagina de um dominio.
 *
 * Implementacao minima e proposital: le apenas os blocos `User-agent: *` e as
 * diretivas `Disallow`. Nao cobre Allow com precedencia, crawl-delay nem
 * wildcards complexos.
 *
 * Fazer isso importa mesmo sendo "so leitura de pagina publica": e a forma
 * padronizada de o dono do site dizer o que nao quer que seja varrido, e ignorar
 * isso enfraquece qualquer argumento de boa-fe na prospeccao.
 */
export type RobotsRules = { disallowed: string[]; fetched: boolean }

const robotsCache = new Map<string, RobotsRules>()

export async function getRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin)
  if (cached) return cached

  let rules: RobotsRules = { disallowed: [], fetched: false }
  try {
    const response = await getClient().get<string>(`${origin}/robots.txt`, {
      responseType: 'text',
      headers: { Accept: 'text/plain' },
    })

    if (response.status === 200 && typeof response.data === 'string') {
      rules = { disallowed: parseRobots(response.data), fetched: true }
    }
  } catch {
    // Sem robots.txt (ou inalcancavel) significa "sem restricao declarada".
  }

  robotsCache.set(origin, rules)
  return rules
}

export function parseRobots(text: string): string[] {
  const disallowed: string[] = []
  let inWildcardBlock = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (line === '') continue

    const [rawKey, ...rest] = line.split(':')
    const key = rawKey?.trim().toLowerCase()
    const value = rest.join(':').trim()

    if (key === 'user-agent') {
      inWildcardBlock = value === '*'
      continue
    }
    if (inWildcardBlock && key === 'disallow' && value !== '') {
      disallowed.push(value)
    }
  }
  return disallowed
}

export function isAllowedByRobots(rules: RobotsRules, pathname: string): boolean {
  if (rules.disallowed.length === 0) return true
  // "Disallow: /" bloqueia tudo. Prefixo simples cobre o resto dos casos reais.
  return !rules.disallowed.some((rule) => pathname.startsWith(rule))
}

/** Usado pelos testes para nao carregar cache entre casos. */
export function resetRobotsCache(): void {
  robotsCache.clear()
}
