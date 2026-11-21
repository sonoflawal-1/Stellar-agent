import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  AwsKmsSigner,
  VaultSigner,
  createKeypairFromSecret,
  generateRandomKeypair,
  isValidSecretKey,
} from "./signer.js";

/**
 * Builds a mock AWS KMS client that signs payloads with a locally-held Ed25519
 * keypair, emulating the shape of the KMS `Sign` API response.
 */
function createMockKmsClient(signingKeypair: Keypair) {
  const calls: Array<{ KeyId?: string; Message?: Uint8Array; MessageType?: string }> = [];
  return {
    calls,
    async send(command: any) {
      const input = command?.input ?? {};
      calls.push(input);
      const message: Uint8Array = input.Message;
      const signature = signingKeypair.sign(Buffer.from(message));
      return { Signature: signature, SigningAlgorithm: "ED25519_SHA_512" };
    },
  };
}

/**
 * Builds a mock Vault Transit client that signs payloads with a locally-held
 * Ed25519 keypair, emulating the Vault Transit `sign` response.
 */
function createMockVaultClient(signingKeypair: Keypair) {
  const calls: Array<{ path?: string; input?: string }> = [];
  return {
    calls,
    async write(path: string, data: { input: string }) {
      calls.push({ path, input: data.input });
      const signature = signingKeypair.sign(Buffer.from(data.input, "base64"));
      return {
        data: {
          signature: `vault:v1:${signature.toString("base64")}`,
        },
      };
    },
  };
}

test("isValidSecretKey returns true for a valid secret seed", () => {
  const kp = Keypair.random();
  assert.equal(isValidSecretKey(kp.secret()), true);
});

test("isValidSecretKey returns false for a malformed string", () => {
  assert.equal(isValidSecretKey("not-a-secret-key"), false);
});

test("isValidSecretKey returns false for an empty string", () => {
  assert.equal(isValidSecretKey(""), false);
});

test("isValidSecretKey returns false for a public key (wrong prefix)", () => {
  const kp = Keypair.random();
  assert.equal(isValidSecretKey(kp.publicKey()), false);
});

test("createKeypairFromSecret returns a matching Keypair for a valid secret", () => {
  const kp = Keypair.random();
  const rebuilt = createKeypairFromSecret(kp.secret());
  assert.equal(rebuilt.publicKey(), kp.publicKey());
  assert.equal(rebuilt.secret(), kp.secret());
});

test("createKeypairFromSecret throws a descriptive error for invalid input", () => {
  assert.throws(() => createKeypairFromSecret("bogus"), /Invalid Stellar secret key format/);
});

test("createKeypairFromSecret throws for an empty string", () => {
  assert.throws(() => createKeypairFromSecret(""), /Invalid Stellar secret key format/);
});

test("generateRandomKeypair returns a valid, usable Keypair", () => {
  const kp = generateRandomKeypair();
  assert.equal(isValidSecretKey(kp.secret()), true);
  assert.equal(typeof kp.publicKey(), "string");
  assert.equal(kp.publicKey().startsWith("G"), true);
});

test("generateRandomKeypair returns distinct keypairs on each call", () => {
  const a = generateRandomKeypair();
  const b = generateRandomKeypair();
  assert.notEqual(a.publicKey(), b.publicKey());
});

test("AwsKmsSigner produces a valid Stellar signature via mocked KMS", async () => {
  const kp = Keypair.random();
  const client = createMockKmsClient(kp);
  const signer = new AwsKmsSigner({
    keyId: "arn:aws:kms:us-east-1:000000000000:key/mock",
    publicKey: kp.publicKey(),
    client: client as any,
  });

  const payload = Buffer.from("x402 payment header payload");
  const signature = await signer.sign(payload);

  assert.equal(signature.length, 64);
  assert.equal(kp.verify(payload, signature), true);
  assert.equal(signer.publicKey(), kp.publicKey());
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].KeyId, "arn:aws:kms:us-east-1:000000000000:key/mock");
});

test("AwsKmsSigner rejects payloads it did not sign", async () => {
  const kp = Keypair.random();
  const client = createMockKmsClient(kp);
  const signer = new AwsKmsSigner({
    keyId: "mock-key",
    publicKey: kp.publicKey(),
    client: client as any,
  });

  const signature = await signer.sign(Buffer.from("original"));
  assert.equal(kp.verify(Buffer.from("tampered"), signature), false);
});

test("AwsKmsSigner error messages never leak secret material", async () => {
  const secret = Keypair.random().secret();
  const failingClient = {
    async send() {
      throw new Error(`KMS failure for secret ${secret}`);
    },
  };
  const signer = new AwsKmsSigner({
    keyId: "mock-key",
    publicKey: Keypair.random().publicKey(),
    client: failingClient as any,
  });

  await assert.rejects(
    () => signer.sign(Buffer.from("payload")),
    (err: Error) => {
      assert.equal(err.message.includes(secret), false);
      assert.equal(err.message.includes("S"), false || !err.message.includes(secret));
      return true;
    },
  );
});

test("VaultSigner produces a valid Stellar signature via mocked Vault Transit", async () => {
  const kp = Keypair.random();
  const client = createMockVaultClient(kp);
  const signer = new VaultSigner({
    keyName: "agent-key",
    publicKey: kp.publicKey(),
    client: client as any,
  });

  const payload = Buffer.from("vault-signed x402 header");
  const signature = await signer.sign(payload);

  assert.equal(signature.length, 64);
  assert.equal(kp.verify(payload, signature), true);
  assert.equal(signer.publicKey(), kp.publicKey());
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, "transit/sign/agent-key");
});

test("VaultSigner rejects payloads it did not sign", async () => {
  const kp = Keypair.random();
  const client = createMockVaultClient(kp);
  const signer = new VaultSigner({
    keyName: "agent-key",
    publicKey: kp.publicKey(),
    client: client as any,
  });

  const signature = await signer.sign(Buffer.from("original"));
  assert.equal(kp.verify(Buffer.from("tampered"), signature), false);
});

test("VaultSigner error messages never leak secret material", async () => {
  const secret = Keypair.random().secret();
  const failingClient = {
    async write() {
      throw new Error(`Vault failure for secret ${secret}`);
    },
  };
  const signer = new VaultSigner({
    keyName: "agent-key",
    publicKey: Keypair.random().publicKey(),
    client: failingClient as any,
  });

  await assert.rejects(
    () => signer.sign(Buffer.from("payload")),
    (err: Error) => {
      assert.equal(err.message.includes(secret), false);
      return true;
    },
  );
});

test("Remote signers expose a Stellar-compatible publicKey and sign interface", async () => {
  const kp = Keypair.random();
  const kmsSigner = new AwsKmsSigner({
    keyId: "mock-key",
    publicKey: kp.publicKey(),
    client: createMockKmsClient(kp) as any,
  });
  const vaultSigner = new VaultSigner({
    keyName: "agent-key",
    publicKey: kp.publicKey(),
    client: createMockVaultClient(kp) as any,
  });

  for (const signer of [kmsSigner, vaultSigner]) {
    assert.equal(typeof signer.publicKey, "function");
    assert.equal(typeof signer.sign, "function");
    assert.equal(signer.publicKey(), kp.publicKey());
  }
});
