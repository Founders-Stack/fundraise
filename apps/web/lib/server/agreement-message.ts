// Pure (no server imports) so the /onboard page can import the exact same string.
/** The exact message an investor's wallet signs (signMessage, ed25519) to accept the agreement. */
export function agreementAcceptanceMessage(agreementHash: string, issuanceId: string): string {
  return `Founder Stack: I accept the Cash Flow Participation Agreement ${agreementHash} for issuance ${issuanceId}`;
}
