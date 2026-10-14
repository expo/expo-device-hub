// @ref LLP 0001#recording-stall-recovery — ambiguous stops must outwait the lease and finalization allowance.
export const RECORDING_LEASE_MS = 180_000;
export const RECORDING_FINALIZATION_WAIT_MS = 120_000;
export const RECORDING_RECONCILIATION_WAIT_MS = RECORDING_LEASE_MS + RECORDING_FINALIZATION_WAIT_MS;
