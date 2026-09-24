// Pure (no server imports) so the onboarding gate can import the exact same strings.

/** The one onboarding checkbox, and the statement the investor's signature covers (SPEC section 6). */
export const ELIGIBILITY_STATEMENT = "I confirm I'm eligible and accept the agreement";

/**
 * The exact message an investor's wallet signs (signMessage, ed25519) to accept the agreement:
 * { issuanceId, wallet, agreementHash, eligibilityStatement }, one per line so the wallet shows it readably.
 */
export function agreementAcceptanceMessage(p: { issuanceId: string; wallet: string; agreementHash: string }): string {
  return [
    "Founder Stack: Cash Flow Participation Agreement",
    `Issuance: ${p.issuanceId}`,
    `Wallet: ${p.wallet}`,
    `Agreement sha256: ${p.agreementHash}`,
    ELIGIBILITY_STATEMENT,
  ].join("\n");
}
