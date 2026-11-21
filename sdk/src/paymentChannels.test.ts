import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { createChannelVoucher, verifyChannelVoucher } from "./paymentChannels.js";

test("100 cumulative micropayment vouchers sign and verify off-chain", () => {
  const payer = Keypair.random();
  let lastVoucher = createChannelVoucher(7n, 0n, 0n, payer);

  for (let payment = 1n; payment <= 100n; payment += 1n) {
    lastVoucher = createChannelVoucher(7n, payment * 1_000n, payment, payer);
    assert.equal(verifyChannelVoucher(lastVoucher, payer.publicKey()), true);
  }

  assert.equal(lastVoucher.amount, 100_000n);
  assert.equal(lastVoucher.nonce, 100n);
  assert.equal(verifyChannelVoucher({ ...lastVoucher, amount: 99_000n }, payer.publicKey()), false);
});