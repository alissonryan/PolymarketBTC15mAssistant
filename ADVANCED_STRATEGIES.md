# 🚀 Estratégias Avançadas para Polymarket BTC 15m Assistant

> Documento técnico de implementação baseado em pesquisa de mercado, microestrutura de mercado e estratégias de order flow.

---

## 📋 Sumário

1. [Análise da Estratégia Atual](#1-análise-da-estratégia-atual)
2. [Order Flow Imbalance (OBI)](#2-order-flow-imbalance-obi)
3. [Cumulative Volume Delta (CVD)](#3-cumulative-volume-delta-cvd)
4. [Microprice Estimation](#4-microprice-estimation)
5. [Dynamic Hedging](#5-dynamic-hedging)
6. [Latency Arbitrage Detection](#6-latency-arbitrage-detection)
7. [Time-Price Convergence](#7-time-price-convergence)
8. [Lock Strategy (Market Making)](#8-lock-strategy-market-making)
9. [Integração e Configuração](#9-integração-e-configuração)
10. [Referências](#10-referências)

---

## 1. Análise da Estratégia Atual

### 1.1 Arquitetura Atual

```
src/
├── data/           # Fontes de dados (Binance, Polymarket, Chainlink)
├── indicators/     # VWAP, RSI, MACD, Heiken Ashi
├── engines/        # Regime detection, Probability scoring, Edge calculation
├── execution/      # Bot, Paper trading, Orders, Position, Wallet
├── risk/           # Guard (circuit breaker, daily stats)
└── index.js        # Loop principal
```

### 1.2 Sistema de Scoring Atual

| Indicador | Peso | Condição |
|-----------|------|----------|
| VWAP Position | +2 | Preço > VWAP (UP) ou < VWAP (DOWN) |
| VWAP Slope | +2 | Slope positivo/negativo (5min lookback) |
| RSI + Slope | +2 | RSI>55 + slope↑ ou RSI<45 + slope↓ |
| MACD Expansion | +2/+1 | Histograma expandindo + sinal |
| Heiken Ashi | +1 | 2+ candles consecutivos mesma cor |
| Failed VWAP Reclaim | +3 | Preço falha em recuperar VWAP |

**Fórmula de probabilidade:**
```javascript
rawUp = upScore / (upScore + downScore)
adjustedUp = 0.5 + (rawUp - 0.5) × (remainingMinutes / 15)
```

### 1.3 Pontos Fortes

✅ Multi-fator com 5+ indicadores independentes  
✅ Time-awareness (time decay nas probabilidades)  
✅ Regime detection (evita chop/range)  
✅ Edge-based (compara modelo vs mercado)  
✅ Risk management (circuit breaker, daily P&L)  

### 1.4 Limitações Identificadas

❌ **Sem Order Flow Analysis** - Não vê pressão real de compra/venda  
❌ **Sem Order Book Imbalance** - Ignora profundidade do livro  
❌ **RSI slope muito curto** - 3 períodos = ruído excessivo  
❌ **Sem Volume Delta/CVD** - Não detecta absorção/distribuição  
❌ **Sem Latency Arbitrage** - Perde edge de velocidade  
❌ **Sem Hedge Dinâmico** - Exposição direcional pura  

---

## 2. Order Flow Imbalance (OBI)

### 2.1 Conceito

OBI mede o desequilíbrio entre ordens de compra e venda no order book em tempo real. É um dos indicadores mais poderosos de microestrutura de mercado.

**Fórmula:**
```
OBI = (BidVolume - AskVolume) / (BidVolume + AskVolume)
Range: -1 (venda total) a +1 (compra total)
```

### 2.2 Implementação

**Arquivo:** `src/indicators/orderFlowImbalance.js`

```javascript
export class OrderFlowAnalyzer {
  constructor(depth = 10) {
    this.depth = depth;
    this.obiHistory = []; // Circular buffer de 60 amostras (1 minuto)
    this.lastSignal = null;
  }
  
  update(orderBook) {
    const obi = this.calculateOBI(orderBook);
    const timestamp = Date.now();
    
    this.obiHistory.push({ timestamp, obi });
    if (this.obiHistory.length > 60) this.obiHistory.shift();
    
    // Detectar mudança de regime
    const sentiment = this.detectSentimentShift();
    const divergence = this.detectDivergence();
    
    return {
      obi,
      sentiment,
      divergence,
      trend: this.getOBITrend(),
      strength: Math.abs(obi)
    };
  }
  
  calculateOBI(book) {
    const bids = book.bids?.slice(0, this.depth) || [];
    const asks = book.asks?.slice(0, this.depth) || [];
    
    const bidVol = bids.reduce((sum, lvl) => sum + (parseFloat(lvl.size) || 0), 0);
    const askVol = asks.reduce((sum, lvl) => sum + (parseFloat(lvl.size) || 0), 0);
    
    const total = bidVol + askVol;
    return total > 0 ? (bidVol - askVol) / total : 0;
  }
  
  // Detectar mudança brusca de sentimento (>0.3 em 5 segundos)
  detectSentimentShift(threshold = 0.3, windowMs = 5000) {
    if (this.obiHistory.length < 10) return null;
    
    const now = Date.now();
    const recent = this.obiHistory.filter(h => now - h.timestamp < windowMs);
    if (recent.length < 5) return null;
    
    const avgRecent = recent.reduce((a, h) => a + h.obi, 0) / recent.length;
    const previous = this.obiHistory.filter(h => 
      h.timestamp < now - windowMs && h.timestamp >= now - windowMs * 2
    );
    
    if (previous.length < 5) return null;
    const avgPrevious = previous.reduce((a, h) => a + h.obi, 0) / previous.length;
    
    const shift = avgRecent - avgPrevious;
    
    if (Math.abs(shift) > threshold) {
      return {
        shift,
        from: avgPrevious > 0 ? 'BULLISH' : 'BEARISH',
        to: avgRecent > 0 ? 'BULLISH' : 'BEARISH',
        strength: Math.abs(avgRecent),
        timestamp: now
      };
    }
    return null;
  }
  
  // Divergência OBI vs Preço
  detectDivergence(price, vwap) {
    if (this.obiHistory.length < 20) return null;
    
    const currentOBi = this.obiHistory[this.obiHistory.length - 1].obi;
    const priceAboveVWAP = price > vwap;
    const obiBullish = currentOBi > 0.3;
    const obiBearish = currentOBi < -0.3;
    
    // Bullish divergence: preço abaixo VWAP mas OBI comprador
    if (!priceAboveVWAP && obiBullish) {
      return { type: 'BULLISH_DIVERGENCE', strength: currentOBi };
    }
    
    // Bearish divergence: preço acima VWAP mas OBI vendedor
    if (priceAboveVWAP && obiBearish) {
      return { type: 'BEARISH_DIVERGENCE', strength: Math.abs(currentOBi) };
    }
    
    return null;
  }
  
  getOBITrend(periods = 10) {
    if (this.obiHistory.length < periods) return 'NEUTRAL';
    
    const recent = this.obiHistory.slice(-periods);
    const avg = recent.reduce((a, h) => a + h.obi, 0) / periods;
    
    if (avg > 0.5) return 'STRONG_BULLISH';
    if (avg > 0.2) return 'BULLISH';
    if (avg < -0.5) return 'STRONG_BEARISH';
    if (avg < -0.2) return 'BEARISH';
    return 'NEUTRAL';
  }
}
```

### 2.3 Integração no Scoring

**Modificar:** `src/engines/probability.js`

```javascript
export function scoreDirection(inputs) {
  const {
    price, vwap, vwapSlope, rsi, rsiSlope, macd,
    heikenColor, heikenCount, failedVwapReclaim,
    obi, obiDivergence, obiSentiment // NOVOS
  } = inputs;

  let up = 1;
  let down = 1;

  // ... código existente ...

  // ===== ORDER FLOW IMBALANCE =====
  if (obi !== null && !isNaN(obi)) {
    // OBI forte comprador
    if (obi > 0.6) up += 2;
    // OBI forte vendedor
    if (obi < -0.6) down += 2;
    // OBI moderado
    if (obi > 0.3 && obi <= 0.6) up += 1;
    if (obi < -0.3 && obi >= -0.6) down += 1;
  }
  
  // Divergência OBI vs Preço (sinal de alta convicção)
  if (obiDivergence) {
    if (obiDivergence.type === 'BULLISH_DIVERGENCE') {
      up += 2; // Acumulação em suporte
    } else if (obiDivergence.type === 'BEARISH_DIVERGENCE') {
      down += 2; // Distribuição em resistência
    }
  }
  
  // Mudança brusca de sentimento
  if (obiSentiment && obiSentiment.strength > 0.5) {
    if (obiSentiment.to === 'BULLISH') up += 1;
    if (obiSentiment.to === 'BEARISH') down += 1;
  }

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}
```

### 2.4 Thresholds Recomendados

| OBI | Interpretação | Peso |
|-----|---------------|------|
| > +0.6 | Forte pressão compradora | +2 |
| +0.3 a +0.6 | Pressão compradora moderada | +1 |
| -0.3 a +0.3 | Equilíbrio | 0 |
| -0.6 a -0.3 | Pressão vendedora moderada | +1 |
| < -0.6 | Forte pressão vendedora | +2 |

---

## 3. Cumulative Volume Delta (CVD)

### 3.1 Conceito

CVD é a soma acumulada do delta (volume comprador - volume vendedor) ao longo do tempo. Revela a "agressão" institucional no mercado.

**Fórmula:**
```
Delta = BuyVolume - SellVolume (por candle)
CVD = Σ Delta (acumulado)
```

**Classificação de trades:**
- **Tick Rule:** Se preço > preço anterior = buy-initiated
- **Trade Side Flag:** Usar `isBuyerMaker` da Binance WebSocket

### 3.2 Implementação

**Arquivo:** `src/indicators/cvd.js`

```javascript
export class CVDAnalyzer {
  constructor(options = {}) {
    this.resetInterval = options.resetInterval || '1h';
    this.deltaHistory = [];
    this.cvd = 0;
    this.lastPrice = null;
    this.lastReset = Date.now();
  }
  
  processTrade(trade) {
    const price = parseFloat(trade.p);
    const size = parseFloat(trade.q);
    
    // Classificação usando tick rule + flag da Binance
    let isBuy;
    if (trade.m !== undefined) {
      // Binance: m = true → venda (maker foi seller)
      isBuy = !trade.m;
    } else if (this.lastPrice !== null) {
      // Tick rule fallback
      isBuy = price >= this.lastPrice;
    } else {
      isBuy = true; // Default
    }
    
    this.lastPrice = price;
    
    const delta = isBuy ? size : -size;
    this.cvd += delta;
    
    this.deltaHistory.push({
      timestamp: trade.T || Date.now(),
      price,
      size,
      delta,
      cvd: this.cvd,
      isBuy
    });
    
    // Manter últimas 240 amostras (4h em 1min)
    if (this.deltaHistory.length > 240) {
      this.deltaHistory.shift();
    }
    
    // Auto-reset por intervalo
    this.checkReset();
    
    return { delta, cvd: this.cvd, isBuy };
  }
  
  // Processar múltiplos trades (batch)
  processTrades(trades) {
    return trades.map(t => this.processTrade(t));
  }
  
  // Detectar divergência CVD vs Preço
  detectDivergence(lookback = 20) {
    if (this.deltaHistory.length < lookback) return null;
    
    const recent = this.deltaHistory.slice(-lookback);
    const priceStart = recent[0].price;
    const priceEnd = recent[recent.length - 1].price;
    const cvdStart = recent[0].cvd;
    const cvdEnd = recent[recent.length - 1].cvd;
    
    const priceChange = priceEnd - priceStart;
    const cvdChange = cvdEnd - cvdStart;
    const priceChangePct = priceChange / priceStart;
    
    // Threshold mínimo de movimento (0.1%)
    const MIN_MOVE = 0.001;
    
    // Bullish divergence: preço cai mas CVD sobe (acumulação)
    if (priceChangePct < -MIN_MOVE && cvdChange > 0) {
      return {
        type: 'BULLISH',
        strength: Math.abs(cvdChange),
        priceChange: priceChangePct,
        cvdChange,
        lookback
      };
    }
    
    // Bearish divergence: preço sobe mas CVD cai (distribuição)
    if (priceChangePct > MIN_MOVE && cvdChange < 0) {
      return {
        type: 'BEARISH',
        strength: Math.abs(cvdChange),
        priceChange: priceChangePct,
        cvdChange,
        lookback
      };
    }
    
    return null;
  }
  
  // Detectar absorção (preço flat + CVD forte)
  detectAbsorption(flatThreshold = 0.0005, cvdThreshold = 10) {
    if (this.deltaHistory.length < 10) return null;
    
    const recent = this.deltaHistory.slice(-10);
    const priceStart = recent[0].price;
    const priceEnd = recent[recent.length - 1].price;
    const priceChangePct = Math.abs(priceEnd - priceStart) / priceStart;
    
    // Preço estável
    if (priceChangePct > flatThreshold) return null;
    
    const cvdStart = recent[0].cvd;
    const cvdEnd = recent[recent.length - 1].cvd;
    const cvdChange = cvdEnd - cvdStart;
    
    // CVD movendo significativamente
    if (Math.abs(cvdChange) < cvdThreshold) return null;
    
    return {
      type: cvdChange > 0 ? 'BULLISH_ABSORPTION' : 'BEARISH_ABSORPTION',
      cvdChange,
      priceChangePct,
      interpretation: cvdChange > 0 
        ? 'Compradores absorvendo venda em suporte'
        : 'Vendedores absorvendo compra em resistência'
    };
  }
  
  getCurrentState() {
    const recent = this.deltaHistory.slice(-20);
    if (recent.length === 0) {
      return { cvd: 0, trend: 'NEUTRAL', intensity: 0 };
    }
    
    const avgDelta = recent.reduce((a, b) => a + b.delta, 0) / recent.length;
    const totalVolume = recent.reduce((a, b) => a + b.size, 0);
    
    return {
      cvd: this.cvd,
      trend: avgDelta > 0 ? 'BUYING' : 'SELLING',
      intensity: Math.abs(avgDelta),
      totalVolume,
      deltaRatio: totalVolume > 0 ? Math.abs(this.cvd) / totalVolume : 0
    };
  }
  
  checkReset() {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    
    let shouldReset = false;
    
    switch (this.resetInterval) {
      case '1h':
        shouldReset = now - this.lastReset > hourMs;
        break;
      case '4h':
        shouldReset = now - this.lastReset > 4 * hourMs;
        break;
      case '1d':
        shouldReset = new Date(now).getDate() !== new Date(this.lastReset).getDate();
        break;
      case 'session':
        // Reset em mudança de sessão (implementar lógica de sessão BTC)
        shouldReset = false;
        break;
    }
    
    if (shouldReset) {
      this.cvd = 0;
      this.deltaHistory = [];
      this.lastReset = now;
    }
  }
  
  reset() {
    this.cvd = 0;
    this.deltaHistory = [];
    this.lastReset = Date.now();
  }
}
```

### 3.3 Integração no Scoring

```javascript
export function scoreDirection(inputs) {
  const {
    // ... inputs existentes ...
    cvdTrend,      // 'BUYING' | 'SELLING' | 'NEUTRAL'
    cvdDivergence, // { type, strength } | null
    cvdAbsorption  // { type, cvdChange } | null
  } = inputs;

  let up = 1;
  let down = 1;

  // ... código existente ...

  // ===== CVD TREND =====
  if (cvdTrend === 'BUYING') up += 1;
  if (cvdTrend === 'SELLING') down += 1;
  
  // ===== CVD DIVERGENCE (alta convicção) =====
  if (cvdDivergence) {
    if (cvdDivergence.type === 'BULLISH') {
      up += 2; // Acumulação = comprar
    } else if (cvdDivergence.type === 'BEARISH') {
      down += 2; // Distribuição = vender
    }
  }
  
  // ===== CVD ABSORPTION =====
  if (cvdAbsorption) {
    if (cvdAbsorption.type === 'BULLISH_ABSORPTION') {
      up += 1;
    } else if (cvdAbsorption.type === 'BEARISH_ABSORPTION') {
      down += 1;
    }
  }

  // ... resto do código ...
}
```

### 3.4 Sinais de CVD

| Padrão | Interpretação | Ação |
|--------|---------------|------|
| CVD +, Preço flat | Acumulação silenciosa | Comprar |
| CVD -, Preço flat | Distribuição silenciosa | Vender |
| Bullish Divergence | Fundo formando | Comprar forte |
| Bearish Divergence | Topo formando | Vender forte |
| CVD +, Preço + | Confirmação de tendência | Seguir |
| CVD -, Preço - | Confirmação de tendência | Seguir |

---

## 4. Microprice Estimation

### 4.1 Conceito

Microprice é uma estimativa do "preço justo" ponderado pela profundidade do order book. É mais informativo que mid-price porque considera onde está a liquidez real.

**Fórmula:**
```
vwapBid = Σ(bidPrice × bidSize) / ΣbidSize
vwapAsk = Σ(askPrice × askSize) / ΣaskSize

microprice = (vwapBid × askSizeTotal + vwapAsk × bidSizeTotal) / (bidSizeTotal + askSizeTotal)
```

### 4.2 Implementação

**Arquivo:** `src/indicators/microprice.js`

```javascript
export function calculateMicroprice(orderBook, levels = 5) {
  if (!orderBook?.bids?.length || !orderBook?.asks?.length) {
    return null;
  }
  
  const bids = orderBook.bids.slice(0, levels);
  const asks = orderBook.asks.slice(0, levels);
  
  let bidSum = 0, bidVol = 0;
  let askSum = 0, askVol = 0;
  
  for (const level of bids) {
    const price = parseFloat(level.price);
    const size = parseFloat(level.size);
    if (!isNaN(price) && !isNaN(size)) {
      bidSum += price * size;
      bidVol += size;
    }
  }
  
  for (const level of asks) {
    const price = parseFloat(level.price);
    const size = parseFloat(level.size);
    if (!isNaN(price) && !isNaN(size)) {
      askSum += price * size;
      askVol += size;
    }
  }
  
  if (bidVol === 0 || askVol === 0) return null;
  
  const vwapBid = bidSum / bidVol;
  const vwapAsk = askSum / askVol;
  
  // Microprice ponderado pelo volume inverso
  // Mais peso no lado com MENOS volume (mais fácil de mover)
  const totalVol = bidVol + askVol;
  const micro = (vwapBid * askVol + vwapAsk * bidVol) / totalVol;
  
  const midPrice = (vwapBid + vwapAsk) / 2;
  
  return {
    micro,
    mid: midPrice,
    spread: vwapAsk - vwapBid,
    spreadPct: (vwapAsk - vwapBid) / midPrice,
    imbalance: (bidVol - askVol) / totalVol, // -1 a +1
    bidDepth: bidVol,
    askDepth: askVol,
    vwapBid,
    vwapAsk,
    // Desvio do microprice vs midprice
    skew: (micro - midPrice) / midPrice
  };
}

// Usar microprice em vez de lastPrice para decisões
export function getFairPrice(micropriceData, lastPrice, config = {}) {
  const { useMicroprice = true, microWeight = 0.7 } = config;
  
  if (!useMicroprice || !micropriceData) {
    return lastPrice;
  }
  
  // Combinação ponderada
  return micropriceData.micro * microWeight + lastPrice * (1 - microWeight);
}
```

### 4.3 Uso no Loop Principal

```javascript
// No index.js, substituir:
// const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

// Por:
const microData = calculateMicroprice(poly.orderbook.up); // ou média dos dois lados
const fairPrice = getFairPrice(microData, lastPrice, { useMicroprice: true });
const vwapDist = vwapNow ? (fairPrice - vwapNow) / vwapNow : null;
```

---

## 5. Dynamic Hedging

### 5.1 Conceito

Estratégia de proteção que monitora posições abertas e executa ações defensivas quando sinais adversos aparecem ou quando o tempo está acabando.

**Baseado em:** "Mastering Dynamic Hedging in Short-Term Polymarket Markets" - Benjamin-Cup

### 5.2 Implementação

**Arquivo:** `src/engines/dynamicHedge.js`

```javascript
export class DynamicHedgeManager {
  constructor(config = {}) {
    this.hedgeThreshold = config.hedgeThreshold || -0.15;      // -15% P&L
    this.timeDecayThreshold = config.timeDecayThreshold || 3;  // minutos
    this.trailingStopEnabled = config.trailingStop !== false;
    this.trailingDistance = config.trailingDistance || 0.05;   // 5% retração
    this.maxHedgesPerMarket = config.maxHedges || 2;
    this.profitLockThreshold = config.profitLock || 0.20;      // 20% lucro
    
    this.hedgeCount = 0;
    this.maxPnlSeen = 0;
    this.position = null;
  }
  
  updatePosition(position) {
    this.position = position;
    if (position?.unrealizedPnl > this.maxPnlSeen) {
      this.maxPnlSeen = position.unrealizedPnl;
    }
  }
  
  evaluate(currentSignal, unrealizedPnl, timeLeft, currentPrice) {
    if (!this.position) {
      return { action: 'NONE', reason: 'no_position' };
    }
    
    // 1. Stop loss baseado em P&L
    if (unrealizedPnl < this.hedgeThreshold) {
      // Sinal mudou de direção → hedge parcial
      if (this.position.side !== currentSignal.side && this.hedgeCount < this.maxHedgesPerMarket) {
        this.hedgeCount++;
        return {
          action: 'HEDGE',
          side: currentSignal.side,
          size: this._calculateHedgeSize(),
          reason: 'stop_loss_with_flip',
          pnl: unrealizedPnl
        };
      }
      
      // Sinal mantido → sair completamente
      return {
        action: 'EXIT',
        reason: 'stop_loss',
        pnl: unrealizedPnl
      };
    }
    
    // 2. Time decay em posição perdedora
    if (timeLeft < this.timeDecayThreshold && unrealizedPnl < 0) {
      return {
        action: 'EXIT',
        reason: 'time_decay_cut',
        pnl: unrealizedPnl,
        timeLeft
      };
    }
    
    // 3. Profit locking
    if (unrealizedPnl > this.profitLockThreshold) {
      // Trailing stop
      if (this.trailingStopEnabled) {
        const drawdownFromMax = this.maxPnlSeen - unrealizedPnl;
        if (drawdownFromMax > this.trailingDistance) {
          return {
            action: 'EXIT',
            reason: 'trailing_stop',
            pnl: unrealizedPnl,
            maxPnl: this.maxPnlSeen
          };
        }
      }
      
      // Lock parcial do lucro
      if (unrealizedPnl > this.profitLockThreshold * 1.5 && this.hedgeCount === 0) {
        this.hedgeCount++;
        return {
          action: 'PARTIAL_EXIT',
          size: 0.5, // Sair 50%
          reason: 'profit_lock',
          pnl: unrealizedPnl
        };
      }
    }
    
    // 4. Reversão de sinal com lucro
    if (this.position.side !== currentSignal.side && unrealizedPnl > 0) {
      return {
        action: 'EXIT',
        reason: 'signal_reversal_with_profit',
        pnl: unrealizedPnl
      };
    }
    
    return { action: 'HOLD', reason: 'position_healthy' };
  }
  
  _calculateHedgeSize() {
    // Hedge 50% da posição original
    return 0.5;
  }
  
  reset() {
    this.hedgeCount = 0;
    this.maxPnlSeen = 0;
    this.position = null;
  }
}

// Função auxiliar para calcular P&L não realizado
export function calculateUnrealizedPnl(position, currentMarketPrice) {
  if (!position || !currentMarketPrice) return null;
  
  const side = position.side === 'UP' ? 'up' : 'down';
  const entryPrice = position.entryPrice;
  
  // Para prediction markets: preço converge para 0 ou 1
  // P&L estimado baseado no preço atual
  const priceDelta = currentMarketPrice - entryPrice;
  const direction = position.side === 'UP' ? 1 : -1;
  
  return position.usdcAmount * priceDelta * direction / entryPrice;
}
```

### 5.3 Integração no Bot

**Modificar:** `src/execution/bot.js`

```javascript
import { DynamicHedgeManager, calculateUnrealizedPnl } from '../engines/dynamicHedge.js';

const hedgeManager = new DynamicHedgeManager({
  hedgeThreshold: -0.15,
  timeDecayThreshold: 3,
  trailingStop: true,
  trailingDistance: 0.05
});

export async function onSignal({ rec, poly, priceToBeat, timeLeftMin }) {
  // ... código existente ...
  
  // Verificar se há posição aberta para hedge
  if (hasOpenPosition()) {
    const pos = getPosition();
    const side = pos.side === 'UP' ? 'up' : 'down';
    const currentPrice = poly.ok ? poly.prices?.[side] : null;
    const unrealizedPnl = calculateUnrealizedPnl(pos, currentPrice);
    
    hedgeManager.updatePosition({ ...pos, unrealizedPnl });
    
    const hedgeDecision = hedgeManager.evaluate(
      rec,
      unrealizedPnl,
      timeLeftMin,
      currentPrice
    );
    
    if (hedgeDecision.action === 'EXIT') {
      await _exitPosition(pos, hedgeDecision.reason);
      return { mode: 'exited', reason: hedgeDecision.reason, pnl: unrealizedPnl };
    }
    
    if (hedgeDecision.action === 'HEDGE') {
      // Implementar lógica de hedge (comprar lado oposto)
      await _hedgePosition(pos, hedgeDecision);
      return { mode: 'hedged', ...hedgeDecision };
    }
    
    // Continuar segurando
    return { mode: 'holding', position: pos, unrealizedPnl };
  }
  
  // ... resto do código de entrada ...
}
```

---

## 6. Latency Arbitrage Detection

### 6.1 Conceito

Explorar o lag entre movimentos de preço na Binance e reação do mercado Polymarket. Estudos mostram delays de 30-90 segundos.

**Baseado em:** "I Built a Polymarket Arbitrage Bot in 2 Hours" - Chudi.dev

### 6.2 Implementação

**Arquivo:** `src/engines/latencyArb.js`

```javascript
export class LatencyArbitrageDetector {
  constructor(config = {}) {
    this.threshold = config.threshold || 0.003;     // 0.3% mínimo
    this.timeWindow = config.timeWindow || 60000;   // 60 segundos
    this.minConfidence = config.minConfidence || 0.7;
    
    this.priceHistory = [];
    this.lastSignal = null;
  }
  
  update(binancePrice, polymarketPrice, timestamp = Date.now()) {
    this.priceHistory.push({
      timestamp,
      binance: binancePrice,
      polymarket: polymarketPrice,
      diff: binancePrice - polymarketPrice,
      diffPct: (binancePrice - polymarketPrice) / polymarketPrice
    });
    
    // Manter apenas últimos 5 minutos
    const cutoff = timestamp - 5 * 60 * 1000;
    this.priceHistory = this.priceHistory.filter(p => p.timestamp > cutoff);
    
    return this.detectSignal();
  }
  
  detectSignal() {
    if (this.priceHistory.length < 3) return null;
    
    const recent = this.priceHistory.slice(-3);
    const current = recent[recent.length - 1];
    
    // Detectar movimento recente na Binance
    const binanceMove = this._calculateMove('binance', this.timeWindow);
    if (!binanceMove || Math.abs(binanceMove.pct) < this.threshold) {
      return null;
    }
    
    // Verificar se Polymarket já reagiu
    const polyMove = this._calculateMove('polymarket', this.timeWindow);
    const polyLagging = !polyMove || Math.abs(polyMove.pct) < Math.abs(binanceMove.pct) * 0.5;
    
    if (!polyLagging) return null;
    
    // Calcular confiança baseada no tamanho do movimento
    const confidence = Math.min(Math.abs(binanceMove.pct) / 0.01, 0.95);
    
    if (confidence < this.minConfidence) return null;
    
    const direction = binanceMove.pct > 0 ? 'UP' : 'DOWN';
    const expectedMove = Math.abs(binanceMove.pct) * 0.7; // 70% do movimento
    
    const signal = {
      type: 'LATENCY_ARB',
      direction,
      confidence,
      binanceMove: binanceMove.pct,
      polyCurrent: current.polymarket,
      expectedTarget: current.polymarket * (1 + expectedMove * (direction === 'UP' ? 1 : -1)),
      timestamp: Date.now(),
      urgency: confidence > 0.85 ? 'HIGH' : 'MEDIUM'
    };
    
    this.lastSignal = signal;
    return signal;
  }
  
  _calculateMove(source, windowMs) {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    const windowData = this.priceHistory.filter(p => p.timestamp >= windowStart);
    if (windowData.length < 2) return null;
    
    const start = windowData[0][source];
    const end = windowData[windowData.length - 1][source];
    
    return {
      abs: end - start,
      pct: (end - start) / start
    };
  }
  
  // Boost no scoring baseado no sinal
  getScoreBoost(signal) {
    if (!signal) return { up: 0, down: 0 };
    
    const boost = signal.confidence > 0.85 ? 3 : 2;
    
    return signal.direction === 'UP' 
      ? { up: boost, down: 0 }
      : { up: 0, down: boost };
  }
}
```

### 6.3 Integração

```javascript
// No index.js
const latencyDetector = new LatencyArbitrageDetector({
  threshold: 0.003,
  minConfidence: 0.7
});

// No loop principal:
const latencySignal = latencyDetector.update(binanceSpot, chainlinkPrice);
if (latencySignal) {
  const boost = latencyDetector.getScoreBoost(latencySignal);
  up += boost.up;
  down += boost.down;
}
```

---

## 7. Time-Price Convergence

### 7.1 Conceito

Quando o tempo restante é curto e a diferença de preço é grande, a probabilidade converge para certeza mais rápido que o mercado precifica.

**Baseado em:** "Building a High-Probability Trading Bot for Polymarket's 5-Minute BTC Market" - Benjamin-Cup

### 7.2 Implementação

**Arquivo:** `src/engines/timePriceField.js`

```javascript
export class TimePriceConvergence {
  constructor(config = {}) {
    this.minTimeRatio = config.minTimeRatio || 0.2;      // Últimos 20% do tempo
    this.baseThreshold = config.baseThreshold || 0.001;  // 0.1% base
    this.multiplier = config.multiplier || 5;
  }
  
  evaluate(currentPrice, openPrice, timeLeft, windowMinutes) {
    const timeRatio = timeLeft / windowMinutes;
    
    // Só ativa nos últimos 20% do tempo
    if (timeRatio > this.minTimeRatio) {
      return { inField: false };
    }
    
    const priceDiff = Math.abs(currentPrice - openPrice) / openPrice;
    
    // Threshold dinâmico: quanto menos tempo, menor o movimento necessário
    // requiredDiff = baseThreshold × (1 + multiplier × (1 - timeRatio))
    const requiredDiff = this.baseThreshold * (1 + this.multiplier * (1 - timeRatio));
    
    if (priceDiff < requiredDiff) {
      return { inField: false };
    }
    
    // Dentro do campo de alta probabilidade
    const direction = currentPrice > openPrice ? 'UP' : 'DOWN';
    
    // Probabilidade estimada converge para 1 conforme tempo acaba
    // Prob = 0.5 + (priceDiff / requiredDiff) × 0.5, capped em 0.95
    const probability = Math.min(0.5 + (priceDiff / requiredDiff) * 0.5, 0.95);
    
    return {
      inField: true,
      direction,
      probability,
      priceDiff,
      timeRatio,
      requiredDiff,
      urgency: timeRatio < 0.1 ? 'CRITICAL' : timeRatio < 0.15 ? 'HIGH' : 'MEDIUM'
    };
  }
  
  // Integrar no scoring
  getScoreBoost(field) {
    if (!field?.inField) return { up: 0, down: 0 };
    
    const boost = field.probability > 0.8 ? 3 : field.probability > 0.7 ? 2 : 1;
    
    return field.direction === 'UP'
      ? { up: boost, down: 0 }
      : { up: 0, down: boost };
  }
}
```

---

## 8. Lock Strategy (Market Making)

### 8.1 Conceito

Quando não há direção clara (chop/range), comprar AMBOS os lados quando o custo por par < $1 garante lucro.

**Baseado em:** Poly-Tutor/5min-btc-polymarket-trading-bot

### 8.2 Implementação

**Arquivo:** `src/engines/lockStrategy.js`

```javascript
export class LockStrategy {
  constructor(config = {}) {
    this.maxCostPerPair = config.maxCostPerPair || 0.99;
    this.minProfit = config.minProfit || 0.01;  // Mínimo 1% lucro
    this.onlyInChop = config.onlyInChop !== false;
  }
  
  evaluate(upPrice, downPrice, regime) {
    // Só em chop/range (opcional)
    if (this.onlyInChop && !['CHOP', 'RANGE'].includes(regime)) {
      return { actionable: false, reason: 'not_in_chop' };
    }
    
    const costPerPair = upPrice + downPrice;
    const profit = 1 - costPerPair;
    
    if (costPerPair >= this.maxCostPerPair) {
      return { 
        actionable: false, 
        reason: 'cost_too_high',
        costPerPair,
        maxCost: this.maxCostPerPair
      };
    }
    
    if (profit < this.minProfit) {
      return {
        actionable: false,
        reason: 'profit_too_low',
        profit
      };
    }
    
    return {
      actionable: true,
      side: 'BOTH',
      upSize: 1,
      downSize: 1,
      costPerPair,
      profit,
      roi: profit / costPerPair,
      guaranteed: true
    };
  }
}
```

---

## 9. Integração e Configuração

### 9.1 Configurações Adicionais

**Adicionar em:** `src/config.js`

```javascript
export const ADVANCED_CONFIG = {
  // Order Flow
  orderFlow: {
    enabled: true,
    depth: 10,              // Níveis do book para OBI
    obiThreshold: 0.6,      // Threshold para sinal forte
    historySize: 60         // Amostras de histórico (1 minuto)
  },
  
  // CVD
  cvd: {
    enabled: true,
    resetInterval: '1h',    // Reset do CVD
    divergenceLookback: 20, // Períodos para detectar divergência
    minVolumeThreshold: 10  // Volume mínimo para confiança
  },
  
  // Microprice
  microprice: {
    enabled: true,
    levels: 5,              // Níveis do book
    weight: 0.7             // Peso do microprice vs lastPrice
  },
  
  // Dynamic Hedging
  hedging: {
    enabled: true,
    hedgeThreshold: -0.15,      // Hedge em -15% P&L
    timeDecayThreshold: 3,      // Sair em últimos 3min se perdendo
    trailingStop: true,
    trailingDistance: 0.05,     // 5% retração do máximo
    profitLock: 0.20,           // Lock em 20% lucro
    maxHedges: 2
  },
  
  // Latency Arbitrage
  latencyArb: {
    enabled: true,
    threshold: 0.003,       // 0.3% mínimo
    timeWindow: 60000,      // 60 segundos
    minConfidence: 0.7
  },
  
  // Time-Price Convergence
  timePrice: {
    enabled: true,
    minTimeRatio: 0.2,      // Últimos 20% do tempo
    baseThreshold: 0.001,   // 0.1%
    multiplier: 5
  },
  
  // Lock Strategy
  lock: {
    enabled: true,
    maxCostPerPair: 0.99,
    minProfit: 0.01,
    onlyInChop: true
  }
};
```

### 9.2 Loop Principal Atualizado

**Modificar:** `src/index.js`

```javascript
import { OrderFlowAnalyzer } from './indicators/orderFlowImbalance.js';
import { CVDAnalyzer } from './indicators/cvd.js';
import { calculateMicroprice, getFairPrice } from './indicators/microprice.js';
import { DynamicHedgeManager, calculateUnrealizedPnl } from './engines/dynamicHedge.js';
import { LatencyArbitrageDetector } from './engines/latencyArb.js';
import { TimePriceConvergence } from './engines/timePriceField.js';
import { LockStrategy } from './engines/lockStrategy.js';
import { ADVANCED_CONFIG } from './config.js';

// Inicializar módulos avançados
const orderFlow = new OrderFlowAnalyzer(ADVANCED_CONFIG.orderFlow.depth);
const cvdAnalyzer = new CVDAnalyzer({ resetInterval: ADVANCED_CONFIG.cvd.resetInterval });
const hedgeManager = new DynamicHedgeManager(ADVANCED_CONFIG.hedging);
const latencyDetector = new LatencyArbitrageDetector(ADVANCED_CONFIG.latencyArb);
const timePriceConv = new TimePriceConvergence(ADVANCED_CONFIG.timePrice);
const lockStrategy = new LockStrategy(ADVANCED_CONFIG.lock);

// No loop principal:
async function main() {
  // ... código de inicialização ...
  
  while (true) {
    try {
      // ... fetch de dados ...
      
      // ===== ANÁLISE AVANÇADA =====
      
      // 1. Order Flow
      const obiData = orderFlow.update(poly.orderbook.up);
      
      // 2. CVD (processar trades do WebSocket)
      const cvdState = cvdAnalyzer.getCurrentState();
      const cvdDivergence = cvdAnalyzer.detectDivergence();
      const cvdAbsorption = cvdAnalyzer.detectAbsorption();
      
      // 3. Microprice
      const microData = calculateMicroprice(poly.orderbook.up);
      const fairPrice = getFairPrice(microData, lastPrice, ADVANCED_CONFIG.microprice);
      
      // 4. Latency Arbitrage
      const latencySignal = latencyDetector.update(binanceSpot, chainlinkPrice);
      
      // 5. Time-Price Convergence
      const openPrice = priceToBeatState.value;
      const tpField = timePriceConv.evaluate(fairPrice, openPrice, timeLeftMin, 15);
      
      // 6. Lock Strategy (se em chop)
      const lockOp = lockStrategy.evaluate(poly.prices.up, poly.prices.down, regimeInfo.regime);
      
      // ===== SCORING ATUALIZADO =====
      const scored = scoreDirection({
        price: fairPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim,
        // NOVOS PARÂMETROS
        obi: obiData?.obi,
        obiDivergence: obiData?.divergence,
        obiSentiment: obiData?.sentiment,
        cvdTrend: cvdState?.trend,
        cvdDivergence,
        cvdAbsorption,
        latencySignal,
        tpField
      });
      
      // ... resto do código ...
      
      // ===== HEDGING =====
      if (botStatus.position) {
        const pnl = calculateUnrealizedPnl(botStatus.position, currentPrice);
        hedgeManager.updatePosition({ ...botStatus.position, unrealizedPnl: pnl });
        
        const hedgeDecision = hedgeManager.evaluate(rec, pnl, timeLeftMin, currentPrice);
        
        if (hedgeDecision.action !== 'HOLD') {
          await executeHedgeDecision(hedgeDecision);
        }
      }
      
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
    
    await sleep(CONFIG.pollIntervalMs);
  }
}
```

### 9.3 Score Direction Atualizado

**Modificar:** `src/engines/probability.js`

```javascript
export function scoreDirection(inputs) {
  const {
    price, vwap, vwapSlope, rsi, rsiSlope, macd,
    heikenColor, heikenCount, failedVwapReclaim,
    // Order Flow
    obi, obiDivergence, obiSentiment,
    // CVD
    cvdTrend, cvdDivergence, cvdAbsorption,
    // Latency
    latencySignal,
    // Time-Price
    tpField
  } = inputs;

  let up = 1;
  let down = 1;

  // ... indicadores existentes ...

  // ===== ORDER FLOW =====
  if (obi !== null && !isNaN(obi)) {
    if (obi > 0.6) up += 2;
    if (obi < -0.6) down += 2;
    if (obi > 0.3 && obi <= 0.6) up += 1;
    if (obi < -0.3 && obi >= -0.6) down += 1;
  }
  
  if (obiDivergence?.type === 'BULLISH_DIVERGENCE') up += 2;
  if (obiDivergence?.type === 'BEARISH_DIVERGENCE') down += 2;
  
  if (obiSentiment?.strength > 0.5) {
    if (obiSentiment.to === 'BULLISH') up += 1;
    if (obiSentiment.to === 'BEARISH') down += 1;
  }

  // ===== CVD =====
  if (cvdTrend === 'BUYING') up += 1;
  if (cvdTrend === 'SELLING') down += 1;
  
  if (cvdDivergence?.type === 'BULLISH') up += 2;
  if (cvdDivergence?.type === 'BEARISH') down += 2;
  
  if (cvdAbsorption?.type === 'BULLISH_ABSORPTION') up += 1;
  if (cvdAbsorption?.type === 'BEARISH_ABSORPTION') down += 1;

  // ===== LATENCY ARBITRAGE =====
  if (latencySignal?.type === 'LATENCY_ARB') {
    const boost = latencySignal.confidence > 0.85 ? 3 : 2;
    if (latencySignal.direction === 'UP') up += boost;
    if (latencySignal.direction === 'DOWN') down += boost;
  }

  // ===== TIME-PRICE CONVERGENCE =====
  if (tpField?.inField) {
    const boost = tpField.probability > 0.8 ? 3 : tpField.probability > 0.7 ? 2 : 1;
    if (tpField.direction === 'UP') up += boost;
    if (tpField.direction === 'DOWN') down += boost;
  }

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}
```

---

## 10. Referências

### Artigos e Papers

1. **"How to Farm Edge in Polymarket's 15-Minute Bitcoin Markets"** - Daniel KALU
   - Estratégia de delta-neutral spread farming

2. **"Mastering Dynamic Hedging in Short-Term Polymarket Markets"** - Benjamin-Cup
   - Técnicas de hedging dinâmico para proteção de capital

3. **"I Built a Polymarket Arbitrage Bot in 2 Hours"** - Chudi Nnorukam
   - Latency arbitrage entre Binance e Polymarket

4. **"Building a High-Probability Trading Bot for Polymarket's 5-Minute BTC Market"** - Benjamin-Cup
   - Time-price convergence strategies

5. **"High-frequency Statistical Arbitrage Based on Stationarized Order Flow Imbalance"** - Cont, Kukanov, Stoikov
   - Fundamentos teóricos de OBI

6. **"The Importance of Low Latency to Order Book Imbalance Trading Strategies"** - arXiv:2006.08682

### Repositórios

- **Poly-Tutor/5min-btc-polymarket-trading-bot** - Lock strategy e hedging
- **FrondEnt/PolymarketBTC15mAssistant** - Base do projeto atual

### Recursos Chineses

- **CVD 完全指南** (Kalena) - Guia completo de CVD para traders chineses
- **Order Flow Imbalance Scalping** (Traders.MBA) - Estratégias de scalping com OBI

---

## 📊 Checklist de Implementação

- [ ] Criar `src/indicators/orderFlowImbalance.js`
- [ ] Criar `src/indicators/cvd.js`
- [ ] Criar `src/indicators/microprice.js`
- [ ] Criar `src/engines/dynamicHedge.js`
- [ ] Criar `src/engines/latencyArb.js`
- [ ] Criar `src/engines/timePriceField.js`
- [ ] Criar `src/engines/lockStrategy.js`
- [ ] Atualizar `src/engines/probability.js`
- [ ] Atualizar `src/execution/bot.js`
- [ ] Atualizar `src/config.js`
- [ ] Atualizar `src/index.js`
- [ ] Testar em paper trading por 1 semana
- [ ] Ajustar thresholds baseado em resultados
- [ ] Deploy em produção com capital reduzido

---

*Documento gerado em: Maio 2026*  
*Baseado em pesquisa de mercado e microestrutura de mercado*