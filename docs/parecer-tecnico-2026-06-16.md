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

## 2. Análise da Estratégia vs Realidade de Mercado (X + Web)

| Dimensão                    | Avaliação do Código                     | Realidade no Mercado (2026)                          | Comentário |
|----------------------------|-----------------------------------------|-------------------------------------------------------|----------|
| **Polymarket 5m**          | Suportado                               | Extremamente saturado (bot vs bot)                    | Edge muito apertado |
| **Polymarket 15m**         | Suportado + filtro CHOP                 | Competitivo, mas menos saturado que o 5m              | Melhor oportunidade atual |
| **Kalshi 15m**             | Suportado                               | Operadores transparentes (ex: @15MCryptoSniper)       | Ainda parece ter espaço |
| **Abordagem**              | Estatística + tempo (diffusion model)   | Muitos bots usam momentum + hedging de última hora    | Mais passivo que a média |
| **Backtest**               | Harness rigoroso (novo)                 | Muitos backtests públicos são superestimados          | Ponto forte do projeto |

**Conclusão da estratégia:**
O modelo atual é **mais sofisticado** que a maioria dos bots amadores. Porém, ele é relativamente **passivo** comparado com os bots que estão performando melhor no X, que misturam edge estatístico com reatividade em tempo real.

---

## 3. Avaliação do Harness de Backtest (Commit 90e1aa7)

Este commit adicionou o harness `scripts/hf-backtest/`, que é um dos pontos mais positivos do projeto atualmente.

### Pontos Fortes:
- Replays **diretamente os engines de produção** (sem reimplementação)
- **Sem look-ahead bias** (bom controle de timestamps)
- Testa tanto Polymarket (HF dataset) quanto Kalshi
- Inclui diagnósticos úteis (momentum monotonicity sanity check)
- Já identificou e corrigiu um bug de timezone (GMT-3)

### Pontos de Atenção:
- Ainda não modela slippage e fila de ordens de forma realista
- O harness é recente (16/06/2026) — precisa ser rodado e validado contra os paper trades reais
- Faltam alguns gates avançados que existem no bot live

**Veredito:** O harness está **bem acima da média** dos backtests que circulam no X. É metodologicamente rigoroso.

---

## 4. Riscos e Limitações Identificados

1. **Saturação no 5m** — O Polymarket 5m parece ter virado um jogo de latência e volume. O 15m é mais interessante no momento.
2. **Overfitting** — Vários relatos no X mostram backtests ótimos que viram prejuízo live. O novo harness ajuda, mas ainda precisa de validação rigorosa.
3. **Modelo de execução** — O bot atual não explora agressivamente **order flow** ou **CVD** em tempo real.
4. **Kalshi vs Polymarket** — Kalshi 15m parece ter menos bots dominando que o Polymarket.

---

## 5. Parecer Final

| Critério                        | Nota | Comentário |
|--------------------------------|------|----------|
| Qualidade da arquitetura       | 8.5  | Boa separação e estrutura |
| Sofisticação da estratégia     | 7.5  | Acima da média, mas ainda passiva |
| Harness de backtest            | 9.0  | Um dos melhores que vi nesse nicho |
| Alinhamento com o mercado      | 7.0  | 15m está melhor posicionado que 5m |
| Potencial de evolução          | 8.5  | Boa base técnica |

### Conclusão

O projeto está em um **bom patamar técnico**, especialmente após a adição do harness de backtest. A estratégia tem fundamento, mas precisa ser validada com rigor nos dados out-of-sample.

Atualmente, o **15m (Polymarket + Kalshi)** parece mais promissor que o 5m. O maior risco é o edge estar mais fraco do que o backtest sugere — algo comum nesse mercado segundo as discussões no X.

---

**Recomendações principais:**
- Priorizar validação do 15m via o novo harness
- Considerar adicionar mais reatividade de última hora
- Monitorar wallets públicas que estão performando bem no X (ex: @BimbaCrypto, @polyquantlab)

---

*Documento gerado automaticamente com base em análise de código, pesquisa no X e fontes públicas.*