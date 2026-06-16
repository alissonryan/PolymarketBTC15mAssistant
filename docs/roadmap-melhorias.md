# Roadmap de Melhorias — PolymarketBTC15mAssistant

**Status:** Backlog para validação futura — **não** são tarefas de implementação imediata.
**Data:** 16 de junho de 2026
**Regra de entrada (obrigatória antes de qualquer feature ir pra produção):**
1. ≥ 100 trades por horizonte validados em paper/live, reconciliados com `logs/trades.db`
2. Teste offline completo no harness (`scripts/hf-backtest/`) — comparar com vs. sem a feature
3. Cutover JSON→SQLite concluído (~20-21 jun 2026)

---

## 1. Estado atual (jun/2026) — o que JÁ está certo

- **Fee gate (economic edge floor):** já implementado e **correto para os dois venues**.
  - `feeEdge = marketProb * 0.07 * (1 - marketProb)`
  - `economicMin = feeEdge + halfSpread + EDGE_SAFETY_MARGIN`
  - Polymarket e Kalshi usam o mesmo coeficiente `0.07` — confirmado: a taxa oficial da
    Kalshi é `round_up(0.07 × C × P × (1−P))`, idêntica à fórmula do `edge.js`.
    **Sem ação necessária.**
- **`MAX_EDGE = 0.35` e a convergência tardia do `settlementProb.js`** (P→0/1 quando t→0)
  são proteções **intencionais e corretas** — devem ser mantidas. Não relaxar.
- **Diagnóstico do edge (backtest + reconciliação live):** modelo ~61-63% de direção (não
  é moeda); o sinal vem principalmente de **momentum**, é sensível a regime.
  - **Kalshi 15m:** +24% backtest / **+37% live** (69% acerto) → mais sólido.
  - **Polymarket 5m:** +15% backtest / +10% live → positivo.
  - **Polymarket 15m:** +73% backtest (só 19 trades) / **−14% live** → ambíguo.

---

## 2. Trilhas mapeadas (backlog, por prioridade)

### Kalshi — Prioridade #1 (edge comprovado em live)
- **Foco:** modelar melhor a janela de **média de 60s do BRTI** (CF Benchmarks RTI) no
  fechamento vs. abertura — a Kalshi NÃO liquida por Chainlink, então a trilha de
  oracle-gap do Polymarket **não se aplica** aqui.
- **Complementar:** order-flow de curto prazo (CVD melhorado, OFI/microprice da
  profundidade L2 da Binance, desequilíbrio de book).
- **Por quê:** é onde o edge líquido aparece de verdade (+37% live).

### Polymarket — Prioridade #2 (upside incerto)
- **Foco:** modelar o **oracle-gap** (Chainlink vs. spot da Binance).
- **Implementação futura possível:** `settle_spot = oracle + κ · EMA(binance − oracle)`
  alimentando o `d = spot − strike` do diffusion model, atrás de um flag.
- **Ressalva:** mercado mais eficiente + taxa dinâmica; o modelo já é ~tão bom quanto o
  mercado lá. Só avaliar **depois** de validar o edge atual.

### Transversais — Prioridade baixa
- **Volatilidade Yang-Zhang / Garman-Klass** no lugar do close-to-close em
  `estimateSigmaPerSqrtMin` (σ mais eficiente em janelas curtas). **Menor risco — primeira
  a testar.**
- Mais features de microestrutura no regime detection.
- Feeds de derivativos (funding, OI, liquidações) como input de vol/regime — não direção.

---

## 3. Decisões tomadas

- **NÃO implementar agora:** `settle_spot`, late-sniper, relaxar edge no fim da janela,
  forçar entrada em mispricing grande (todos contrariam o design atual ou não têm
  validação).
- **Manter:** `MAX_EDGE`, convergência tardia do diffusion, fee gate atual.
- **Ação imediata:** deixar os bots acumularem trades até o cutover e revalidar.

---

## 4. Próxima ação real

Esperar o acúmulo de trades + cutover (~20-21 jun) → **re-rodar o harness de backtest com
dados novos + reconciliar com `trades.db`**. Se Kalshi e/ou 5m confirmarem com ≥100 trades,
abrir a avaliação das trilhas **uma de cada vez, testada no backtest antes de promover** —
começando pela Yang-Zhang (menor risco), depois a trilha Kalshi (order-flow/BRTI), e o
`settle_spot` do Polymarket por último.

*Backlog — referência para quando chegar o momento de avaliar melhorias. Nada aqui é
autorização de implementação.*
