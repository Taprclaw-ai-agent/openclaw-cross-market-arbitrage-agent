/**
 * Execution engine: places real Kalshi and Polymarket orders for arbitrage legs.
 * Uses DRY_RUN=true to simulate without live orders.
 */
import { Subscription } from "rxjs";
import { Configuration, MarketApi, OrdersApi } from "kalshi-ts-sdk";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, Chain, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BroadcastBus } from "./bus.js";
import type { Logger } from "./logger.js";
import type { ExecutionCommand, FillEvent } from "./types.js";
import { fetchTokenIdsForSlug } from "./market-data/polymarket.js";

const DRY_RUN = process.env.DRY_RUN === "true" || process.env.KALSHI_BOT_DRY_RUN === "true";

const KALSHI_BASE_PATHS = {
  prod: "https://api.elections.kalshi.com/trade-api/v2",
  demo: "https://demo-api.kalshi.co/trade-api/v2",
} as const;
const POLYMARKET_CREDENTIAL_PATH =
  process.env.POLYMARKET_CREDENTIAL_PATH ?? resolve(process.cwd(), "data/credential.json");
const POLYMARKET_CLOB_URL = process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com";
const POLYMARKET_CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID ?? Chain.POLYGON);

interface ExecutionOptions {
  commandSource: BroadcastBus<ExecutionCommand>;
  fillsBus: BroadcastBus<FillEvent>;
  logger: Logger;
}

export function startExecutionEngine({
  commandSource,
  fillsBus,
  logger,
}: ExecutionOptions): () => void {
  const subscription = new Subscription();

  subscription.add(
    commandSource.stream().subscribe({
      next: (command) => {
        if (DRY_RUN) {
          logger.info({ command }, "[DRY_RUN] Would execute arb legs");
          simulateFill(command, fillsBus, logger);
          return;
        }
        executeArbLegs(command, fillsBus, logger);
      },
      error: (error) => logger.error({ error }, "Execution stream error"),
    })
  );

  return () => {
    logger.info("Shutting down execution engine");
    subscription.unsubscribe();
  };
}

async function executeArbLegs(
  command: ExecutionCommand,
  fillsBus: BroadcastBus<FillEvent>,
  logger: Logger
): Promise<void> {
  const t0 = Date.now();
  const kalshiCount = Math.max(1, Math.round(command.size));
  const polySizeUsdc = Math.max(0.01, Math.min(command.size * 2, 500));

  const longPromise =
    command.longVenue === "kalshi"
      ? placeKalshiOrder(command.longMarketId, "yes", kalshiCount)
      : placePolymarketOrder(command.longMarketId, "up", polySizeUsdc);

  const shortPromise =
    command.shortVenue === "kalshi"
      ? placeKalshiOrder(command.shortMarketId, "no", kalshiCount)
      : placePolymarketOrder(command.shortMarketId, "down", polySizeUsdc);

  const [longResult, shortResult] = await Promise.all([longPromise, shortPromise]);

  const latencyMs = Date.now() - t0;
  const longOk = !("error" in longResult);
  const shortOk = !("error" in shortResult);

  const fillError =
    !longOk && !shortOk
      ? `Long: ${(longResult as { error: string }).error}; Short: ${(shortResult as { error: string }).error}`
      : !longOk
        ? (longResult as { error: string }).error
        : !shortOk
          ? (shortResult as { error: string }).error
          : undefined;

  const fill: FillEvent = {
    signalId: command.signalId,
    eventKey: command.eventKey,
    longVenueFill: longOk,
    shortVenueFill: shortOk,
    filledSize: longOk && shortOk ? command.size : 0,
    avgPriceLong: 0.5,
    avgPriceShort: 0.5,
    latencyMs,
    status: longOk && shortOk ? "filled" : longOk || shortOk ? "partial" : "failed",
    timestamp: Date.now(),
    ...(fillError !== undefined ? { error: fillError } : {}),
  };

  fillsBus.publish(fill);
  logger.info(
    { command, longOk, shortOk, latencyMs },
    longOk && shortOk ? "Arb legs executed" : "Arb execution partial/failed"
  );
}

function simulateFill(
  command: ExecutionCommand,
  fillsBus: BroadcastBus<FillEvent>,
  logger: Logger
): void {
  setTimeout(() => {
    const fill: FillEvent = {
      signalId: command.signalId,
      eventKey: command.eventKey,
      longVenueFill: true,
      shortVenueFill: true,
      filledSize: command.size,
      avgPriceLong: 0.5,
      avgPriceShort: 0.5,
      latencyMs: 150,
      status: "filled",
      timestamp: Date.now(),
    };
    fillsBus.publish(fill);
    logger.debug({ command }, "[DRY_RUN] Simulated fill");
  }, 200);
}

function buildKalshiConfig(): Configuration {
  const basePath =
    process.env.KALSHI_BASE_PATH ??
    (process.env.KALSHI_DEMO === "true" ? KALSHI_BASE_PATHS.demo : KALSHI_BASE_PATHS.prod);

  const pem = process.env.KALSHI_PRIVATE_KEY_PEM?.trim();
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH?.trim();

  return new Configuration({
    apiKey: process.env.KALSHI_API_KEY ?? "",
    basePath,
    ...(keyPath ? { privateKeyPath: resolve(process.cwd(), keyPath) } : pem ? { privateKeyPem: pem } : {}),
  });
}

async function placeKalshiOrder(
  ticker: string,
  side: "yes" | "no",
  count: number
): Promise<{ orderId: string } | { error: string }> {
  try {
    const conf = buildKalshiConfig();
    const marketApi = new MarketApi(conf);
    const res = await marketApi.getMarket(ticker);
    const m = res.data.market;
    if (!m) return { error: `No market ${ticker}` };

    const parseCents = (v: string | undefined): number =>
      v != null && v !== "" && Number.isFinite(parseFloat(v))
        ? Math.round(parseFloat(v) * 100)
        : 0;
    const yesAsk = m.yes_ask ?? parseCents(m.yes_ask_dollars);
    const noAsk = m.no_ask ?? parseCents(m.no_ask_dollars);
    const bestAskCents = side === "yes" ? yesAsk : noAsk;
    if (!bestAskCents || bestAskCents < 1) return { error: `No valid ask for ${ticker} ${side}` };

    const price = Math.max(1, Math.min(99, bestAskCents));
    const buyMaxCost = price * count;
    const ordersApi = new OrdersApi(conf);
    const orderRes = await ordersApi.createOrder({
      ticker,
      side,
      action: "buy",
      count,
      buy_max_cost: buyMaxCost,
      ...(side === "yes" ? { yes_price: price } : { no_price: price }),
    });
    const orderId = orderRes.data.order?.order_id ?? "unknown";
    return { orderId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

async function ensurePolymarketCredential(): Promise<void> {
  if (existsSync(POLYMARKET_CREDENTIAL_PATH)) return;
  const key = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  if (!key) throw new Error("POLYMARKET_PRIVATE_KEY required for Polymarket orders");
  const wallet = new Wallet(key);
  const client = new ClobClient(POLYMARKET_CLOB_URL, POLYMARKET_CHAIN_ID, wallet);
  const creds = await client.createOrDeriveApiKey();
  const dir = dirname(POLYMARKET_CREDENTIAL_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    POLYMARKET_CREDENTIAL_PATH,
    JSON.stringify(
      { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
      null,
      2
    ),
    "utf8"
  );
}

function loadPolymarketCreds(): ApiKeyCreds {
  if (!existsSync(POLYMARKET_CREDENTIAL_PATH)) {
    throw new Error(
      `Polymarket credential file not found: ${POLYMARKET_CREDENTIAL_PATH}. Set POLYMARKET_PRIVATE_KEY and run again to auto-create.`
    );
  }
  const raw = JSON.parse(readFileSync(POLYMARKET_CREDENTIAL_PATH, "utf8")) as {
    key: string;
    secret: string;
    passphrase: string;
  };
  const secretBase64 = (raw.secret ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return {
    key: raw.key,
    secret: secretBase64,
    passphrase: raw.passphrase,
  };
}

let polyClient: ClobClient | null = null;

async function getPolymarketClient(): Promise<ClobClient> {
  if (polyClient) return polyClient;
  await ensurePolymarketCredential();
  const key = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  const proxy = process.env.POLYMARKET_PROXY?.trim();
  if (!key) throw new Error("POLYMARKET_PRIVATE_KEY required");
  if (!proxy) throw new Error("POLYMARKET_PROXY required");
  const wallet = new Wallet(key);
  const creds = loadPolymarketCreds();
  polyClient = new ClobClient(
    POLYMARKET_CLOB_URL,
    POLYMARKET_CHAIN_ID,
    wallet,
    creds,
    SignatureType.POLY_GNOSIS_SAFE,
    proxy
  );
  return polyClient;
}

async function placePolymarketOrder(
  slug: string,
  token: "up" | "down",
  sizeUsdc: number
): Promise<{ orderID?: string; error?: string }> {
  try {
    const ids = await fetchTokenIdsForSlug(slug);
    const tokenId = token === "up" ? ids.upTokenId : ids.downTokenId;
    const client = await getPolymarketClient();
    const order = await client.createMarketOrder(
      {
        tokenID: tokenId,
        side: Side.BUY,
        amount: sizeUsdc,
        orderType: OrderType.FAK,
        price: 0.99,
      },
      { tickSize: "0.01", negRisk: false }
    );
    const result = await client.postOrder(order, OrderType.FAK, false);
    const orderID =
      (result as { orderID?: string }).orderID ??
      (result as { order_id?: string }).order_id;
    return orderID != null ? { orderID } : {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}
