import { Keypair, TransactionBuilder, Networks, Operation, Asset, Horizon } from '@stellar/stellar-sdk';
import * as dotenv from 'dotenv';

dotenv.config();

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

/**
 * Resolve the transaction timeout (in seconds) from the CLI or environment.
 * Precedence: --timeout-sec <N> argument, then TX_TIMEOUT_SECS env var, then 60s default.
 */
function resolveTimeoutSecs(): number {
  const argIndex = process.argv.indexOf('--timeout-sec');
  if (argIndex !== -1 && process.argv[argIndex + 1]) {
    const parsed = Number(process.argv[argIndex + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const envValue = Number(process.env.TX_TIMEOUT_SECS);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }

  return 60;
}

const TX_TIMEOUT_SECS = resolveTimeoutSecs();

async function simulate() {
  const server = new Horizon.Server(HORIZON_URL);
  const sourceKeypair = Keypair.random();

  console.log(`Simulating transaction with a ${TX_TIMEOUT_SECS}s timeout...`);

  const account = await server.loadAccount(sourceKeypair.publicKey());

  const transaction = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: sourceKeypair.publicKey(),
        asset: Asset.native(),
        amount: '1',
      })
    )
    .setTimeout(TX_TIMEOUT_SECS)
    .build();

  transaction.sign(sourceKeypair);

  console.log('Transaction built successfully:');
  console.log(transaction.toXDR());
}

simulate().catch((error) => {
  console.error('Simulation failed:', error);
  process.exit(1);
});
