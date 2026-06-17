# Design — Execução real de ordens no Kalshi (BTC 15m)

**Data:** 2026-06-17
**Status:** Aprovado (aguardando implementação)
**Escopo:** Adicionar execução de ordens reais no Kalshi ao bot que hoje é paper-only,
atrás de flags, validado primeiro no ambiente demo.

## Contexto

Hoje o bot Kalshi (`src/index-kalshi.js`) é **paper-only**: lê o mercado via
`fetchKalshiSnapshot` (`src/data/kalshi.js`, autenticado com RSA-PSS via
`kalshi_private.pem`), calcula o sinal (`rec`) e chama `onPaperTick`. Não existe
nenhum código que coloque ordens.

O Kalshi é o candidato mais sólido a dinheiro real: 75 trades ao vivo em paper
(69% WR, +$55) **e** um backtest OOS independente (117 trades, 62% WR, +24%) —
dois métodos concordando. A conta do usuário está validada e pode depositar.

### Fatos verificados nesta sessão

- A chave de **produção** no repositório (`KALSHI_API_KEY_ID` + `kalshi_private.pem`)
  é **válida e tem acesso de portfolio**: `GET /portfolio/balance` → HTTP 200,
  saldo **$0.00** (sem depósito ainda).
- A mesma chave **NÃO** funciona no demo (HTTP 401 `NOT_FOUND`) → o demo exige um
  **par de credenciais separado** (outra API key + outra private key). Pré-requisito
  da fase de testes.
- `.gitignore` já cobre `*.pem` e `.env*`; nada sensível está versionado.
- `POST /portfolio/orders` usa o **mesmo** esquema de assinatura dos GETs:
  `signature = sign(timestamp + MÉTODO + path)`, **sem** o corpo da requisição.
  Logo o `kalshiHeaders("POST", path)` existente serve direto.
- Unidades da API: preço em **centavos inteiros** (`yes_price`/`no_price`, 1–99) ou
  em dólares fixed-point string (`yes_price_dollars`); quantidade em **contratos
  inteiros** (`count >= 1`); `time_in_force` aceita `fill_or_kill`,
  `immediate_or_cancel`, `good_till_canceled`.

## Princípio de segurança central

Três camadas independentes precisam estar ativas para um dólar **real** sair:

1. `EXECUTE_ORDERS=true` (default `false`) — habilita a colocação de ordens.
2. `KALSHI_DEMO` — `true` → dinheiro fake (demo); `false` → produção.
3. `KALSHI_LIVE_CONFIRM=true` — **novo flag**, exigido **somente** quando
   `KALSHI_DEMO=false`. Cinto-e-suspensório: impede que um teste demo "vire"
   produção sem um ato explícito.

**Default do repositório permanece paper-only e idêntico a hoje** (`EXECUTE_ORDERS=false`).
O `onPaperTick` continua rodando **sempre** (mesmo com ordens reais ligadas) para
fornecer a comparação real ≈ paper.

## Arquitetura

Espelha o padrão do bot Polymarket já existente (`src/execution/bot.js`,
`orders.js`, `position.js`, `wallet.js`), adaptado ao Kalshi.

| Arquivo | Responsabilidade | Análogo |
|---|---|---|
| `src/data/kalshi.js` (estender) | adicionar `kalshiPost(path, body)` assinado; exportar `kalshiGet`/`kalshiHeaders`. Única superfície de auth. | — |
| `src/execution/kalshiAccount.js` (novo) | `getBalance()`, `getPositions(ticker)`, `getFills(ticker)`, `getSettlements(ticker)` — saldo, posição e **resultado real da conta** | `wallet.js` |
| `src/execution/kalshiOrders.js` (novo) | `placeFokBuy({ ticker, side, count, limitPriceCents })` → POST FOK; parseia `fill_count_fp`, `taker_fill_cost_dollars`, `taker_fees_dollars` | `orders.js` |
| `src/execution/kalshiPosition.js` (novo) | persistência da posição real (ticker, side `yes`/`no`, count, orderId, preço/fee de entrada, balanceBefore) | `position.js` |
| `src/execution/kalshiBot.js` (novo) | orquestração `onKalshiSignal(...)` atrás das flags: init, guardas, entrada, reconciliação de liquidação, shutdown | `bot.js` |
| `src/risk/cooldown.js` (novo, refactor) | extrair `sameSideCooldownCheck` de `paperTrading.js` para módulo compartilhado; paper e real importam o mesmo | — |

### Mapeamento UP/DOWN ↔ YES/NO

A estratégia decide `side` em `UP`/`DOWN`. No Kalshi: `UP → side:"yes"`,
`DOWN → side:"no"`, sempre `action:"buy"`. (Mesma convenção já usada no display do
`index-kalshi.js`.)

## Reaproveitamento das guardas de risco (sem stake/threshold novos)

`kalshiBot.js` usa **exatamente** `src/risk/guard.js`:

- `canTrade({ openPositions, edgeBest, tokenPrice })` — `RISK_MIN_EDGE`,
  `RISK_MAX_OPEN_POSITIONS`, `RISK_MIN_TOKEN_PRICE`, janela de sessão UTC.
- `isCircuitBreakerTripped()` / `recordTrade()` — `RISK_MAX_DAILY_LOSS_USDC`
  (kill-switch diário) já se aplica à conta real.
- `sameSideCooldownCheck` (extraído para `src/risk/cooldown.js`) —
  `RISK_SAME_SIDE_REENTRY_MIN`, `RISK_LOSS_COOLDOWN_MIN`.

**Sizing** (decisão aprovada — floor, pula se <1):
`count = Math.floor(RISK_ORDER_SIZE_USDC / askDollars)`. Se `count < 1` →
`{ mode: "blocked", reason: "order_size_menor_que_1_contrato" }`. Nunca gasta acima
do stake configurado.

**Fill** (decisão aprovada — FOK no ask): ordem `time_in_force: "fill_or_kill"` com
`yes_price`/`no_price = Math.ceil(askDollars * 100)` (centavos). Preenche a
quantidade inteira ao preço esperado ou cancela — espelha o paper e o `placeFokBuy`
da Polymarket. Sem fills parciais, sem ordem pendurada no book.

## Fluxo por tick — `onKalshiSignal({ rec, snap, priceToBeat, timeLeftMin })`

1. Se `!EXECUTE_ORDERS` → `{ mode: "monitor" }` (no-op; é o default).
2. `ensureInit` (1×): valida credenciais via `getBalance`. Se `KALSHI_DEMO=false`
   exige `KALSHI_LIVE_CONFIRM=true` **e** `balance > 0`; senão `{ mode: "blocked" }`
   com motivo claro. Em demo, basta credencial válida.
3. **Posição aberta + ticker do mercado mudou** → liquidação: lê
   `getSettlements`/`getPositions` para obter o **resultado real** (won/lost + pnl
   realizado da conta), chama `recordTrade`, fecha posição local, grava o trade real
   e loga real vs. paper.
4. **Sem posição + `rec.action==="ENTER"`**: `canTrade` → `cooldown` → sizing floor →
   `placeFokBuy` FOK no ask. Se `filled`, grava posição com preço/fee **reais do fill**;
   senão `{ mode: "not_filled" }`.
5. `SIGINT`/`SIGTERM` → `emergencyShutdown` (cancela ordens abertas + fecha posição local).

## Reconciliação real ≈ paper

- A liquidação real vem da **conta** (`getSettlements`), não é inferida de
  preço-vs-strike como no paper. Esse é o ponto que diferencia execução real de paper.
- Trades reais são gravados via o `paperStore` existente (`createPaperStore`) com um
  `bot_id` próprio (`kalshi_btc_real`), então `npm run stats` compara real × paper
  lado a lado sem ferramenta nova.
- O `onPaperTick` continua rodando em paralelo, então cada janela gera tanto o
  resultado-paper quanto (quando há entrada real) o resultado-real, para a comparação.

## Testes automatizados (mock da API de ordens)

`node --test`, com `globalThis.fetch` mockado (sem rede):

- `test/kalshiOrders.test.js` — corpo correto do POST (`ticker`, `side`, `action:"buy"`,
  `count`, `yes_price`/`no_price` em centavos, `time_in_force:"fill_or_kill"`);
  parsing de fill total, fill parcial (não deve ocorrer em FOK → tratar como
  not_filled se `fill_count` < `count`) e fill zero.
- `test/kalshiAccount.test.js` — parsing de balance, positions, settlements.
- `test/kalshiBot.test.js` — gating por `EXECUTE_ORDERS` e `KALSHI_LIVE_CONFIRM`;
  bloqueio por `canTrade`/circuit-breaker/cooldown; sizing floor + skip-<1;
  reconciliação de liquidação (won e lost); `emergencyShutdown`.
- `test/kalshiAuth.test.js` — a assinatura de POST usa `ts + "POST" + path` (sem body).

## Wiring em `src/index-kalshi.js`

Após calcular `recAdapted`/`snap`, chamar `onKalshiSignal(...)` **além de**
`onPaperTick(...)`. O paper roda sempre; o real só age quando `EXECUTE_ORDERS=true`.
O display ganha uma linha de status do bot real (modo, posição real, pnl diário real)
quando `EXECUTE_ORDERS=true`; caso contrário, tela idêntica à de hoje.

## Rollout (em ordem, sem pular etapas)

1. **Pré-requisito** — gerar **API key demo** no portal demo do Kalshi (a de produção
   não serve). `.env`: credenciais demo + `KALSHI_DEMO=true`. Decisão de como
   parametrizar prod vs. demo no `.env` faz parte do plano (ver "Configuração demo/prod").
2. **Demo** — `EXECUTE_ORDERS=true KALSHI_DEMO=true`: confirmar que ordens entram,
   preenchem (FOK) e liquidam, e que real ≈ paper. **Nenhum dólar real.**
3. **Produção** — só depois do demo 100% validado: depósito $50–100,
   `KALSHI_DEMO=false` + `KALSHI_LIVE_CONFIRM=true`, stake 1–2%
   (`RISK_ORDER_SIZE_USDC`), validar real ≈ paper por 2–4 semanas antes de escalar.
4. **Kill-switch de drawdown** (-20 a -25%) — novo guard `RISK_MAX_DRAWDOWN_PCT`,
   **default desligado** até o usuário definir o número exato (é guarda de segurança,
   não threshold de estratégia). Confirmar valor antes de ligar na fase 3.

### Configuração demo/prod no `.env`

`src/data/kalshi.js` já troca `BASE_URL` por `KALSHI_DEMO`. Para credenciais separadas
sem editar `.env` toda vez, o plano adota: quando `KALSHI_DEMO=true`, ler
`KALSHI_DEMO_API_KEY_ID` / `KALSHI_DEMO_PRIVATE_KEY_PATH` se existirem (fallback para
as variáveis padrão). Assim prod e demo coexistem no `.env`.

## Fora de escopo (YAGNI)

- Ordens de saída antecipada, laddering, múltiplas posições simultâneas.
- Qualquer mudança na estratégia/scoring/calibração.
- Sell de posição — compra a entrada e segura até a liquidação automática do Kalshi,
  igual ao paper.

## Restrições / invariantes

- A chave privada **nunca** é commitada nem logada.
- Com `EXECUTE_ORDERS=false` o comportamento é byte-a-byte o de hoje.
- Nenhum stake ou threshold novo sem aprovação explícita do usuário; o sizing reusa
  `RISK_ORDER_SIZE_USDC`.
- Em produção, ordem real só com `balance > 0` **e** `KALSHI_LIVE_CONFIRM=true`.
