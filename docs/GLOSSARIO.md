# Glossário — em português simples

Termos que mais aparecem neste projeto (bots de previsão BTC 15m up/down em
Polymarket/Kalshi), explicados de forma simples e com exemplos do próprio bot.
Qualquer termo novo que aparecer, é só pedir pra adicionar aqui.

## 1. Como o mercado funciona

- **Mercado de previsão (prediction market):** você aposta em SIM/NÃO sobre um evento.
  Aqui: "o BTC vai estar **mais alto** daqui a 15 min?". Se acertar, cada cota vira
  US$ 1; se errar, vira US$ 0.
- **UP / DOWN:** os dois lados da aposta. UP = "vai subir", DOWN = "vai cair" até o
  fim da janela.
- **Strike / `priceToBeat` (preço a bater):** o preço de referência do início da
  janela. No fim, comparam o preço final com ele pra decidir quem ganhou.
  Ex.: strike = 63.000; se terminar em 63.010, o UP ganha.
- **Liquidação (settlement):** o momento em que a janela fecha e decidem
  ganhador/perdedor.
- **Oráculo (oracle):** a fonte de preço "oficial" usada na liquidação (Chainlink ou
  o spot da Binance). Importa muito — quando ele **congela** (trava no mesmo preço),
  dá resultado falso (veja "oráculo congelado").
- **Spread / bid / ask / orderbook:** o "balcão" de ofertas. **Bid** = maior preço que
  alguém paga pra comprar; **ask** = menor preço que alguém aceita vender; **spread**
  = a diferença entre os dois. Spread grande = mais caro pra entrar/sair.

## 2. Ganhar ou perder dinheiro

- **Stake / tamanho da ordem:** quanto você aposta por operação. No bot, o padrão é
  **US$ 5**.
- **PnL (profit and loss):** lucro ou prejuízo, em dólares. PnL positivo = ganhou.
- **Taxa de acerto (win rate):** % de operações que deram certo. Ex.: 60 de 100 = 60%.
- **Ponto de equilíbrio (breakeven):** a taxa de acerto mínima pra não perder dinheiro
  (já contando preço de entrada e taxas). Aqui fica em torno de **~52%**. Abaixo
  disso, você perde no longo prazo mesmo "acertando às vezes".
- **Edge (vantagem):** o quanto você está **acima** do breakeven. É a sua margem real.
  O sinal do bot está em **~53,7%–55,5%** de acerto vs ~52% de breakeven — vantagem
  pequena, mas existente.
- **ROI (retorno sobre o investido):** lucro dividido pelo total arriscado, em %. Mede
  eficiência, não só o total.
- **Drawdown (rebaixamento):** a maior queda do saldo do pico até o fundo — "qual o
  pior tombo que você aguentou". Sequências de perdas são normais: com 60% de acerto,
  uma sequência de 4–5 perdas acontece a cada ~40 operações.

## 3. O "cérebro" do bot

- **Calibração (calibration):** a tabelinha que estima a **chance** de subir/descer em
  cada situação. É o coração da decisão de apostar.
- **OOS / fora da amostra (out-of-sample):** testar o modelo em dados que ele **não
  usou pra aprender**. É o teste anti-autoengano — se vai bem aqui, a vantagem é
  provavelmente real.
- **Overfitting (sobreajuste):** quando o modelo "decora" o ruído recente em vez de
  aprender o padrão. Foi o **erro original** deste bot — por isso recalibrar com muita
  frequência é perigoso.
- **Drift (deriva):** quando a realidade começa a se afastar do que o modelo espera
  (ex.: o modelo achava 58% de acerto, mas a prática virou 51%). É o sinal de que
  talvez seja hora de recalibrar.

## 4. As proteções (guard-rails do bot)

- **Filtro de lateralização (chop filter):** trava operações quando o mercado está "de
  lado" (sem direção clara), onde o bot acerta menos. Quanto **maior** o número
  (threshold), mais permissivo. O bot 15m usa um filtro mais rígido (**45**) que os
  outros.
- **Cooldown:** uma pausa forçada antes de repetir o mesmo lado, e uma pausa maior
  depois de uma perda. Evita "empilhar" a mesma aposta errada várias vezes seguidas.
- **Oráculo congelado (frozen oracle) / void (anulado):** quando a fonte de preço trava
  no mesmo valor, o resultado é falso. O bot **detecta e anula** essas operações (void)
  em vez de contá-las — senão envenenam suas estatísticas.
- **Kill-switch / limite de perda diária:** um "disjuntor". Se as perdas do dia passam
  de um limite (no caso, **US$ 10**), o bot para de operar. Protege contra um dia ruim
  virar um desastre.

## 5. Modo de operação

- **Paper trading:** operar com dinheiro **fictício**, registrando como teria sido com
  dinheiro real — pra validar a estratégia sem risco. É o que os 3 bots fazem hoje.
  Por isso protegemos tanto o histórico: ele é a prova de que a vantagem existe antes
  de arriscar dinheiro de verdade.
