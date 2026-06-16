# Parecer Técnico – PolymarketBTC15mAssistant

**Data:** 16 de junho de 2026  
**Repositório:** `alissonryan/PolymarketBTC15mAssistant`  
**Versão analisada:** Commit `90e1aa7` (HF Backtest Harness)

---

## 1. Visão Geral do Projeto

O `PolymarketBTC15mAssistant` é um sistema de **paper trading** para mercados binários de BTC de curta duração (5m e 15m) no **Polymarket** e **Kalshi**.

### Características principais:
- Modelo probabilístico baseado em **drifted Brownian motion** (`settlementProb.js`)
- Calibração histórica por horário (UTC) e condições de mercado
- Separação clara entre Polymarket e Kalshi
- Harness de backtest out-of-sample (adicionado recentemente)

---

## 2. Resultados Reais de Backtest e Paper Trading

Os testes já foram executados e reconciliados com os trades reais (stake US$ 2, gate edge ≥ 0,15):

| Mercado              | Backtest          | Paper Trading ao Vivo     | Amostra     | Avaliação |
|----------------------|-------------------|---------------------------|-------------|---------|
| **Kalshi 15m**       | +24% ROI          | **+37%** (69% acerto)     | 78 trades   | **Mais sólido** |
| **Polymarket 5m**    | +15% ROI          | **+10%** (62% acerto)     | 102 trades  | Positivo |
| **Polymarket 15m**   | +73% ROI          | **-14%**                  | 56 trades   | **Ambíguo** (amostra fraca no backtest) |

### Observações importantes:
- O modelo acerta entre **61-63%** de direção (não é aleatório).
- A calibração pura é fraca (~51-54%). O sinal relevante vem principalmente de **momentum**.
- O edge é **sensível a regime**.

---

## 3. Avaliação do Harness de Backtest (Commit 90e1aa7)

O harness `scripts/hf-backtest/` é um dos pontos mais relevantes do projeto.

### O que foi testado:
- Replay completo dos engines de produção (`lookupRate`, `settlementProbability`, `computeEdge`, `decide`)
- Dados reais do Polymarket (HF dataset) e Kalshi (API pública)
- Diagnósticos de monotonicidade de momentum

### Ponto relevante:
O harness **encontrou e corrigiu** um bug de timezone (GMT-3). O uso de `datetime.timestamp()` em objeto naive gerava deslocamento de +3h, o que invertia o veredito do modelo. O bug foi detectado pelo sanity check de monotonicidade do momentum e corrigido via `to_ms_utc()`. Isso demonstra que o harness tem valor como ferramenta de validação.

---

## 4. Realidade de Mercado (fontes verificáveis)

Pesquisas independentes mostram que:

- Entre **70-84% dos traders** perdem dinheiro no Polymarket.
- Os lucros se concentram em três tipos de estratégias:
  - Arbitragem de latência (Chainlink oracle vs spot da Binance)
  - Arbitragem entre venues
  - Market-making
- O edge estrutural disponível é modelar o **atraso do oráculo Chainlink** + fair-value Browniano, e não análise técnica tradicional.

---

## 5. Parecer Final

| Critério                        | Nota | Comentário |
|--------------------------------|------|----------|
| Qualidade da arquitetura       | 8.5  | Boa separação e estrutura |
| Harness de backtest            | 8.5  | Encontrou bug real de timezone (ponto positivo) |
| Kalshi 15m                     | 9.0  | Resultado mais consistente (+37% live) |
| Polymarket 5m                  | 7.5  | Positivo (+10% live) |
| Polymarket 15m                 | 5.0  | Amostra fraca e resultado negativo ao vivo |
| Alinhamento com edge real      | 7.0  | Modelo depende de momentum + correção de oráculo |

### Conclusão

- **Kalshi 15m** é atualmente a tese mais sólida do projeto (concordância entre backtest e live).
- **Polymarket 5m** entrega resultado positivo, contrariamente à narrativa de saturação encontrada em algumas discussões públicas.
- **Polymarket 15m** permanece ambíguo devido à baixa quantidade de trades no backtest e resultado negativo no paper trading.
- O harness de backtest já provou seu valor ao identificar um bug de timezone que afetava o modelo.

O projeto tem boa base técnica. O próximo passo natural é focar em Kalshi 15m e continuar monitorando o 5m do Polymarket com o stake real de US$ 2.

---

*Documento atualizado com dados reais de backtest e paper trading (stake US$ 2).*