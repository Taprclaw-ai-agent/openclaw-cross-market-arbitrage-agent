import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import '@vihat/bignum';
import { parse } from "yaml";
import { z } from "zod";

dotenv.config();

const ExchangeSchema = z.object({
  wsUrl: z.string().trim().optional(),
  reconnectDelayMs: z.number().int().positive().default(3000),
  /** Kalshi: market ticker to subscribe (e.g. KXBTC15M). Omit for all. */
  marketTicker: z.string().trim().optional(),
  /** Polymarket: market slug (e.g. btc-updown-15m-{ts}). Omit for auto current-15m. */
  marketSlug: z.string().trim().optional(),
});

const RiskSchema = z.object({
  maxCapitalPerTrade: z.number().positive(),
  maxDailyLoss: z.number().positive(),
  staleQuoteMs: z.number().positive(),
  liquidityThreshold: z.number().nonnegative(),
  /** Minimum ms between approved trades (cooldown). */
  cooldownMs: z.number().int().nonnegative().default(10_000),
});

const StrategySchema = z.object({
  edgeThreshold: z.number().nonnegative(),
  maxSlippageBps: z.number().nonnegative(),
  feeBps: z.number().nonnegative(),
});

const ConfigSchema = z.object({
  environment: z.string().default("demo"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  postgres: z.object({
    host: z.string(),
    port: z.number().int().positive().default(5432),
    user: z.string(),
    password: z.string(),
    database: z.string(),
  }),
  exchanges: z.object({
    polymarket: ExchangeSchema,
    kalshi: ExchangeSchema,
  }),
  risk: RiskSchema,
  strategy: StrategySchema,
  meta: z
    .object({
      llmAgent: z.string().optional(),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath = process.env.CONFIG_PATH ?? "configs/default.yaml"): AppConfig {
  const absolutePath = resolve(process.cwd(), configPath);
  const fileContents = readFileSync(absolutePath, "utf-8");
  const parsed = parse(fileContents);
  const result = ConfigSchema.safeParse(parsed);

  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${message}`);
  }

  return result.data;
}
