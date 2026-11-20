import { describe, it, expect } from 'vitest';

/**
 * Stub scenario map for milestone / dispute / refund flows (#1028).
 * Full on-chain runs require E2E_* env from deployments/testnet.json.
 */
describe('dispute and refund flows (stub)', () => {
  it('documents expected balance assertions', () => {
    const scenarios = ['milestone_approval', 'dispute', 'claim_refund', 'claim_expired'];
    expect(scenarios.length).toBe(4);
  });
});