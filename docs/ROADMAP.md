# Roadmap — de experimento em paper a operação real confiável

**Data:** 2026-06-19 · **Estado atual:** execução real Kalshi V2 pronta e verificada (mecânica 201,
book de produção líquido, saldo real $0 aguardando depósito); paper rodando (kalshi 68% WR /
100+ trades, poly_5m positivo, poly_15m aposentado por anti-edge); SQLite dual-write ativo;
harness de backtest OOS construído (com contaminação in-sample conhecida a corrigir).

**Tese do 10x:** o valor do sistema = `capital × edge × uptime × confiança`. Hoje capital ≈ $0
real, uptime depende de abas de terminal no Mac, o edge não tem manutenção automática e a
confiança vem de análises manuais nesta sessão. Cada fase abaixo ataca um desses fatores —
nenhuma exige "prever melhor"; todas exigem operar melhor o edge que já foi provado.

**Princípios herdados do projeto (inegociáveis):**
- Nenhuma mudança de estratégia sem ≥100 trades OOS ou validação walk-forward.
- Todo recurso que toca dinheiro real nasce atrás de flag, default off, com teste.
- Paper continua rodando em paralelo para sempre (é o grupo de controle do real).

---

## Fase 0 — Go-live validado (esta semana) 🎯 *o desbloqueio de valor nº 1*

Nada abaixo importa até o real provar que ≈ paper. Fase quase toda manual + análise.

### 0.1 Primeiros trades reais vigiados
$50 depositados, stake $1–2, `EXECUTE_ORDERS=true KALSHI_DEMO=false KALSHI_LIVE_CONFIRM=true`.
**Aceite:**
- [ ] 3–5 primeiros fills conferidos manualmente: preço de fill ≤ ask+1¢ visto no painel.
- [ ] Liquidação credita o valor esperado na conta (extrato Kalshi = `kalshi_btc_real` no SQLite).
- [ ] Posição abre → liquida → zera sem órfã (posição na exchange = posição local em 100% dos casos).
- [ ] Nenhum trade invertido (lado DOWN confirmado como venda de YES a 1−noAsk).

### 0.2 Validação real≈paper (2–4 semanas)
**Aceite:**
- [ ] ≥50 trades reais liquidados.
- [ ] WR real ≥ WR paper − 7pp na mesma janela (ex.: paper 65% → real ≥ 58%).
- [ ] PnL real positivo após taxas OU divergência explicada por slippage medido (não por bug).
- [ ] Zero incidentes de execução (ordem perdida, posição órfã, erro de auth) em 2 semanas.
- **Gate de saída:** só passa à Fase 4 (escalar stake) se tudo acima fechar.

---

## Fase 1 — Proteção de capital (junto com a Fase 0, é pré-requisito de escalar)

### 1.1 Kill-switch de drawdown (`RISK_MAX_DRAWDOWN_PCT`)
Hoje projetado mas desligado. Com dinheiro real é obrigatório.
**Aceite:**
- [ ] Com `RISK_MAX_DRAWDOWN_PCT=20`, o bot para de ENTRAR (não fecha posição aberta) quando
      `equity < pico_equity × 0.8`, usando saldo real da conta (não PnL local).
- [ ] Estado persistido: reiniciar o processo NÃO reseta o pico de equity.
- [ ] Disparo gera log gritante + (Fase 2) notificação; exige ação manual para rearmar (`--rearm` ou env).
- [ ] Testes: dispara no limiar exato; não dispara a 19,9%; sobrevive a restart.

### 1.2 Reconciliação posição local × exchange
O maior risco operacional real: estado local divergir da corretora (fill parcial, restart no meio, API caindo).
**Aceite:**
- [ ] A cada tick com posição aberta, `getPosition(ticker)` da exchange é comparado ao estado local.
- [ ] Divergência ⇒ modo `RECONCILE`: bloqueia novas entradas, loga diff, notifica; nunca "corrige" sozinho vendendo/comprando.
- [ ] Posição órfã na exchange sem estado local ⇒ detectada no boot (`ensureInit`) e reportada.
- [ ] Teste com mocks: local diz aberto/exchange diz zero (e vice-versa) ⇒ ambos entram em RECONCILE.

### 1.3 Limite diário de perda no REAL (independente do paper)
**Aceite:**
- [ ] `RISK_MAX_DAILY_LOSS_REAL_USDC` (default = 10% do saldo) conta só trades `kalshi_btc_real` do dia UTC.
- [ ] Ao atingir: sem novas entradas até 00:00 UTC; log + notificação; teste cobrindo a virada de dia.

---

## Fase 2 — Autonomia operacional (o bot para de depender do seu terminal)

Hoje: abas de foreground no Mac; se a tampa fecha, o dinheiro real fica cego. Inaceitável pós-live.

### 2.1 Notificações (Telegram — menor atrito, grátis)
**Aceite:**
- [ ] Módulo `src/ops/notify.js` (flag `NOTIFY_TELEGRAM_TOKEN/CHAT_ID`; sem token = no-op silencioso).
- [ ] Eventos notificados: fill real (lado, preço, tamanho), liquidação (WIN/LOSS, PnL), kill-switch,
      RECONCILE, feed congelado/void, bot reiniciado, resumo diário 21h UTC (n, WR, PnL real×paper).
- [ ] Nunca envia segredo/chave; rate-limit de 1 msg/5s; falha de envio não derruba o bot (try/catch + log).

### 2.2 Serviço 24/7 (launchd no Mac OU VPS barato)
**Aceite:**
- [ ] `launchd` plist (ou systemd se VPS) que sobe os bots no boot, reinicia em crash, sem depender de aba.
- [ ] Mac: `caffeinate`/config documentada impedindo sleep com posição real aberta — OU decisão
      explícita de migrar o bot real para VPS ($5/mês) com deploy documentado (`git pull && restart`).
- [ ] Teste de fogo: reboot da máquina ⇒ bots voltam sozinhos em <2 min, posição preservada, notificação "restarted".

### 2.3 Healthcheck + watchdog externo
**Aceite:**
- [ ] Endpoint/arquivo heartbeat por bot (últ. tick, últ. dado de feed, RSS, modo demo/live).
- [ ] Watchdog (cron a cada 5 min) alerta se heartbeat >3 min velho ou feed >5 min sem update.
- [ ] Alerta de "silêncio anormal": sessão US aberta + 0 avaliações de sinal em 30 min ⇒ notifica.

---

## Fase 3 — Durabilidade do edge (o que mantém o lucro vivo por meses)

O edge é momentum/regime-sensível e a calibração envelhece. Sem manutenção, morre em silêncio.

### 3.1 Instrumentação de entrada (pré-requisito de TUDO nesta fase)
O diagnóstico multi-agente morreu na praia por falta destes campos. Gravar por trade (paper e real):
**Aceite:**
- [ ] Novas colunas no SQLite: `spot_at_entry`, `momentum_bps` (spot−strike em bps), `sigma_at_entry`,
      `chop_at_entry`, `regime`, `model_prob`, `market_prob`, `calib_bucket` (hour|macro|vwap|rsi).
- [ ] Migração de schema idempotente (colunas nullable; trades antigos ficam NULL).
- [ ] `npm run stats` ganha corte por regime (`--by-regime`): WR/PnL em TREND vs CHOP.
- [ ] 1 semana de dados ⇒ conseguimos responder "o edge do Kalshi vive só em tendência?" com números.

### 3.2 Backtest honesto (corrigir contaminação in-sample)
**Aceite:**
- [ ] `hf-backtest/run.mjs` recebe calibração treinada ESTRITAMENTE antes da janela de teste;
      aborta com erro se train/test se sobrepõem (asserção de datas).
- [ ] Re-rodar Kalshi/5m com split honesto e registrar resultado no README do harness.
- [ ] `calibrate.js` ganha `--until YYYY-MM-DD` para gerar tabelas com corte temporal.

### 3.3 Hermes — recalibração automática com guard-rails (a "manutenção autônoma")
O agente que o usuário quer, com as travas já combinadas.
**Aceite:**
- [ ] Job quinzenal/mensal (cron): baixa candles novos → gera tabelas candidatas → roda
      `validate-calibration.js` walk-forward → SÓ promove se OOS ≥ atual − 1pp E ≥ breakeven+2pp.
- [ ] Reprovou ⇒ mantém tabela atual + notifica com o relatório. Aprovou ⇒ troca arquivo, notifica diff
      (nº buckets, edges médios), commita com mensagem padronizada.
- [ ] NUNCA altera thresholds/stake/flags — só as tabelas de calibração. Log auditável de cada decisão.
- [ ] Kill manual: `HERMES_ENABLED=false` para o job inteiro.

### 3.4 Monitor de decaimento de edge
**Aceite:**
- [ ] Métrica semanal automática: WR rolante de 50 trades vs breakeven, por bot.
- [ ] WR_50 < breakeven+2pp por 2 semanas seguidas ⇒ alerta "edge em decaimento — revisar antes de escalar".

---

## Fase 4 — Escala de capital e mercados (só após gate da Fase 0.2)

### 4.1 Sizing proporcional ao saldo (Kelly-fraccionado conservador)
**Aceite:**
- [ ] `RISK_SIZING_MODE=fixed|fraction`; em `fraction`, stake = `RISK_STAKE_FRACTION` (default 2%) × saldo real,
      com teto absoluto `RISK_ORDER_SIZE_MAX_USDC`.
- [ ] Nunca excede ¼-Kelly implícito pelo edge validado (documentar a conta no código).
- [ ] Compounding automático limitado: re-avalia o stake 1×/dia, não por trade (evita martingale acidental).

### 4.2 Expansão Kalshi: ETH e SOL 15m
Os scripts `kalshi:eth`/`kalshi:sol` já existem; falta calibração própria e validação.
**Aceite:**
- [ ] Tabelas de calibração por ativo (ETHUSDT/SOLUSDT, mesmos horizontes) + validação walk-forward ≥53% OOS.
- [ ] ≥100 trades paper por ativo com WR ≥ breakeven+3pp ANTES de real.
- [ ] Cap de exposição correlacionada: máx. N posições reais simultâneas somadas (BTC+ETH+SOL movem juntos).

### 4.3 Espelhamento 5m Polymarket → decisão final
**Aceite:**
- [ ] Com 300+ trades paper acumulados do poly_5m: veredito documentado (manter paper / construir execução
      real Polymarket / aposentar). Critério: WR−breakeven ≥ 3pp com IC95 acima de zero.

---

## Fase 5 — Observabilidade (confiança para escalar sem babá)

### 5.1 Relatório diário automático
**Aceite:**
- [ ] 21h UTC: mensagem única (Telegram) com n/WR/PnL do dia e acumulado, real×paper lado a lado,
      drawdown atual vs pico, incidentes (voids, reconciles, restarts), saldo real.

### 5.2 Dashboard local (`npm run dashboard`)
**Aceite:**
- [ ] Página local (servida do SQLite, read-only): curva de equity real×paper, WR rolante 50 trades,
      cortes por regime/hora/lado, tabela dos últimos 20 trades, status dos bots (heartbeat).
- [ ] Zero dependência de serviço externo; abre em <2s; não interfere nos bots (conexão readOnly).

### 5.3 Higiene técnica (rápidos, fazer junto com qualquer fase)
- [ ] `.gitignore`: `data/` → `/data/` (footgun: arquivos novos em `src/data/` seriam ignorados).
- [ ] `stats.mjs`: coluna breakeven por bot (do preço médio de entrada) ao lado do WR.
- [ ] CI simples (GitHub Actions): `node --test` em Node 24 a cada push — hoje os 72 testes só rodam à mão.
- [ ] Repo privado próprio (fork é público; código de execução real + estratégia não deveriam ser públicos).

---

## Sequência recomendada (dependências)

```
Fase 0 (go-live $50) ──┬── Fase 1 (proteções) ── gate 0.2 ── Fase 4 (escala)
                       ├── Fase 2 (autonomia/notify)
                       └── Fase 3.1 (instrumentação) ── 3.2 ── 3.3 Hermes ── 3.4
Fase 5 corre em paralelo após 2.1 (notify é a base do 5.1)
```

**Ordem prática das próximas 2 semanas:** 0.1 → 1.1 + 1.2 (antes de dormir com posição real) →
2.1 (notify) → 3.1 (instrumentação) → 0.2 rodando ao fundo → 2.2 → 5.1.

*Regra de ouro para todo o roadmap: cada item nasce numa sessão de build com TDD, atrás de flag,
e é verificado de forma independente antes de tocar dinheiro real — como foi feito até aqui.*
