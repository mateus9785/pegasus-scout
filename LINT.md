# Regras de lint desligadas, e por que

O `.oxlintrc.json` nao aceita comentario, entao a justificativa fica aqui.

## `no-await-in-loop`

A regra sugere trocar `for (const x of xs) await f(x)` por `Promise.all`. Neste
projeto isso seria **o bug**, nao a correcao.

Praticamente todo `await` em laco aqui existe para ser sequencial:

- `src/browser/humanize.ts` — rola o painel do Maps em passos com pausa aleatoria
  entre eles. Em paralelo nao existe: e a mesma pagina, e a pausa e o ponto.
- `src/discovery/discoveryService.ts` — varre um tile por vez e grava um prospect
  por vez. Paralelizar significaria abrir dezenas de fichas do Google
  simultaneamente, que e o padrao de trafego que leva a CAPTCHA em loop.
- `src/discovery/geocoder.ts` — a politica de uso do Nominatim limita a 1
  requisicao por segundo.
- `src/social/*` e `src/whatsapp/*` — usam as contas pessoais do usuario. Rajada
  paralela na Meta e o caminho mais curto para bloqueio de acoes.
- `tests/helpers/globalSetup.ts` — aplica statements de DDL, que tem ordem.
- `src/db/repositories/signalRepo.ts` — grava sinais em sequencia para manter o log
  legivel e a ordem de escrita previsivel no teste.

## `no-map-spread`

Aponta `map((t) => ({ ...t, index }))` em `src/discovery/tiling.ts` como
ineficiente. O array tem no maximo algumas dezenas de tiles, e a alternativa
sugerida (mutar em vez de copiar) troca clareza por um ganho irrelevante.
