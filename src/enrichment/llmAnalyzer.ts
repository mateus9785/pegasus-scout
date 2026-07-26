import { execFile } from 'node:child_process'
import { z } from 'zod'
import { childLogger } from '../logger/logger.js'
import { ScoutError } from '../errors.js'

const log = childLogger({ mod: 'llm' })

/**
 * Analise interpretativa do site da empresa, via subprocesso do CLI `claude`.
 *
 * Mesmo mecanismo do chatbot_7m (`execFile('claude', ...)`) e pela mesma razao:
 * roda na assinatura do Claude Code em vez de faturar por token numa API. Foi
 * requisito explicito -- "use igual e usado em chatbot_7m, nao use a api".
 *
 * Divisao de trabalho com os detectores de detectors.ts, que e o ponto do desenho:
 *
 *   deterministico  ->  fatos binarios e exatos: o site carrega embed.tawk.to?
 *                       tem wa.me? roda NuvemShop? (gratis, instantaneo, testavel)
 *   LLM             ->  juizo: o que essa empresa vende, que volume de catalogo
 *                       ela tem, qual a dor de atendimento, que integracao propor
 *
 * Pedir o primeiro grupo ao modelo seria mais lento e menos confiavel. Tentar o
 * segundo com regex seria impossivel.
 *
 * E opt-in (`--with-llm`) para o pipeline continuar deterministico e testavel sem
 * depender de subprocesso.
 */

/**
 * Prefixo SCOUT_ nao e enfeite. O processo que roda este projeto pode ja ter
 * CLAUDE_MODEL/CLAUDE_EFFORT no ambiente (o proprio Claude Code exporta), e o
 * dotenv nao sobrescreve variavel existente -- entao `CLAUDE_MODEL` no .env seria
 * silenciosamente ignorada. Foi a mesma armadilha documentada no chatbot_7m.
 */
const MODEL = process.env['SCOUT_CLAUDE_MODEL'] ?? 'claude-sonnet-5'
const FALLBACK_MODEL = process.env['SCOUT_CLAUDE_FALLBACK_MODEL'] ?? 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = Number(process.env['SCOUT_CLAUDE_TIMEOUT_MS'] ?? 180_000)

/** Teto de texto enviado. Site grande nao melhora a analise, so gasta contexto. */
const MAX_TEXT_CHARS = 12_000

/**
 * Corta em vez de rejeitar.
 *
 * A primeira versao usava `.max()`, e o resultado na varredura real foi perder 2 de
 * 3 analises porque um item de `dores_de_atendimento` veio com 170 caracteres em vez
 * de 160. Descartar uma analise inteira, boa, por causa de um limite que eu mesmo
 * escolhi arbitrariamente e a politica errada -- os limites existem para caber na
 * coluna do banco, nao para julgar a resposta.
 */
const clipped = (max: number) => z.string().transform((s) => s.trim().slice(0, max))
const clippedList = (maxItems: number, maxChars: number) =>
  z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .transform((items) =>
      items.slice(0, maxItems).map((i) => String(i).trim().slice(0, maxChars)).filter(Boolean),
    )

/**
 * Enum tolerante: valor fora da lista cai em `indefinido` em vez de invalidar tudo.
 * O modelo as vezes responde "muito pequeno" onde se pediu "micro".
 */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z
    .unknown()
    .transform((v) => {
      const normalized = String(v ?? '').trim().toLowerCase()
      return (values as readonly string[]).includes(normalized) ? normalized : fallback
    })
    .pipe(z.enum(values))

const CATALOGO = ['nenhum', 'pequeno', 'medio', 'grande', 'indefinido'] as const
const PORTE = ['mei', 'micro', 'pequeno', 'medio', 'grande', 'indefinido'] as const

const analysisSchema = z.object({
  segmento: clipped(120),
  vende: clippedList(12, 80),
  catalogo: looseEnum(CATALOGO, 'indefinido'),
  vende_online: z.coerce.boolean(),
  atende_por_whatsapp: z.coerce.boolean(),
  sinais_de_automacao: clippedList(8, 120),
  dores_de_atendimento: clippedList(6, 160),
  integracoes_uteis: clippedList(8, 80),
  porte_estimado: looseEnum(PORTE, 'indefinido'),
  resumo: clipped(600),
  gancho_abordagem: clipped(400),
  // Confianca fora de faixa e arredondada, nao rejeitada.
  confianca: z.coerce.number().catch(0.5).transform((n) => Math.min(1, Math.max(0, n))),
})

export type LlmAnalysis = z.infer<typeof analysisSchema>

export type AnalyzeInput = {
  name: string
  category: string | null
  city: string | null
  website: string | null
  title: string | null
  metaDescription: string | null
  text: string
  /** Fatos que os detectores ja provaram. Evita o modelo "adivinhar" o que se sabe. */
  detected: {
    chatWidget: string | null
    ecommercePlatform: string | null
    paymentProviders: string[]
    hasWhatsappLink: boolean
  }
}

function buildPrompt(input: AnalyzeInput): string {
  const fatos = [
    input.detected.chatWidget
      ? `- Widget de chat detectado no site: ${input.detected.chatWidget}`
      : '- Nenhum widget de chat automatizado detectado no site',
    input.detected.ecommercePlatform
      ? `- Plataforma de e-commerce: ${input.detected.ecommercePlatform}`
      : '- Nenhuma plataforma de e-commerce detectada',
    input.detected.paymentProviders.length > 0
      ? `- Meios de pagamento no site: ${input.detected.paymentProviders.join(', ')}`
      : '- Nenhum meio de pagamento detectado no site',
    input.detected.hasWhatsappLink
      ? '- O site tem link direto de WhatsApp'
      : '- O site nao tem link de WhatsApp',
  ].join('\n')

  return `Voce esta analisando o site de uma empresa para uma prospeccao B2B de automacao de atendimento. Responda APENAS com um objeto JSON, sem cercas de codigo e sem texto antes ou depois.

EMPRESA
Nome: ${input.name}
Categoria no Google Maps: ${input.category ?? 'nao informada'}
Cidade: ${input.city ?? 'nao informada'}
Site: ${input.website ?? 'nao informado'}
Title da pagina: ${input.title ?? 'nao informado'}
Meta description: ${input.metaDescription ?? 'nao informada'}

FATOS JA VERIFICADOS AUTOMATICAMENTE (nao contradiga, use como base)
${fatos}

TEXTO EXTRAIDO DO SITE
${input.text.slice(0, MAX_TEXT_CHARS)}

FORMATO DA RESPOSTA
{
  "segmento": "o que a empresa e, em poucas palavras",
  "vende": ["produtos ou servicos principais"],
  "catalogo": "nenhum | pequeno | medio | grande | indefinido",
  "vende_online": true,
  "atende_por_whatsapp": true,
  "sinais_de_automacao": ["evidencias no texto de que o atendimento ja e automatizado"],
  "dores_de_atendimento": ["problemas de atendimento que o texto do site sugere"],
  "integracoes_uteis": ["integracoes que fariam sentido: ERP, meio de pagamento, calculo de frete, estoque"],
  "porte_estimado": "mei | micro | pequeno | medio | grande | indefinido",
  "resumo": "2 a 3 frases sobre o negocio, uteis para personalizar uma abordagem",
  "gancho_abordagem": "o angulo mais promissor para abordar essa empresa, citando algo especifico dela",
  "confianca": 0.8
}

REGRAS
- Use "indefinido" e listas vazias quando o texto nao permitir concluir. Nao invente.
- "confianca" reflete quanto o texto do site sustentou a analise. Site quase sem texto = confianca baixa.
- Escreva em portugues do Brasil.
- Nao use ferramentas. Toda a informacao necessaria esta acima.`
}

/** Envelope do `claude -p --output-format json`. */
type ClaudeJsonEnvelope = { result?: unknown; is_error?: boolean; subtype?: string }

function runClaude(prompt: string): Promise<string> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--model',
    MODEL,
    '--fallback-model',
    FALLBACK_MODEL,
    // A analise e sobre texto que ja esta no prompt: nenhuma ferramenta e
    // necessaria. Bloquear todas evita que o subprocesso pare esperando permissao
    // e fique pendurado ate o timeout.
    '--disallowed-tools',
    'Bash,Read,Write,Edit,WebFetch,WebSearch,Glob,Grep',
  ]

  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      args,
      { maxBuffer: 10 * 1024 * 1024, timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: string | number }).code
          if (code === 'ENOENT') {
            reject(
              new ScoutError(
                'O CLI `claude` nao esta no PATH.',
                'Instale o Claude Code, ou rode o enrich sem --with-llm.',
              ),
            )
            return
          }
          reject(new Error(`claude falhou (${String(code)}): ${stderr || err.message}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * Extrai o JSON da resposta.
 *
 * Duas camadas de tolerancia, ambas por comportamento observado de LLM: o envelope
 * do CLI traz o texto em `result`, e esse texto as vezes vem embrulhado em cerca de
 * codigo apesar da instrucao. Recortar do primeiro `{` ao ultimo `}` resolve os dois.
 */
export function extractJson(stdout: string): unknown {
  let payload: string = stdout

  try {
    const envelope = JSON.parse(stdout) as ClaudeJsonEnvelope
    if (typeof envelope.result === 'string') payload = envelope.result
    else if (envelope.result !== undefined) return envelope.result
  } catch {
    // stdout nao era o envelope: segue tentando como texto solto.
  }

  const start = payload.indexOf('{')
  const end = payload.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error(`resposta do claude nao contem JSON: ${payload.slice(0, 200)}`)
  }
  return JSON.parse(payload.slice(start, end + 1))
}

/**
 * Instrucao extra da segunda tentativa.
 *
 * Existe porque na varredura real uma resposta veio com JSON sintaticamente
 * invalido na posicao 1797 -- aspas nao escapadas dentro de uma string longa. Uma
 * retentativa com o lembrete resolve isso na maioria dos casos, e e muito mais
 * barato que perder a analise da empresa.
 */
const RETRY_REMINDER = `
ATENCAO: a resposta anterior nao era um JSON valido. Responda SOMENTE com o objeto JSON.
Escape aspas duplas dentro de strings. Nao use quebra de linha dentro de string.
Mantenha cada item de lista curto, com no maximo 150 caracteres.`

export async function analyzeWithLlm(input: AnalyzeInput): Promise<LlmAnalysis> {
  const prompt = buildPrompt(input)
  let ultimoErro: unknown = null

  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    log.debug({ empresa: input.name, tentativa }, 'chamando o CLI claude')
    const stdout = await runClaude(tentativa === 1 ? prompt : prompt + RETRY_REMINDER)

    try {
      const parsed = analysisSchema.safeParse(extractJson(stdout))
      if (parsed.success) return parsed.data

      ultimoErro = new Error(
        `a analise nao casou com o formato esperado: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      )
    } catch (err) {
      ultimoErro = err
    }

    if (tentativa === 1) {
      log.debug({ empresa: input.name, erro: String(ultimoErro) }, 'primeira tentativa invalida, repetindo')
    }
  }

  throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro))
}

export const LLM_ANALYZER_VERSION = 'llm-v1'
export const LLM_MODEL = MODEL
