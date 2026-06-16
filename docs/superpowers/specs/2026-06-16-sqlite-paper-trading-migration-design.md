# Migração da persistência de paper trading para SQLite

**Data:** 2026-06-16
**Status:** Design aprovado — aguardando implementação
**Branch:** `feat/sqlite-paper-migration`

## Problema

Hoje cada bot grava trades, posição e anulações em arquivos JSON em `logs/`
(`${PAPER_LOG_PREFIX}paper_trades.json`, `...paper_position.json`, etc.). Funciona,
mas:

- A cada trade liquidado o histórico inteiro é relido e reescrito
  (`appendTrade` → `loadHistory` + `saveJson`), padrão rewrite-do-arquivo-todo.
- Análise exige re-parsear JSON grande; não há interface de query.
- O futuro **Hermes Agent** (que já roda na VPS) vai precisar consultar esses dados
  para monitorar/recalibrar — SQL é muito melhor que parsear JSON.
- Mover o histórico para a VPS hoje significaria sincronizar vários JSONs
  (`logs/` está no `.gitignore`, não viaja por `git pull`). Um `trades.db` único
  vira um arquivo só, `scp` direto.

O volume é minúsculo (~200 trades, ~150 KB). **O ganho não é escala — é dar uma
interface de query limpa ao Hermes e simplificar o caminho laptop → VPS.**

## Ativo a proteger

O `logs/` canônico (no laptop, onde os 3 bots rodam hoje) é o **dataset de validação
do edge da estratégia**. A regra registrada em memória é "≥100 trades antes de mudar
threshold". Um bug silencioso na camada de escrita corromperia justamente esse
dataset — e poderia passar dias sem ser notado. Por isso o rollout é conservador
(dual-write).

## Escopo

**Dentro:** migrar a camada de persistência de paper trading (laptop) de JSON para
SQLite, com dual-write de transição, importador do histórico existente e backup.

**Fora (specs separados, depois):**
- Mover os bots para a VPS (rodar 24/7 lá).
- Integrar o Hermes Agent (cron de relatório no Telegram, skill de recalibração).

O SQLite é o veículo natural para esses dois passos futuros, mas eles não fazem
parte desta migração.

## Arquitetura

```
laptop (dev + prod atual)
├── 3 bots (poly_btc_5m, poly_btc_15m, kalshi_btc)
│     └── escrevem em → trades.db (SQLite local, WAL mode)
│     └── [transição] também escrevem nos JSONs atuais (dual-write)
└── cron de backup → cópia datada de trades.db
```

A lógica de trade (`onPaperTick`, `_settlePosition`, cálculo de P&L, cooldowns,
guards de oracle congelado) **não muda**. A troca acontece só na camada isolada de
persistência.

### Costura (o que muda em `src/execution/paperTrading.js`)

Funções a adaptar, mantendo a mesma interface pública:
- `loadJson` / `saveJson` — hoje genéricas de arquivo.
- `appendTrade` — passa a fazer `INSERT` na tabela `trades`.
- `loadHistory` — passa a fazer `SELECT` da tabela `trades` (filtrado por `bot_id`).
- `savePos` / load inicial de `_pos` — passa a usar a tabela `positions`.
- `getPaperStats` / `getLastTrades` — continuam funcionando sobre `loadHistory`
  (podem virar SQL agregado depois, mas não é necessário nesta migração).

`PAPER_LOG_PREFIX` deixa de selecionar arquivo e passa a definir o `bot_id`.

### Schema

Banco único `logs/trades.db` (uma das opções era um `.db` por bot; escolhido banco
único + coluna `bot_id` porque é o que o Hermes vai querer: `GROUP BY bot_id` numa
query só).

```sql
CREATE TABLE trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id           TEXT NOT NULL,           -- poly_btc_5m | poly_btc_15m | kalshi_btc
  side             TEXT NOT NULL,           -- UP | DOWN
  entry_price      REAL NOT NULL,
  usdc_amount      REAL NOT NULL,
  price_to_beat    REAL,
  settlement_price REAL,
  won              INTEGER NOT NULL,        -- 0 | 1
  gross_pnl        REAL NOT NULL,
  fee_at_entry     REAL NOT NULL DEFAULT 0,
  pnl              REAL NOT NULL,
  edge_at_entry    REAL,
  oracle_source    TEXT,
  entry_time_left_min REAL,
  best_bid_at_entry   REAL,
  best_ask_at_entry   REAL,
  spread_at_entry     REAL,
  market_slug      TEXT,
  entered_at       TEXT NOT NULL,           -- ISO 8601
  settled_at       TEXT NOT NULL            -- ISO 8601
);
CREATE INDEX idx_trades_bot ON trades(bot_id);
CREATE INDEX idx_trades_settled ON trades(settled_at);

CREATE TABLE positions (
  bot_id           TEXT PRIMARY KEY,
  open             INTEGER NOT NULL DEFAULT 0,
  side             TEXT,
  entry_price      REAL,
  usdc_amount      REAL,
  price_to_beat    REAL,
  market_slug      TEXT,
  entered_at       TEXT,
  edge_at_entry    REAL,
  oracle_source    TEXT,
  entry_time_left_min REAL,
  best_bid_at_entry   REAL,
  best_ask_at_entry   REAL,
  spread_at_entry     REAL,
  fee_at_entry        REAL DEFAULT 0
);

CREATE TABLE voided_trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT NOT NULL,
  side          TEXT,
  entry_price   REAL,
  price_to_beat REAL,
  settlement_price REAL,
  void_reason   TEXT,                       -- frozen_vs_strike | frozen_vs_prev
  entered_at    TEXT,
  voided_at     TEXT NOT NULL
);
```

`voided_trades` é uma melhoria: hoje os trades anulados por oracle congelado somem
sem rastro (`_settlePosition` só faz `console.warn`). Registrá-los permite ao Hermes
ver quantos foram anulados e por quê.

### Concorrência

3 processos escrevem no mesmo arquivo. Mitigação: **WAL mode**
(`PRAGMA journal_mode=WAL`) + **`PRAGMA busy_timeout`** (ex.: 5000ms). O volume é
trivial (um INSERT a cada vários minutos por bot), então não há contenção real.

### Biblioteca

Usar `better-sqlite3` (síncrono, casa com o estilo síncrono atual de
`writeFileSync`) ou o `node:sqlite` nativo se a versão do Node na VPS suportar.
Decisão final fica para o plano de implementação (verificar versão do Node).

## Importador

Script único (ex.: `scripts/import-json-to-sqlite.js`) que:
1. Cria o schema se não existir.
2. Lê cada `logs/${prefix}paper_trades.json` e insere em `trades` com o `bot_id`.
3. Lê cada `logs/${prefix}paper_position.json` e insere/atualiza `positions`.
4. (Opcional) lê os `voided_frozen_oracle*` existentes para `voided_trades`.
5. É **idempotente** — rodar duas vezes não duplica (ex.: limpar e reimportar, ou
   chave única por `bot_id + entered_at + settled_at`).

Roda no laptop (dataset canônico). Não toca nos JSONs (só lê).

## Rollout — Opção A (dual-write + validação)

Escolhida entre três opções (A dual-write / B cutover direto / C editar main direto).
A protege o dataset: se o SQLite tiver bug, o JSON continua intacto como rede de
segurança.

1. **Desenvolver na branch** `feat/sqlite-paper-migration`. Editar `.js` não afeta os
   bots já rodando (Node já carregou os módulos); só vale no próximo restart.
2. **Importar** o histórico atual JSON → `trades.db`.
3. **Dual-write**: código grava nos dois (JSON e SQLite). Testes
   (`test/paperTrading.test.js`) verdes.
4. **Restart** dos 3 bots no laptop para rodarem o código novo (pausa breve, por bot;
   o estado é recuperável — `_pos` recarrega do disco).
5. **Validar** com um script de comparação: `trades.db` == JSONs, zero divergência.
6. **Cutover** quando atingir a janela de espera (abaixo): SQLite vira canônico,
   dual-write é removido, JSONs são arquivados (não apagados).

### Janela de espera antes do cutover

Aguardar **o que vier por último** entre:
- **(a) 3 dias corridos** de dual-write rodando, e
- **(b) ≥20 trades liquidados** dual-written com zero divergência.

Os 3 dias garantem cobrir condições variadas (restarts, voids, oracle congelado),
não só volume bruto. Se a implementação acontecer nos próximos dias, a revisão do
cutover cai por volta de **20–21/06/2026**.

> Lembrete para retomar: após implementar (passos 1–4), marcar a data de início do
> dual-write e revisar o cutover quando ambas as condições baterem.

## Backup

Cron simples no laptop (e depois na VPS) copiando `logs/trades.db` para uma cópia
datada fora do repo (`logs/` é gitignored; o `.db` também ficará ignorado). Resolve a
ausência de backup do histórico, que era um risco aberto independente desta migração.

## Testes

- `test/paperTrading.test.js` já existe e cobre a API pública — deve continuar verde
  após a troca da camada de persistência.
- Adicionar teste do importador (JSON conhecido → linhas esperadas no `.db`).
- Adicionar teste do dual-write/comparação (um trade gravado aparece idêntico nos
  dois lados).

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Bug silencioso corrompe o dataset de validação | Dual-write — JSON intacto como fallback durante a janela |
| 3 processos escrevendo no mesmo `.db` | WAL mode + busy_timeout; volume trivial |
| Perda de trades na janela entre import e restart | Importar imediatamente antes do restart, por bot |
| Versão do Node na VPS sem `node:sqlite` | Decidir lib (`better-sqlite3`) no plano de implementação |
| `.db` sem backup | Cron de backup datado (item dedicado) |

## Não-objetivos (YAGNI)

- Nada de Postgres/Supabase/Neon: o acesso será só via Telegram/Hermes, sem dashboard
  online (decisão do brainstorm). Reavaliar só se um dashboard remoto entrar em cena.
- Nada de mover bots para a VPS nesta migração.
- Nada de reescrever `getPaperStats`/`getLastTrades` como SQL agregado agora — só se a
  análise começar a doer.
