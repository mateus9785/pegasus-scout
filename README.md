# pegasus-scout — Etapa 1 do Projeto Pegasus

Robô de prospecção. Mapeia empresas de um nicho numa cidade, lê o site de cada uma,
descobre **como o atendimento delas funciona hoje** e devolve um ranking com o que
vender para cada uma.

Custo: **zero**. Sem API paga. O Google Maps é lido com Playwright, o geocoding usa
o OpenStreetMap, e a análise das páginas roda no CLI `claude` como subprocesso — na
sua assinatura, do mesmo jeito que o `chatbot_7m` faz.

## O que esta etapa entrega — e o que ela não entrega

**Entrega:** a lista de empresas que provavelmente atendem à mão, ordenada, com o
telefone de WhatsApp de cada uma, o que ela vende, o porte, e um gancho de abordagem
específico.

**Não entrega:** a confirmação de que o atendimento é humano e lento. Medir tempo de
resposta exige mandar mensagem, e **nada nesta etapa envia mensagem para ninguém**.
Por isso o veredito é `provavelmente_manual`, nunca `manual`. Confirmar é trabalho da
Etapa 2.

O que substitui a medição é um conjunto de sinais públicos:

| Sinal | Lê como |
|---|---|
| Widget de chat no site (Tawk, JivoChat, Crisp, Blip, Zenvia, Intercom…) | **já automatizada → descartar** |
| `wa.me` ou botão flutuante de WhatsApp, sem widget | atendimento manual — **alvo bom** |
| Plataforma de e-commerce (NuvemShop, Shopify, VTEX, Tray, Woo…) | tem ERP, estoque e frete para integrar — **alvo ótimo** |
| Site anunciado no Maps mas fora do ar | maturidade digital baixa — **vende site novo junto** |
| Sem site nenhum, só Maps | presença digital do zero |
| Muitas avaliações no Maps | volume de clientes → dor de atendimento real |
| DDD do contato de outro estado | é a central da rede, não a loja — **descartar** |

## Instalação

```bash
# 1. Banco (o mesmo do artificialstudio)
cd ../artificialstudio && docker compose up -d
cd backend && npm install && npm run migrate    # cria as tabelas scout_*

# 2. Este projeto
cd ../../pegasus-scout
npm install
npx playwright install chromium
cp .env.example .env      # preencha SCOUT_NOMINATIM_EMAIL com um e-mail seu

# 3. Diagnóstico
npm run scout -- doctor
```

> Se o `.env` do `artificialstudio/backend` aponta para outra porta de MySQL, rode a
> migração com override: `DB_PORT=3307 npm run migrate`.

## Uso

```bash
# Login uma única vez (abre o navegador visível; só guarda o consentimento de cookies)
npm run scout -- login maps

# A Etapa 1 inteira
npm run scout -- run --niche "pet shop" --city "Brasilia" --state DF \
                     --radius-km 5 --max 60 --with-llm

# Ou estágio por estágio
npm run scout -- discover --niche "otica" --city "Goiania" --state GO --radius-km 8
npm run scout -- enrich --with-llm
npm run scout -- score
npm run scout -- report --top 20        # → tests/reports/prospeccao-<data>.md
```

Nada de nicho, cidade ou raio está fixo no código — tudo entra por parâmetro.

### Comandos

| Comando | O que faz |
|---|---|
| `doctor` | Ambiente, conexão com o MySQL, tabelas, sessões de navegador |
| `login <alvo>` | Abre navegador visível para você logar uma vez (`maps`, `whatsapp`, `instagram`, `facebook`) |
| `check:selectors` | **Canário do scraper.** Prova que os seletores do Maps ainda casam |
| `discover` | Mapeia empresas no Google Maps |
| `enrich` | Lê o site de cada empresa e detecta o atendimento (`--with-llm` para a análise) |
| `score` | Pontua de 0 a 100 e classifica a oportunidade |
| `report` | Markdown com o top N e o motivo de cada nota |
| `run` | `discover` → `enrich` → `score` em sequência |

Todo comando aceita `--help`.

## Idempotência

Rodar duas vezes o mesmo `discover` **não duplica nada**: cada empresa tem uma chave
natural (`ftid` do Google, ou nome + coordenada arredondada). O segundo run atualiza o
que mudou e marca `last_seen_at`. Verificado: 12 empresas, 2 buscas, 24 ligações N:M,
12 chaves únicas.

Campo que já tem valor bom nunca é sobrescrito por `NULL` — se o painel do Maps não
mostrou o telefone nesta passada, o telefone da passada anterior permanece.

## Arquitetura em uma frase por decisão

**O Playwright navega, funções puras parseiam.** O driver devolve `innerHTML` como
string e todo parsing é função pura com `cheerio`. É isso que permite os parsers terem
teste de verdade contra HTML real salvo em `tests/fixtures/maps/`, sem rede — e permite
trocar o Maps pela Places API depois implementando a mesma interface (`MapsPage`).

**Determinístico onde é fato, LLM onde é juízo.** "O site carrega `embed.tawk.to`" é
binário, grátis e testável — fica em tabela de assinatura. "O que essa empresa vende,
qual a dor dela, qual o gancho" é interpretação — vai para o CLI `claude`. Pedir o
primeiro ao modelo seria pior; tentar o segundo com regex seria impossível.

**O banco é o estado.** Cada estágio grava assim que lê. Um Ctrl+C no meio de uma
varredura de 40 minutos preserva tudo que já foi feito, e rodar de novo continua.

**O score é determinístico e versionado.** Ele decide a ordem de abordagem, e essa
decisão precisa ser auditável — cada nota vem com a lista de motivos e pesos. Um modelo
daria uma opinião que muda entre chamadas.

## O sinal que não pode errar

Um widget de chat detectado derruba o score em 70 pontos e marca a empresa como
descartada. É deliberadamente desproporcional: abordar quem **já tem** automação
dizendo "vi que você atende manualmente" queima a empresa e o remetente. Melhor perder
um alvo duvidoso que errar esse.

Por isso os detectores procuram tanto o `src` do script quanto a variável global que o
snippet cria (`$crisp`, `Tawk_API`, `fcWidget`…): a instalação mais comum injeta o
script em runtime, e nesse caso a URL do CDN não aparece no HTML servido.

## Testes

```bash
npm run verify     # typecheck + lint + unit + integração
```

- **`tests/unit/`** — 131 testes, sem rede e sem banco, rodam em ~1s. Cobrem os
  parsers do Maps **contra HTML real capturado**, os detectores, normalização de
  telefone E.164 (nono dígito, DDD por UF, 0800), tiling geográfico e o scoring.
- **`tests/integration/`** — 21 testes contra o MySQL do docker, num banco separado
  (`artificialcode_test`) criado a partir do **mesmo `schema.sql`** do
  artificialstudio. O banco de trabalho nunca é tocado.
- **`check:selectors`** — o driver do Playwright é a única parte sem teste
  automatizado, porque depende do DOM do Google. Este comando é o substituto: falha
  cedo e com mensagem clara quando o layout mudar, em vez de gravar 40 registros
  vazios.

Para recapturar as fixtures depois de uma mudança no Maps:

```bash
npx tsx scripts/capture-fixtures.ts "pet shop" "Brasilia" DF
```

## Riscos reais

1. **Scraping do Google Maps viola os Termos de Serviço do Google.** Pode levar a
   CAPTCHA em loop e bloqueio de IP. O que o projeto faz para reduzir: perfil de
   navegador persistido, delays aleatórios entre ações, scroll gradual, um tile por
   vez, teto de resultados por run, imagens e fontes bloqueadas. Não elimina o risco.
   O plugue para a Places API oficial está isolado atrás de `src/discovery/mapsPage.ts`.

2. **LGPD.** A coleta é de dado comercial publicado pela própria empresa, o que tem
   base legal razoável em prospecção B2B, mas exige registrar a origem de cada dado
   (é o que `scout_prospect_signals.evidence` faz) e honrar opt-out (é o que
   `scout_blocklist` faz). O ponto sensível de verdade é o **envio**, que é Etapa 2.

3. **Os seletores do Maps quebram sem aviso.** Concentrados em
   `src/discovery/selectors.ts`, com cascata de fallback e `check:selectors` como
   canário.

4. **O veredito é probabilístico.** Não mede tempo de resposta. `score_version` está
   gravado em cada empresa para você recalibrar os pesos e reprocessar o histórico.

## Ganchos para as próximas etapas

Já previstos no schema, sem tabela nova:

- **Etapa 2** — `scout_prospects.pipeline_status = 'em_atendimento'`, e
  `scout_prospect_briefs.gancho_abordagem` é a personalização da mensagem. A
  `scout_blocklist` já existe para ser consultada antes de qualquer envio, e as
  tabelas `scout_whatsapp_checks` / colunas `social_*` estão criadas mas ainda não
  usadas.
- **Etapa 3** — `ALTER TABLE scout_prospects ADD COLUMN kanban_card_id INT NULL` no
  fim do `schema.sql`, seguindo o padrão idempotente do arquivo.
