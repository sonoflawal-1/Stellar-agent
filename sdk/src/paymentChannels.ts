import { Keypair } from "@stellar/stellar-sdk";

export interface ChannelVoucher {
  channelId: bigint;
  amount: bigint;
  nonce: bigint;
  signature: Uint8Array;
}

export function channelVoucherPayload(channelId: bigint, amount: bigint, nonce: bigint): Uint8Array {
  const maxU64 = (1n << 64n) - 1n;
  if (
    channelId < 0n || channelId > maxU64 ||
    amount < 0n || amount > (1n << 127n) - 1n ||
    nonce < 0n || nonce > maxU64
  ) {
    throw new Error("channel voucher fields are out of range");
  }
  const domain = new TextEncoder().encode("BEAR_CHANNEL_V1");
  const payload = new Uint8Array(domain.length + 8 + 16 + 8);
  payload.set(domain);
  const view = new DataView(payload.buffer);
  let offset = domain.length;
  view.setBigUint64(offset, channelId, false);
  offset += 8;
  let remainingAmount = amount;
  for (let index = 15; index >= 0; index -= 1) {
    view.setUint8(offset + index, Number(remainingAmount & 0xffn));
    remainingAmount >>= 8n;
  }
  offset += 16;
  view.setBigUint64(offset, nonce, false);
  return payload;
}

export function createChannelVoucher(
  channelId: bigint,
  amount: bigint,
  nonce: bigint,
  voucherKeypair: Keypair,
): ChannelVoucher {
  const payload = channelVoucherPayload(channelId, amount, nonce);
  return {
    channelId,
    amount,
    nonce,
    signature: new Uint8Array(voucherKeypair.sign(payload as Buffer)),
  };
}

export function verifyChannelVoucher(voucher: ChannelVoucher, voucherPublicKey: string): boolean {
  try {
    return Keypair.fromPublicKey(voucherPublicKey).verify(
      channelVoucherPayload(voucher.channelId, voucher.amount, voucher.nonce) as Buffer,
      voucher.signature as Buffer,
    );
  } catch {
    return false;
  }
}