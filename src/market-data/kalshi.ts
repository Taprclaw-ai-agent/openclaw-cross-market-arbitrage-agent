/**
 * Kalshi WebSocket market feed - connects to trade-api WS, subscribes to ticker channel,
 * and maps ticker messages to MarketEvent. Uses kalshi-ts-sdk Configuration + same
 * RSA-PSS auth scheme as kalshi-trading-bot monitor-ws.ts.
 */
import * as crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { Configuration } from "kalshi-ts-sdk";
import type { Logger } from "../logger.js";
import type { BroadcastBus } from "../bus.js";
import type { MarketEvent } from "../types.js";

const WS_PATH = "/trade-api/ws/v2";
const BASE_PATHS = {
  prod: "https://api.elections.kalshi.com/trade-api/v2",
  demo: "https://demo-api.kalshi.co/trade-api/v2",
} as const;

interface MarketFeedOptions {
  url?: string;
  reconnectDelayMs: number;
  bus: BroadcastBus<MarketEvent>;
  logger: Logger;
  signal: AbortSignal;
  /** Optional: subscribe to specific market ticker (e.g. KXBTC15M). Omit for all markets. */
  marketTicker?: string;
}

function parsePathOrPem(raw: string | undefined): { path?: string; pem?: string } {
  if (!raw) return {};
  const s = (raw.split("#")[0] ?? raw).trim().replace(/^["']|["']$/g, "").trim();
  if (!s) return {};
  if (s.includes("-----BEGIN")) return { pem: s };
  return { path: s };
}

function buildKalshiConfig(): Configuration {
  const basePath =
    process.env.KALSHI_BASE_PATH ??
    (process.env.KALSHI_DEMO === "true" ? BASE_PATHS.demo : BASE_PATHS.prod);

  const pathFromEnv = parsePathOrPem(process.env.KALSHI_PRIVATE_KEY_PATH);
  const pemFromEnv = parsePathOrPem(process.env.KALSHI_PRIVATE_KEY_PEM);

  let privateKeyPath: string | undefined;
  let privateKeyPem: string | undefined;

  if (pathFromEnv.path && existsSync(pathFromEnv.path)) {
    privateKeyPath = resolve(process.cwd(), pathFromEnv.path);
  } else if (pemFromEnv.path && existsSync(pemFromEnv.path)) {
    privateKeyPath = resolve(process.cwd(), pemFromEnv.path);
  } else if (pemFromEnv.pem) {
    privateKeyPem = pemFromEnv.pem;
  }

  return new Configuration({
    apiKey: (process.env.KALSHI_API_KEY ?? "").trim(),
    basePath,
    ...(privateKeyPath ? { privateKeyPath } : privateKeyPem ? { privateKeyPem } : {}),
  });
}

/** Derive WebSocket URL from REST base path (https.../v2 -> wss.../ws/v2). */
function getWsUrl(config: Configuration): string {
  const base = (config.basePath ?? BASE_PATHS.prod).replace(/^https:\/\//, "wss://");
  return base.replace(/\/v2\/?$/, "/ws/v2");
}

/** Build auth headers (RSA-PSS, same scheme as kalshi-ts-sdk KalshiAuth / trading bot). */
function getWsAuthHeaders(config: Configuration): Record<string, string> {
  const apiKey = config.apiKey;
  const privateKey =
    config.privateKeyPem ??
    (config.privateKeyPath && existsSync(config.privateKeyPath)
      ? readFileSync(config.privateKeyPath, "utf8")
      : "");

  if (!apiKey || !privateKey || !privateKey.includes("-----BEGIN")) {
    return {};
  }
  const timestamp = String(Date.now());
  const msg = timestamp + "GET" + WS_PATH;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(msg);
  sign.end();
  const signature = sign.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    "KALSHI-ACCESS-KEY": apiKey,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

export function startKalshiFeed({
  url,
  reconnectDelayMs,
  bus,
  logger,
  signal,
  marketTicker,
}: MarketFeedOptions): void {
  const config = buildKalshiConfig();
  const wsUrl = url ?? getWsUrl(config);
  const headers = getWsAuthHeaders(config);

  if (Object.keys(headers).length === 0) {
    const pathOpt = parsePathOrPem(process.env.KALSHI_PRIVATE_KEY_PATH).path ?? parsePathOrPem(process.env.KALSHI_PRIVATE_KEY_PEM).path;
    logger.warn(
      pathOpt
        ? `Kalshi auth missing: key file not found at ${pathOpt}. Create the file or fix the path.`
        : "Kalshi auth missing: set KALSHI_API_KEY and KALSHI_PRIVATE_KEY_PATH or KALSHI_PRIVATE_KEY_PEM. Demo API requires auth."
    );
  }

  let ws: WebSocket | null = null;
  let messageId = 1;

  const subscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || signal.aborted) return;
    const id = messageId++;
    const payload = {
      id,
      cmd: "subscribe",
      params: {
        channels: ["ticker"],
        ...(marketTicker ? { market_ticker: marketTicker } : {}),
      },
    };
    ws.send(JSON.stringify(payload));
    logger.info({ marketTicker }, "Kalshi subscribe sent");
  };

  const connect = () => {
    if (signal.aborted) {
      logger.warn("Kalshi feed aborted before connection was established");
      return;
    }

    const wsOptions = Object.keys(headers).length > 0 ? { headers } : {};

    logger.info({ url: wsUrl, useAuth: Object.keys(headers).length > 0 }, "Connecting to Kalshi feed");
    ws = new WebSocket(wsUrl, wsOptions);

    ws.on("open", () => {
      logger.info("Kalshi WebSocket connected");
      subscribe();
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw === "heartbeat" || raw === "") {
        ws?.pong?.();
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        logger.info({ parsed }, "Kalshi WS message received");
        if (parsed.type === "subscribed") return;
        if (parsed.type === "error") {
          logger.warn({ msg: parsed.msg }, "Kalshi WS error");
          return;
        }
        const event = mapToMarketEvent(parsed);
        if (event) {
          bus.publish(event);
          logger.info({ event }, "Kalshi market event published");
        }
      } catch (error) {
        logger.error({ error }, "Failed to parse Kalshi payload");
      }
    });

    ws.on("close", (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, "Kalshi WebSocket closed");
      ws = null;
      if (!signal.aborted) {
        setTimeout(connect, reconnectDelayMs);
      }
    });

    ws.on("error", (error) => {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ error: errMsg }, "Kalshi WebSocket error");
      ws?.close();
    });

    ws.on("ping", () => ws?.pong());
  };

  signal.addEventListener("abort", () => {
    logger.info("Stopping Kalshi market data feed");
    ws?.close();
  });

  connect();
}

/** Kalshi ticker msg: yes_bid, yes_ask in cents; price = last. */
interface TickerMsg {
  market_ticker: string;
  yes_bid?: number;
  yes_ask?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  price?: number;
  price_dollars?: string;
  close_time?: string;
  liquidity?: number;
  volume?: number;
  ts?: number;
}

function mapToMarketEvent(payload: unknown): MarketEvent | null {
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as { type?: string; msg?: TickerMsg };
  if (obj.type !== "ticker" || !obj.msg) return null;

  const msg = obj.msg;
  if (!msg.market_ticker) return null;

  const cents = (v: number | undefined, dollars: string | undefined): number => {
    if (v != null && Number.isFinite(v)) return Math.round(v);
    if (dollars != null) {
      const n = parseFloat(dollars);
      return Number.isFinite(n) ? Math.round(n * 100) : 0;
    }
    return 0;
  };

  const bid = cents(msg.yes_bid, msg.yes_bid_dollars);
  const ask = cents(msg.yes_ask, msg.yes_ask_dollars);
  const lastPrice = cents(msg.price, msg.price_dollars);

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;

  const event: MarketEvent = {
    marketId: String(msg.market_ticker),
    platform: "kalshi",
    bid,
    ask,
    expirationTs: msg.close_time ? Date.parse(msg.close_time) : Date.now(),
    receivedAt: Date.now(),
    raw: payload,
  };

  if (Number.isFinite(lastPrice)) event.lastPrice = lastPrice as number;
  const liq = msg.liquidity;
  if (liq != null && Number.isFinite(liq)) event.liquidity = liq;
  const vol = msg.volume;
  if (vol != null && Number.isFinite(vol)) event.volume24h = vol;

  const impliedProbability = msg.price != null ? msg.price / 100 : undefined;
  if (impliedProbability != null && Number.isFinite(impliedProbability)) event.impliedProbability = impliedProbability;

  return event;
}
