# OpenClaw Kalshi Bot: Full Documentation

## 1) Overview

This project is a production-oriented TypeScript/Node.js trading system for Kalshi with:

- Automated strategy execution (DRY_RUN default, LIVE gated)
- Local dashboard + JSON API
- OpenClaw Telegram notifications + command controls
- SQLite persistence
- Market intelligence (quality, probability, execution, edge gating)
- Learning loop (decision logging, attribution, calibration, guarded profile updates)

Core principle: the bot only attempts trades when hard risk controls and intelligence gates agree.

## 2) Tech Stack

- Runtime: Node.js (>= 18.18)
- Language: TypeScript
- Server: Express
- Storage: SQLite via `better-sqlite3`
- Config: `dotenv`
- Testing: Vitest
- Build: `tsc`

`package.json` scripts currently used:

- `npm start` -> build + run app
- `npm run test` -> build + run unit tests
- `npm run sanity` / `npm run kalshi:authcheck` -> auth connectivity check
- `npm run scan` -> one-shot market scan
- `npm run replay` -> offline replay report

## 3) Project Structure

Main directories:

- `src/index.ts` -> bot runtime + dashboard boot
- `src/kalshi/` -> Kalshi client/auth/orderbook/market integration
- `src/intel/` and `src/intelligence/` -> quality/probability/execution/edge scoring
- `src/strategy/` -> strategy decision logic
- `src/risk/` -> risk guards (daily loss, open positions, exposure)
- `src/learning/` -> calibration, attribution, profile learning/promotion controls
- `src/dashboard/` -> server-rendered UI + API routes
- `src/settings/` -> settings + secure secret storage
- `src/db/` -> schema, migrations, query helpers
- `src/notify/` -> OpenClaw notifier + command listener
- `scripts/` -> sanity/scan/replay entry points
- `tests/` -> unit tests

## 4) Setup (macOS)

### 4.1 Install + bootstrap

```bash
cd /Users/corey/Desktop/OpenClaw
npm install
cp .env.example .env
```

### 4.2 Required local secret master key

Set `LOCAL_MASTER_KEY` in `.env` to a long random value.

Example generator:

```bash
openssl rand -base64 48
```

Paste into:

```dotenv
LOCAL_MASTER_KEY=<generated-value>
```

### 4.3 Start app

```bash
npm start
```

Dashboard:

- `http://127.0.0.1:3000`

Health:

- `http://127.0.0.1:3000/health`

### 4.4 Configure Kalshi credentials (recommended path)

1. Open dashboard -> `/help`
2. Save:
   - `KALSHI_KEY_ID`
   - `KALSHI_PRIVATE_KEY_PEM`
   - `KALSHI_ENV` (`demo` or `prod`)
3. Run **Test Kalshi Auth**

Alternative CLI check:

```bash
npm run kalshi:authcheck
```

## 5) Secrets and Security Model

- Non-secrets -> SQLite settings table
- Secrets -> secure store abstraction
  - Preferred: OS keychain (when available)
  - Fallback: AES-256-GCM encrypted storage with `LOCAL_MASTER_KEY`
- Secret values are masked in UI and never returned in full by API
- Logging redacts common sensitive fields
- Notifications do not include secrets

## 6) Run Modes

### 6.1 DRY_RUN (default)

- Simulates order attempts
- Uses real market data for detection/evaluation
- Writes attempts/results to DB
- No live order placement

### 6.2 LIVE mode

LIVE requires all gates:

- `DRY_RUN=false`
- `LIVE_TRADING=true`
- UI acknowledgment checked
- Valid `LIVE_CONFIRM_CODE` entered
- Risk limits valid

If any gate fails, orders are blocked.

## 7) Runtime Execution Flow

Each scan tick:

1. Read runtime settings/flags
2. Pull market set through adapter
3. Fetch orderbook snapshots
4. Compute derived pricing/liquidity
5. Classify market type and parse metadata
6. Compute `MarketQualityScore`
7. Compute model probability (`p_model`) via probability engine
8. Compute execution estimates (`fillProb`, expected cost)
9. Apply `EdgeGate`
10. Apply hard risk guards
11. Rank candidates and attempt top N
12. Poll/reconcile order states
13. Update positions/PnL/perf tables
14. Emit dashboard + notification updates

## 8) Strategy and Intelligence Algorithms

## 8.1 Strategy Layer

Primary strategy family:

- Near-expiry entry around configured price (`targetPriceCents`)
- Window-based eligibility (`timeWindowSec`)
- Exact-price or relaxed behavior (`exactPriceOnly`)

Configurable variants are exposed via dashboard config.

## 8.2 Market Type Classification

Classifier detects and structures market semantics:

- Crypto threshold/touch forms
- Weather types (snow/rain/temp)
- Generic fallback

Extracted fields can include:

- underlying symbol/entity
- threshold/strike
- location
- unit
- time window

If parsing fails, market is marked non-tradeable with explicit reason.

## 8.3 MarketQualityScore (0-100)

Inputs include:

- spread
- depth/liquidity near target level
- volume
- time-to-close
- resolution risk features (ambiguity terms)
- market-type risk adjustments

Output:

- numeric score
- reason list used in UI/API

Trading is blocked below `MIN_QUALITY_SCORE`.

## 8.4 Probability Engines

### CryptoProbabilityEngine

Uses BTC spot feed + volatility estimation:

- Spot source: Coinbase WS (with fallback polling)
- Realized volatility tracking (EWMA/log returns)
- Terminal crossing estimation (GBM approximation)
- Barrier/touch approximation for touch-style markets

Returns:

- `p_model` (model probability)
- confidence based on data freshness/stability

### WeatherProbabilityEngine

Uses NWS data (no API key required):

- Forecast/grid ingestion
- Window alignment
- Accumulation/threshold probability estimation
- Cached requests to reduce rate-limit pressure
- Confidence tied to data completeness/freshness

Calibration hooks adjust variance behavior from realized outcomes.

## 8.5 ExecutionModel

Estimates:

- fill probability at target level
- expected execution cost (slippage + configured fees)

Inputs:

- current orderbook depth
- historical fill behavior in similar conditions

## 8.6 EdgeGate

Trade permission logic:

- `edge = p_model - price_implied - expectedCostAdjustment`
- require `edge >= MIN_EDGE`
- require `fillProb >= MIN_FILL_PROB`
- require `qualityScore >= MIN_QUALITY_SCORE`

If any condition fails, decision is `NOOP` with reasons.

## 9) Learning and Self-Improvement

The bot does not "free-form change code"; it learns through controlled parameter/profile selection.

Learning components:

- Decision logging for every evaluated opportunity
- Outcome attribution (why wins/losses occurred)
- Feature calibration from realized outcomes
- Shadow challenger profiles evaluated off-line/in parallel
- Promotion/rollback rules with minimum sample and drawdown guardrails

Typical reinforcement loop:

1. Collect resolved trade outcomes + model features
2. Re-estimate feature weights / profile score
3. Compare challenger vs champion on score function
4. Promote only if statistically and risk-wise acceptable
5. Auto-rollback on sustained drawdown deterioration

This creates bounded adaptation rather than unbounded model drift.

## 10) Risk Controls

Hard controls:

- `MAX_OPEN_POSITIONS`
- `DAILY_LOSS_LIMIT_USD`
- `MAX_TOTAL_EXPOSURE_USD`
- `MAX_PER_SYMBOL_EXPOSURE_USD`
- `MAX_PER_LOCATION_EXPOSURE_USD`
- `CORRELATION_GUARD`
- Stop switch: `STOP_NEW_TRADES`

Execution discipline:

- aggressive cancel timeout behavior
- no price chasing when cancel conditions trigger
- duplicate protection / cooldown logic

## 11) Time Sync and Performance

Time correctness:

- drift estimate from server time references
- effective runtime time uses drift correction in expiry checks
- dashboard warning on elevated drift

Perf instrumentation includes (with percentile views):

- scan loop duration
- orderbook fetch duration
- candidate->submit latency
- cancel latency

Perf data is persisted and available through `/api/perf`.

## 12) Dashboard and API

Main pages:

- `/` Home
- `/browse` Market browser
- `/market/:ticker` Market detail
- `/trades`
- `/report`
- `/performance`
- `/intelligence`
- `/intel/crypto`
- `/intel/weather`
- `/config`
- `/help`

Key APIs:

- `GET /health`
- `GET /api/settings`
- `POST /api/settings`
- `POST /api/setup/kalshi/test`
- `GET /api/browse/markets`
- `GET /api/browse/market/:ticker`
- `GET /api/stats`
- `GET /api/report`
- `GET /api/perf`
- `GET /api/intelligence/top`
- `GET /api/intelligence/market/:ticker`
- `POST /api/control/stop`
- `POST /api/control/start`

## 13) OpenClaw Integration

Notification delivery command:

```bash
openclaw message send --channel telegram --target <configuredTarget> --message "<message>"
```

Control methods:

1. Commands file (`STOP`, `START`, `STATUS`)
2. Dashboard controls
3. Optional OpenClaw automation writing to command file

## 14) Deployment (macOS baseline)

Recommended process manager:

```bash
npm install -g pm2
cd /Users/corey/Desktop/OpenClaw
pm2 start "npm start" --name openclaw-kalshi-bot
pm2 save
pm2 startup
```

Operational checks:

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/api/stats
curl -s http://127.0.0.1:3000/api/perf
```

## 15) Troubleshooting

### 15.1 No trades firing

Check:

- `STOP_NEW_TRADES` status
- LIVE gate state (`dryRun`, `liveTrading`, confirm gate)
- quality/edge/fill thresholds too strict
- open position cap reached
- daily loss limit reached

Inspect:

- blocked reasons on dashboard
- `events` table
- opportunity evaluation outputs

### 15.2 Rate limit / `too many requests`

- increase scan interval
- reduce `topCandidatesPerTick`
- enable stronger request caching
- avoid overly broad browse polling at high frequency

### 15.3 Auth errors

- verify `KALSHI_KEY_ID`
- verify full PEM formatting
- verify selected environment/base URL
- run `npm run kalshi:authcheck`

### 15.4 Drift warnings

- keep system time synced (NTP)
- avoid heavy local load causing latency spikes

## 16) Testing and Replay

Run tests:

```bash
npm run test
```

Run one-shot scan:

```bash
npm run scan
```

Run replay:

```bash
npm run replay -- --from=2026-02-01 --to=2026-02-24
```

Replay outputs report JSON files in `./reports`.

## 17) Practical Performance Notes

- A sustained high win-rate target is not guaranteed in live markets.
- Focus on expected value, controlled downside, and robust execution.
- Increase size only after stable live metrics across sufficient sample.
- Keep strategy and risk changes versioned; change one major variable at a time.

## 18) Compliance and Operational Caution

- Keep secrets local and rotated if exposed.
- Use dedicated API credentials per bot environment.
- Treat automated trading as high-risk software.
- Validate behavior in DRY_RUN before enabling LIVE.

