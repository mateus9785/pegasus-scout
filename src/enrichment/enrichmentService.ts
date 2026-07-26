import type { Queryable } from '../types/domain.js'
import type { ProspectRow } from '../db/repositories/prospectRepo.js'
import { findPendingForStage, patchProspect, setStageStatus } from '../db/repositories/prospectRepo.js'
import { clearStageSignals, upsertSignal } from '../db/repositories/signalRepo.js'
import { upsertBrief, hasBrief } from '../db/repositories/briefRepo.js'
import { isBlocked } from '../db/repositories/blocklistRepo.js'
import { fetchSite } from './siteFetcher.js'
import { analyzeWithLlm, LLM_ANALYZER_VERSION, LLM_MODEL } from './llmAnalyzer.js'
import { parseBrazilPhone } from '../utils/phone.js'
import { extractDomain } from '../utils/url.js'
import { humanPause } from '../browser/humanize.js'
import { childLogger } from '../logger/logger.js'
import { FetchError } from '../errors.js'
import { isDefinitiveFailure } from './httpClient.js'
import { renderPageText, MIN_TEXT_CHARS, closeRenderer } from './renderedText.js'
import { isOwnWebsite } from '../utils/url.js'

const log = childLogger({ stage: 'enrichment' })

export type EnrichOptions = {
  limit: number
  retryFailed: boolean
  withLlm: boolean
  /** Regera o brief mesmo quando ja existe um desta versao. */
  forceLlm: boolean
}

export type EnrichSummary = {
  processados: number
  ok: number
  falhas: number
  bloqueados: number
  comWidgetChat: number
  comWhatsapp: number
  comEcommerce: number
  briefs: number
  falhasLlm: number
  /** Dominio que nao resolve mais. Nao e falha do robo -- e sinal de prospeccao. */
  siteForaDoAr: number
  /** Site do Maps era plataforma de terceiro, descoberto na revalidacao. */
  semSiteProprio: number
}

/**
 * Enriquece os prospects pendentes que tem site.
 *
 * Uma falha nunca interrompe o lote: site fora do ar, dominio expirado e certificado
 * invalido sao a norma em comercio pequeno, nao a excecao. Cada falha marca o
 * prospect como `failed` (recuperavel com --retry-failed) e o loop continua.
 */
export async function runEnrichment(
  db: Queryable,
  options: EnrichOptions,
  onProgress?: (done: number, total: number, nome: string) => void,
): Promise<EnrichSummary> {
  const pending = await findPendingForStage(db, 'enrichment', options.limit, {
    retryFailed: options.retryFailed,
    includeDone: options.forceLlm,
  })

  const summary: EnrichSummary = {
    processados: 0,
    ok: 0,
    falhas: 0,
    bloqueados: 0,
    comWidgetChat: 0,
    comWhatsapp: 0,
    comEcommerce: 0,
    briefs: 0,
    falhasLlm: 0,
    siteForaDoAr: 0,
    semSiteProprio: 0,
  }

  log.info({ total: pending.length, comLlm: options.withLlm }, 'enriquecimento iniciado')

  for (const prospect of pending) {
    summary.processados += 1
    onProgress?.(summary.processados, pending.length, prospect.name)

    if (await isBlocked(db, { domain: prospect.domain })) {
      await setStageStatus(db, prospect.id, 'enrichment', 'skipped')
      summary.bloqueados += 1
      continue
    }

    try {
      await enrichOne(db, prospect, options, summary)
      summary.ok += 1
    } catch (err) {
      const motivo = err instanceof FetchError ? err.message : String(err)
      const definitiva = isDefinitiveFailure(err)

      log.warn({ id: prospect.id, nome: prospect.name, motivo, definitiva }, 'site nao pode ser lido')

      // Site que o Google Maps anuncia mas cujo dominio nao resolve mais NAO e um
      // erro do robo -- e informacao de prospeccao das boas: a empresa deixou o
      // dominio cair, o que aponta maturidade digital baixa e atendimento manual.
      // Marcar isso como `failed` prenderia o prospect fora do scoring para sempre.
      if (definitiva) {
        await upsertSignal(db, {
          prospectId: prospect.id,
          stage: 'enrichment',
          key: 'site_fora_do_ar',
          value: motivo.slice(0, 400),
          confidence: 1,
          sourceUrl: prospect.website,
        })
        await setStageStatus(db, prospect.id, 'enrichment', 'done')
        summary.siteForaDoAr += 1
        summary.ok += 1
        continue
      }

      // Falha temporaria (503, timeout): vale nova tentativa com --retry-failed.
      await setStageStatus(db, prospect.id, 'enrichment', 'failed')
      await upsertSignal(db, {
        prospectId: prospect.id,
        stage: 'enrichment',
        key: 'falha_ao_buscar_site',
        value: motivo.slice(0, 400),
        confidence: 1,
        sourceUrl: prospect.website,
      })
      summary.falhas += 1
    }

    await humanPause(0.4)
  }

  // Um navegador aberto impede o processo de terminar.
  await closeRenderer()

  log.info(summary, 'enriquecimento encerrado')
  return summary
}

async function enrichOne(
  db: Queryable,
  prospect: ProspectRow,
  options: EnrichOptions,
  summary: EnrichSummary,
): Promise<void> {
  if (!prospect.website) throw new FetchError('', 'prospect sem website')

  // Revalidacao retroativa. A lista de plataformas de terceiro em utils/url.ts
  // cresce conforme a varredura encontra casos novos (linkr.bio apareceu assim), e o
  // upsert preserva o valor antigo de proposito -- entao um website gravado antes da
  // lista crescer continuaria sendo analisado. Sem esta checagem, o detector acharia
  // o widget de chat DO AGREGADOR e descartaria um alvo bom.
  if (!isOwnWebsite(prospect.website)) {
    await patchProspect(db, prospect.id, { website: null, domain: null })
    await upsertSignal(db, {
      prospectId: prospect.id,
      stage: 'enrichment',
      key: 'site_em_plataforma_terceiro',
      value: prospect.website,
      evidence: prospect.website,
      confidence: 1,
    })
    await setStageStatus(db, prospect.id, 'enrichment', 'done')
    summary.semSiteProprio += 1
    return
  }

  await setStageStatus(db, prospect.id, 'enrichment', 'running')
  // Reprocessar sem limpar deixaria sinal de um run antigo convivendo com o novo --
  // por exemplo um `chat_widget: tawk` que a empresa ja removeu do site.
  await clearStageSignals(db, prospect.id, 'enrichment')

  const snapshot = await fetchSite(prospect.website)
  const a = snapshot.analysis

  // O wa.me do site tem prioridade sobre o telefone do Maps. O do Maps costuma ser
  // o fixo comercial; o do wa.me e, por construcao, o numero que atende no WhatsApp.
  const waFromSite = a.whatsappNumbers[0] ?? null
  const waFromMapsPhone =
    prospect.phone_e164 && parseBrazilPhone(prospect.phone_e164)?.kind === 'mobile'
      ? prospect.phone_e164
      : null
  const whatsapp = waFromSite ?? waFromMapsPhone

  await patchProspect(db, prospect.id, {
    domain: extractDomain(prospect.website),
    email: a.emails[0] ?? null,
    chatWidget: a.chatWidget,
    ecommercePlatform: a.ecommercePlatform,
    instagramUrl: a.instagramUrl,
    facebookUrl: a.facebookUrl,
    ...(whatsapp
      ? {
          whatsappPhoneE164: whatsapp,
          whatsappSource: waFromSite ? ('site_link' as const) : ('maps_phone' as const),
        }
      : {}),
  })

  for (const signal of a.signals) {
    await upsertSignal(db, {
      prospectId: prospect.id,
      stage: 'enrichment',
      key: signal.key,
      value: signal.value,
      confidence: signal.confidence,
      evidence: signal.evidence,
      sourceUrl: prospect.website,
    })
  }

  if (snapshot.blockedByRobots.length > 0) {
    await upsertSignal(db, {
      prospectId: prospect.id,
      stage: 'enrichment',
      key: 'robots_bloqueou',
      value: snapshot.blockedByRobots.join(', '),
      confidence: 1,
    })
  }

  await upsertSignal(db, {
    prospectId: prospect.id,
    stage: 'enrichment',
    key: 'paginas_lidas',
    value: String(snapshot.pages.length),
    evidence: snapshot.pages.map((p) => `${p.status} ${p.url}`).join('\n'),
  })

  if (a.chatWidget) summary.comWidgetChat += 1
  if (whatsapp) summary.comWhatsapp += 1
  if (a.ecommercePlatform) summary.comEcommerce += 1

  if (options.withLlm) {
    await runLlmBrief(db, prospect, a, summary, options)
  }

  await setStageStatus(db, prospect.id, 'enrichment', 'done')
}

/**
 * Roda a analise interpretativa.
 *
 * Falha aqui NAO reprova o enriquecimento: os sinais deterministicos ja foram
 * gravados e valem por si. Um subprocesso que estourou o timeout nao pode apagar o
 * trabalho que deu certo.
 */
async function runLlmBrief(
  db: Queryable,
  prospect: ProspectRow,
  analysis: Awaited<ReturnType<typeof fetchSite>>['analysis'],
  summary: EnrichSummary,
  options: EnrichOptions,
): Promise<void> {
  if (!options.forceLlm && (await hasBrief(db, prospect.id, LLM_ANALYZER_VERSION))) {
    log.debug({ id: prospect.id }, 'brief desta versao ja existe, pulando')
    return
  }

  let texto = analysis.text.trim()

  // Site que monta o conteudo no navegador entrega um casco vazio ao fetch HTTP.
  // Foi o que aconteceu na primeira varredura: a analise da loja do Petz voltou
  // "indefinido" em tudo, com confianca 0,05. Renderizar recupera o texto.
  if (texto.length < MIN_TEXT_CHARS && prospect.website) {
    try {
      const renderizado = await renderPageText(prospect.website)
      if (renderizado.length > texto.length) {
        log.debug(
          { id: prospect.id, antes: texto.length, depois: renderizado.length },
          'texto recuperado renderizando a pagina',
        )
        texto = renderizado
        await upsertSignal(db, {
          prospectId: prospect.id,
          stage: 'enrichment',
          key: 'site_renderizado_por_js',
          value: `${analysis.text.trim().length} -> ${renderizado.length} caracteres`,
          confidence: 1,
        })
      }
    } catch (err) {
      log.debug({ id: prospect.id, err: String(err) }, 'renderizacao falhou')
    }
  }

  // Depois de tentar renderizar: se ainda nao ha texto, gastar uma chamada para
  // receber "indefinido" em todo campo nao serve a ninguem.
  if (texto.length < 200) {
    await upsertSignal(db, {
      prospectId: prospect.id,
      stage: 'enrichment',
      key: 'llm_pulado',
      value: `site com texto insuficiente (${texto.length} caracteres)`,
      confidence: 1,
    })
    return
  }

  try {
    const brief = await analyzeWithLlm({
      name: prospect.name,
      category: null,
      city: null,
      website: prospect.website,
      title: analysis.title,
      metaDescription: analysis.metaDescription,
      text: texto,
      detected: {
        chatWidget: analysis.chatWidget,
        ecommercePlatform: analysis.ecommercePlatform,
        paymentProviders: analysis.paymentProviders,
        hasWhatsappLink: analysis.whatsappNumbers.length > 0,
      },
    })

    await upsertBrief(db, prospect.id, LLM_ANALYZER_VERSION, LLM_MODEL, brief)
    await upsertSignal(db, {
      prospectId: prospect.id,
      stage: 'enrichment',
      key: 'llm_porte',
      value: brief.porte_estimado,
      confidence: brief.confianca,
      evidence: brief.resumo,
    })
    summary.briefs += 1
    log.info({ id: prospect.id, nome: prospect.name, porte: brief.porte_estimado }, 'brief gerado')
  } catch (err) {
    summary.falhasLlm += 1
    log.warn({ id: prospect.id, err: String(err) }, 'analise por LLM falhou (sinais preservados)')
    await upsertSignal(db, {
      prospectId: prospect.id,
      stage: 'enrichment',
      key: 'llm_falhou',
      value: String(err).slice(0, 400),
      confidence: 1,
    })
  }
}
