# pegasus-scout — convenções

Etapa 1 do Projeto Pegasus. Leia o `README.md` para o quê e o porquê. Este arquivo é
o que uma sessão futura precisa saber para não quebrar decisões que custaram caro.

## Regras que não são preferência

**Nada nesta etapa envia mensagem para ninguém.** Nem WhatsApp, nem e-mail, nem DM.
Toda a coleta é leitura de dado público. Se um pedido futuro exigir contato ativo, ele
pertence à Etapa 2 e a um projeto separado — não acrescente aqui.

**Não modifique `chatbot_7m/`.** É referência de estilo, de outro projeto.

**O DDL das tabelas `scout_*` vive em
`../artificialstudio/backend/src/db/schema.sql`.** Este projeto não duplica DDL: ele
valida a presença das tabelas por `information_schema` (`src/db/assertSchema.ts`) e
manda rodar `npm run migrate` lá. Duas definições do mesmo schema divergem em semanas.

Ao editar aquele `schema.sql`, duas restrições vêm do `migrate.js` dele:

- Ele corta o arquivo em cada `;`, **inclusive dentro de comentário**. Já quebrei a
  migração escrevendo `schema.split(';')` num comentário.
- Ele só ignora `ER_DUP_FIELDNAME`, `ER_DUP_KEYNAME`, `ER_TABLE_EXISTS_ERROR` e
  `ER_CANT_DROP_FIELD_OR_KEY`. Um `ALTER TABLE ADD CONSTRAINT FOREIGN KEY` repetido
  devolve `ER_FK_DUP_NAME`, que **não** está na lista e derruba a migração na segunda
  execução. **Toda FK inline no `CREATE TABLE`.**

## Arquitetura

**Playwright navega, função pura parseia.** Nenhum `page.$eval`. O driver
(`src/discovery/playwrightMapsPage.ts`) devolve `innerHTML` como string; o parsing é
função pura com `cheerio` (`parseFeed.ts`, `parseDetail.ts`), testada contra HTML real
em `tests/fixtures/maps/`. Se um método de `MapsPage` começar a devolver objeto de
domínio em vez de HTML, essa propriedade se perde e os parsers ficam intestáveis.

**Determinístico onde é fato, LLM onde é juízo.** `src/enrichment/detectors.ts` tem
tabelas de assinatura para o que é binário e exato. `src/enrichment/llmAnalyzer.ts`
chama o CLI `claude` para o que é interpretação. Não mova nada de um lado para o outro
sem um motivo forte.

**O banco é o estado.** Cada estágio grava assim que lê, e cada prospect tem
`<estagio>_status`. Interromper no meio não perde trabalho.

## Armadilhas já pagas

**Prefixo `SCOUT_` nas variáveis de ambiente do modelo.** `SCOUT_CLAUDE_MODEL`, não
`CLAUDE_MODEL`. O processo que roda isto pode já ter `CLAUDE_MODEL`/`CLAUDE_EFFORT` no
ambiente (o próprio Claude Code exporta), e o `dotenv` não sobrescreve variável
existente — o valor do `.env` seria silenciosamente ignorado.

**Esperar pelo seletor antes de resolvê-lo.** `resolveSelector` roda `count()`, que é
instantâneo. Chamá-lo logo após `domcontentloaded` reporta "o layout do Google mudou"
quando o layout está certo e a página só não terminou de montar. Use
`waitForAnyCandidate` primeiro. Diagnóstico errado é pior que erro nenhum.

**O separador `·` do card do Maps é um span-folha próprio.** Existem elementos cujo
texto é literalmente `"·"` e fragmentos como `"· Fecha 00:00"`. Pegar "o texto mais
curto que contém `·`" devolve lixo. `infoAndStatusLines` filtra por estrutura (2+
segmentos não vazios, não contém o nome da empresa) e não por tamanho.

**`new URL('https://' + x)` aceita qualquer palavra como hostname.** O campo "site" do
Maps às vezes traz texto que a empresa digitou ("consulte", "em breve").
`extractDomain` exige hostname plausível — sem isso o enrichment sai resolvendo DNS de
`consulte`.

**A lista de plataformas de terceiro em `src/utils/url.ts` precisa ser retroativa.**
Ela cresce conforme a varredura encontra casos novos (`linkr.bio` apareceu assim), e o
upsert preserva valor antigo de propósito. `enrichOne` revalida `isOwnWebsite` a cada
passada. Sem isso, o detector acharia o widget de chat **do agregador** e descartaria
um alvo bom.

**Truncar, não rejeitar, a resposta da LLM.** A primeira versão usava `.max()` no zod e
perdeu 2 de 3 análises boas porque um item veio com 170 caracteres em vez de 160. Os
limites existem para caber na coluna, não para julgar a resposta. Há também uma
retentativa com lembrete de escapar aspas, porque uma resposta veio com JSON inválido.

**Site fora do ar não é falha do robô — é sinal de prospecção.** Domínio que não
resolve mais vira `site_fora_do_ar`, o prospect é marcado `done` e segue para o
scoring, com a oportunidade `site_novo`. Marcar como `failed` prenderia ele fora do
ranking para sempre.

**Rede nacional não pode liderar o ranking.** Na primeira varredura real a Cobasi ficou
em 1º com 84/100 (WhatsApp + VTEX + Instagram + catálogo grande). É o pior alvo
possível: a decisão de automação de uma rede de 240 lojas não passa pela loja de
Brasília. Daí o peso `porteGrande: -45` e o sinal `contatoLocal` — DDD de outro estado
significa central corporativa, não a loja.

**`isLocalAreaCode` devolve `null`, não `false`, quando não sabe.** "Não sei" e "é de
fora" levam a decisões diferentes no scoring, e confundir os dois penalizaria toda
empresa sem telefone.

## Testes

`npm run verify` = `typecheck` + `lint` + `unit` + `integração`.

- `tests/unit/` — sem rede, sem banco, sem navegador. Se um teste daqui passar de
  segundos, está no project errado.
- `tests/integration/` — banco `DB_NAME_TEST`, criado pelo `globalSetup` a partir do
  `schema.sql` do artificialstudio. As suítes truncam tabelas: **nunca** aponte
  `DB_NAME_TEST` para o banco de trabalho (o `globalSetup` recusa se forem iguais).
- As fixtures em `tests/fixtures/` **vão para o git**. São a única forma de os testes
  rodarem sem rede, e o diff entre duas capturas mostra o que o Google mudou.
  Recapture com `npx tsx scripts/capture-fixtures.ts`.
- O driver do Playwright não tem teste automatizado, de propósito. O substituto é
  `npm run scout -- check:selectors`.

`LINT.md` explica por que `no-await-in-loop` está desligada: quase todo `await` em laço
aqui é sequencial de propósito (rate limiting, delays humanos, política do Nominatim).
Paralelizar seria o bug.

## Estilo

Camadas: `commands/` (CLI e saída para o usuário) → `<dominio>Service.ts` (orquestração)
→ `db/repositories/` (SQL) e parsers puros. Erros são classes nomeadas em `errors.ts`,
cada uma com `hint`: o que o usuário deve **fazer** para resolver. Um erro de CLI sem
instrução de conserto é um beco sem saída.

Comentário explica **por que**, não o quê — de preferência citando o sintoma real que
motivou a linha. É a convenção do `chatbot_7m` e vale mantê-la.
