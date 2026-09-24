// Issuance record: the only module that knows how an Issuance is stored. SQLite has no JSON
// columns, so the market refs and monetization config are JSON strings; launch terms added later
// are nullable with core defaults; supply is stored in whole tokens. Callers get IssuanceRecord.
import type { Issuance } from "@prisma/client";
import {
  AGREEMENT_VERSION,
  DEFAULT_DCF_DEFINITION,
  DEFAULT_RECORD_DATE_RULE,
  DEMO_ISSUER_JURISDICTION,
  DEMO_PROTOCOL_CONFIG,
  validateMonetizationConfig,
  type CashFlowTerms,
  type DistributionFrequency,
  type MonetizationConfig,
} from "@fstack/core";
import { prisma } from "@/lib/db";
import { HttpError } from "./http";

/** On-chain refs of a live issuance (null on the record while it is still PENDING). */
export interface IssuanceMarket {
  baseMint: string;
  quoteMint: string | null;
  dbcPool: string;
  dammPool: string | null;
  /** DBC config account address. */
  dbcConfig: string | null;
  /** Owners of pool-held token accounts (DBC pool authority); their units are unallocated. */
  poolOwners: string[];
  /** Creation transaction signatures. */
  signatures: string[];
  /** Normalized params sent to DBC at creation, for display. */
  dbcParams: unknown;
  chainMode: string | null;
}

export interface IssuanceRecord {
  id: string;
  rightsType: string;
  /** Launch terms, complete (defaults filled in for terms the row predates). */
  terms: CashFlowTerms;
  graduationMultiple: number;
  startingMarketCap: bigint;
  graduationMarketCap: bigint;
  agreement: { version: string; hash: string; text: string };
  monetization: MonetizationConfig;
  nextRecordDate: Date | null;
  /** terms.tokenSupply in base units (× 10^tokenDecimals). */
  supplyBaseUnits: bigint;
  market: IssuanceMarket | null;
  createdAt: Date;
}

// ---------------------------------------------------------------- decoding

function parseJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function frequencyOf(row: Issuance): DistributionFrequency {
  const f = row.distributionFrequency;
  if (f !== "QUARTERLY" && f !== "MONTHLY") throw new Error(`issuance ${row.id} has unknown distributionFrequency ${f}`);
  return f;
}

function monetizationOf(row: Issuance): MonetizationConfig {
  const cfg = parseJson<MonetizationConfig>(row.monetization);
  return cfg && validateMonetizationConfig(cfg).length === 0 ? cfg : DEMO_PROTOCOL_CONFIG;
}

type StoredDbcConfig = {
  address?: string;
  poolOwners?: string[];
  dbcParams?: unknown;
  signatures?: string[];
  chainMode?: string;
};

function marketOf(row: Issuance): IssuanceMarket | null {
  if (!row.baseMint || !row.dbcPool) return null;
  const cfg = parseJson<StoredDbcConfig>(row.dbcConfig) ?? {};
  return {
    baseMint: row.baseMint,
    quoteMint: row.quoteMint,
    dbcPool: row.dbcPool,
    dammPool: row.dammPool,
    dbcConfig: cfg.address ?? null,
    poolOwners: cfg.poolOwners ?? [],
    signatures: cfg.signatures ?? [],
    dbcParams: cfg.dbcParams ?? null,
    chainMode: cfg.chainMode ?? null,
  };
}

export function toIssuanceRecord(row: Issuance): IssuanceRecord {
  const terms: CashFlowTerms = {
    issuerName: row.issuerName,
    issuerJurisdiction: row.issuerJurisdiction ?? DEMO_ISSUER_JURISDICTION,
    symbol: row.symbol,
    tokenName: row.name,
    tokenSupply: row.tokenSupply,
    tokenDecimals: row.tokenDecimals,
    poolPercentageBps: row.poolPercentageBps,
    distributionFrequency: frequencyOf(row),
    distributableCashFlowDefinition: row.dcfDefinition ?? DEFAULT_DCF_DEFINITION,
    recordDateRule: row.recordDateRule ?? DEFAULT_RECORD_DATE_RULE,
    agreementVersion: row.agreementVersion as typeof AGREEMENT_VERSION,
    expectedAnnualDcf: row.expectedAnnualDcf,
    targetInitialYieldBps: row.targetInitialYieldBps,
  };
  return {
    id: row.id,
    rightsType: row.rightsType,
    terms,
    graduationMultiple: row.graduationMultiple,
    startingMarketCap: row.startingMarketCap,
    graduationMarketCap: row.graduationMarketCap,
    agreement: { version: row.agreementVersion, hash: row.agreementHash, text: row.agreementText },
    monetization: monetizationOf(row),
    nextRecordDate: row.nextRecordDate,
    supplyBaseUnits: row.tokenSupply * 10n ** BigInt(row.tokenDecimals),
    market: marketOf(row),
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------- reads

export async function loadIssuance(id: string): Promise<IssuanceRecord> {
  const row = await prisma.issuance.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, "issuance_not_found", `No issuance ${id}`);
  return toIssuanceRecord(row);
}

/** All issuances, newest first, with participant and distribution counts. */
export async function listIssuances() {
  const rows = await prisma.issuance.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { participants: true, distributions: true } } },
  });
  return rows.map((row) => ({
    record: toIssuanceRecord(row),
    participantCount: row._count.participants,
    distributionCount: row._count.distributions,
  }));
}

/** The market refs, or 409 while the issuance is still being created. */
export function requireMarket(rec: IssuanceRecord): IssuanceMarket {
  if (!rec.market) throw new HttpError(409, "issuance_pending", `Issuance ${rec.id} has no market yet`);
  return rec.market;
}

// ---------------------------------------------------------------- writes

export interface PendingIssuance {
  terms: CashFlowTerms;
  graduationMultiple: number;
  startingMarketCap: bigint;
  graduationMarketCap: bigint;
  agreement: { hash: string; text: string };
  monetization: MonetizationConfig;
  nextRecordDate: Date;
}

/** Inserts an issuance without a market (status PENDING). */
export async function insertPendingIssuance(p: PendingIssuance): Promise<IssuanceRecord> {
  const { terms } = p;
  const row = await prisma.issuance.create({
    data: {
      issuerName: terms.issuerName,
      issuerJurisdiction: terms.issuerJurisdiction,
      poolPercentageBps: terms.poolPercentageBps,
      tokenSupply: terms.tokenSupply,
      tokenDecimals: terms.tokenDecimals,
      symbol: terms.symbol,
      name: terms.tokenName,
      distributionFrequency: terms.distributionFrequency,
      dcfDefinition: terms.distributableCashFlowDefinition,
      recordDateRule: terms.recordDateRule,
      nextRecordDate: p.nextRecordDate,
      expectedAnnualDcf: terms.expectedAnnualDcf,
      targetInitialYieldBps: terms.targetInitialYieldBps,
      graduationMultiple: p.graduationMultiple,
      agreementVersion: terms.agreementVersion,
      agreementHash: p.agreement.hash,
      agreementText: p.agreement.text,
      startingMarketCap: p.startingMarketCap,
      graduationMarketCap: p.graduationMarketCap,
      monetization: JSON.stringify(p.monetization),
    },
  });
  return toIssuanceRecord(row);
}

/** Records the created market on a PENDING issuance (it becomes LIVE). */
export async function attachMarket(id: string, market: Omit<IssuanceMarket, "dammPool">): Promise<IssuanceRecord> {
  const stored: StoredDbcConfig = {
    address: market.dbcConfig ?? undefined,
    poolOwners: market.poolOwners,
    dbcParams: market.dbcParams,
    signatures: market.signatures,
    chainMode: market.chainMode ?? undefined,
  };
  const row = await prisma.issuance.update({
    where: { id },
    data: {
      baseMint: market.baseMint,
      quoteMint: market.quoteMint,
      dbcPool: market.dbcPool,
      dbcConfig: JSON.stringify(stored, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    },
  });
  return toIssuanceRecord(row);
}

export async function deleteIssuance(id: string): Promise<void> {
  await prisma.issuance.delete({ where: { id } }).catch(() => {});
}
