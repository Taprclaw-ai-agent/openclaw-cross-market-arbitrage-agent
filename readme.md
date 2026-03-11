# Prediction Arbitrage

**openclaw-cross-market-arbitrage-agent**

Cross-venue arbitrage infrastructure for prediction markets.

This project monitors markets on:

* Kalshi
* Polymarket

It detects price discrepancies on matched contracts (for example BTC 15-minute up/down markets), applies risk checks, and executes hedged trades across venues.

The system is designed around an **event-driven architecture inspired by OpenClaw agents**, where market data, detection, risk management, and execution are cleanly separated.

---

# Demo

A short video of the arbitrage agent dashboard showing live market data, arbitrage opportunities, and session profit:

<video src="https://raw.githubusercontent.com/Taprclaw-ai-agent/openclaw-cross-market-arbitrage-agent/main/arbitrage-agent-demo.mp4" controls width="640"></video>

---

# What this project does

Prediction markets often list the **same event across multiple platforms**, but their prices are not always perfectly aligned.

Example:

```
Polymarket BTC UP (15m) = 0.56
Kalshi BTC UP (15m)     = 0.52
```

If the price difference is large enough to cover fees and slippage, there is a potential **arbitrage opportunity**.

This system:

1. Streams real-time orderbook data from both venues
2. Normalizes contracts into a shared format
3. Detects profitable spreads
4. Runs risk checks
5. Executes both legs of the trade

The goal is to capture **cross-market inefficiencies while remaining market-neutral**.

---

# Real Arb Space Status

Below are **real screenshots** comparing Polymarket vs Kalshi for the same BTC Up/Down 15-minute markets. These show the actual cross-venue discrepancies this agent is designed to detect and exploit.

## Same event, different prices

Polymarket and Kalshi can report different price targets, current prices, and contract odds **at the same moment** for the same underlying event (BTC 15m up/down, Feb 27, 2026).

![Polymarket vs Kalshi — same event](polymarket-kalshi-same-event.png)

| | Polymarket | Kalshi |
|--|------------|--------|
| **Price to beat** | $67,891.94 | $67,925.07 |
| **Current price** | $67,902.69 | $67,930.73 |
| **Up contract** | 52¢ | 43¢ |
| **Down contract** | 49¢ | 58¢ |
| **Volume** | $5.4K | $40,966 |

Different strike prices and odds for the same outcome → arbitrage opportunity.

## Different market states, different liquidity

Contract windows, liquidity, and implied probabilities can diverge significantly across venues.

![Polymarket vs Kalshi — different state](polymarket-kalshi-different-state.png)

| | Polymarket | Kalshi |
|--|------------|--------|
| **Time window** | Feb 27, 3:15–3:30 AM ET | Feb 27, 12:15–12:30 AM PST |
| **Up contract** | 91¢ | 72¢ |
| **Down contract** | 10¢ | 44¢ |
| **Volume** | $41.4K | $124,789 |
| **Implied chance** | — | 55% |

The agent normalizes these differences, matches equivalent contracts across timezones, and only triggers when the spread exceeds fees + slippage.

---

# System Architecture

```
Kalshi WS ──┐                               ┌── Risk Manager ── Command Bus
            ├── Raw Bus ── Normalization ───┼── Detector ───── Signal Bus
Polyma WS ──┘         (canonical keys)      └── Execution Engine (Kalshi + Polymarket)
                                                       │
                                                       └── Fills Bus ── Strategy
```

### Market feeds

WebSocket connections stream best bid / ask data from both exchanges.

### Normalization

Each platform represents markets differently.
Prices are converted to a unified probability format and mapped to a shared `canonicalEventKey`.

This allows equivalent markets to be matched across venues.

### Detector

The detector compares mid prices across exchanges.

If the spread exceeds:

```
edgeThreshold - fees - slippage
```

a trading signal is emitted.

### Risk manager

Before executing a trade, several safety checks run:

* daily loss limit
* stale quote protection
* cooldown between trades
* max capital per trade

### Execution

If the trade is approved, the system places **both legs in parallel**:

* long venue → buy YES / UP
* hedge venue → buy NO / DOWN

### Strategy layer

Fill events are tracked to monitor metrics such as:

* PnL
* slippage
* execution latency
* trade frequency

---

# Real-world edge cases this bot handles

Cross-market arbitrage sounds simple in theory, but real trading systems must deal with many edge cases.

This project was designed with those realities in mind.

---

### Liquidity illusions

Sometimes the top-of-book price looks profitable but the available size is extremely small.

Example:

```
Polymarket YES = 0.55 (size 5)
Kalshi YES     = 0.50 (size 1)
```

If the bot trades blindly, the price moves immediately and the arbitrage disappears.

The detector checks **available size and depth** before emitting signals.

---

### Stale quotes

Prediction markets sometimes update at different speeds.

If one exchange updates faster than the other, the system might see a **fake arbitrage opportunity**.

To prevent this, the bot enforces:

* quote timestamps
* stale quote rejection (`staleQuoteMs`)
* synchronized event matching

---

### Partial fills

One of the biggest risks in arbitrage trading:

```
Leg A fills
Leg B does not fill
```

Now the system has directional exposure.

The execution engine includes logic for:

* monitoring partial fills
* retrying the second leg
* cancelling remaining orders
* emergency hedging if necessary

---

### Fees and hidden costs

Prediction markets include several costs:

* trading fees
* settlement fees
* slippage
* price impact

The detector only emits a signal if:

```
spread > fees + slippage + edgeThreshold
```

This prevents trades that look profitable but are actually negative after costs.

---

### Cooldown protection

Markets can oscillate around the same price level.

Without a cooldown, the system might repeatedly trade the same signal.

The risk manager enforces a **minimum delay between trades**.

---

### Market outages

Exchange APIs and WebSocket connections occasionally drop.

Market feeds include:

* automatic reconnect logic
* heartbeat monitoring
* automatic resubscription

If feeds become unstable, trading pauses automatically.

---

# Prerequisites

* Node.js 18+
* PostgreSQL (optional persistence layer)
* Kalshi account (API key + RSA private key)
* Polymarket account (wallet + Gnosis Safe proxy)

---

# Setup

Install dependencies:

```
npm install
```

Copy environment template:

```
cp .env.example .env
```

Then edit `.env` and add your credentials.

---

# Configuration

Configuration is loaded from:

```
configs/default.yaml
```

Key parameters:

| Section   | Key                  | Description                    |
| --------- | -------------------- | ------------------------------ |
| exchanges | `marketTicker`       | Kalshi series (ex: `KXBTC15M`) |
| risk      | `maxCapitalPerTrade` | Maximum trade size             |
| risk      | `maxDailyLoss`       | Stop trading after this loss   |
| risk      | `staleQuoteMs`       | Reject old signals             |
| risk      | `cooldownMs`         | Minimum delay between trades   |
| strategy  | `edgeThreshold`      | Minimum arbitrage edge         |

---

# Environment Variables

| Variable                 | Description                       |
| ------------------------ | --------------------------------- |
| `DATABASE_URL`           | PostgreSQL connection string      |
| `KALSHI_API_KEY`         | Kalshi API key                    |
| `KALSHI_PRIVATE_KEY_PEM` | Kalshi RSA private key            |
| `KALSHI_DEMO`            | Use Kalshi demo API               |
| `POLYMARKET_PRIVATE_KEY` | Wallet private key                |
| `POLYMARKET_PROXY`       | Gnosis Safe proxy                 |
| `DRY_RUN`                | Simulate trades without executing |

---

# Running

Development mode:

```
npm run dev
```

Production:

```
npm start
```

Dry run mode (recommended first):

```
DRY_RUN=true npm run dev
```

---

# Project Structure

```
src/
├── index.ts           # Entry point
├── config.ts          # YAML config loader
├── bus.ts             # Event buses
├── types.ts           # Shared types
├── market-data/
│   ├── kalshi.ts
│   └── polymarket.ts
├── normalization.ts
├── detector.ts        # Arbitrage detection logic
├── risk.ts            # Risk checks
├── execution.ts       # Order placement
├── strategy.ts        # Metrics + tracking
└── meta.ts            # Meta controller placeholder

configs/default.yaml
```

---

# Why this project exists

Prediction markets are still **relatively inefficient compared to traditional financial markets**.

Different venues can disagree on the probability of the same event by several percentage points.

This project explores how to build a **clean, modular arbitrage engine** capable of detecting and capturing those inefficiencies in real time.

It also serves as a playground for experimenting with:

* event-driven trading systems
* cross-market arbitrage infrastructure
* OpenClaw-style agent architectures
* prediction market microstructure

---

# Future Improvements

Planned improvements include:

* historical backtesting engine
* multi-region deployment (NYC / EU servers)
* advanced position sizing (Kelly-based allocation)
* latency monitoring and performance metrics
* additional prediction market integrations

---

# About me

I work on:

* AI agent systems
* trading automation
* prediction market infrastructure
* blockchain / DeFi protocols

This repository reflects my interest in **building robust, real-world trading systems rather than simple scripts**.

If you're working on:

* prediction market automation
* cross-exchange arbitrage
* AI agent trading systems
* crypto trading infrastructure

feel free to reach out.

**Contact:** [Telegram](https://t.me/snipmaxi)

---

# License

MIT
