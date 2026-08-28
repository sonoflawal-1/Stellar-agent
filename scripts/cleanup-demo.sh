#!/usr/bin/env bash
# cleanup-demo.sh — return leftover demo tokens after each lifecycle run.
#
# After a lifecycle run the seller holds ~9.91M USDC (99% payout + x402
# micropayment) and the buyer holds ~0.99M USDC (1% treasury fee portion).
# This script returns those balances so repeated runs start clean.
#
# Usage:
#   ./scripts/cleanup-demo.sh
#
# Environment (sourced from demo/.env if present):
#   SELLER_SECRET       — seller keypair secret
#   BUYER_SECRET        — buyer keypair secret
#   TREASURY_SECRET     — (optional) treasury/deployer keypair to receive
#                         returned funds. Defaults to deployer from
#                         ~/.config/stellar/identity/deployer.toml.
#   USDC_TOKEN_CONTRACT — USDC SAC contract address
#   STELLAR_NETWORK     — "testnet" (default) or "mainnet"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../demo/.env"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

: "${SELLER_SECRET:?SELLER_SECRET must be set}"
: "${BUYER_SECRET:?BUYER_SECRET must be set}"
: "${USDC_TOKEN_CONTRACT:?USDC_TOKEN_CONTRACT must be set}"
: "${STELLAR_NETWORK:=testnet}"

# Resolve public keys from secrets
SELLER_PUBKEY=$(node -e "const {Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromSecret('$SELLER_SECRET').publicKey())")
BUYER_PUBKEY=$(node -e "const {Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromSecret('$BUYER_SECRET').publicKey())")

# Resolve treasury — prefer TREASURY_SECRET, fall back to deployer
if [[ -n "${TREASURY_SECRET:-}" ]]; then
  TREASURY_PUBKEY=$(node -e "const {Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromSecret('$TREASURY_SECRET').publicKey())")
else
  DEPLOYER_TOML="$HOME/.config/stellar/identity/deployer.toml"
  if [[ -f "$DEPLOYER_TOML" ]]; then
    TREASURY_PUBKEY=$(grep '^public_key' "$DEPLOYER_TOML" | sed 's/.*= *"\(.*\)"/\1/')
  else
    echo "[cleanup] ERROR: No TREASURY_SECRET and no deployer.toml found."
    echo "         Set TREASURY_SECRET in demo/.env or generate a deployer key."
    exit 1
  fi
fi

echo "[cleanup] Seller  : $SELLER_PUBKEY"
echo "[cleanup] Buyer   : $BUYER_PUBKEY"
echo "[cleanup] Treasury: $TREASURY_PUBKEY"
echo "[cleanup] Token   : $USDC_TOKEN_CONTRACT"
echo ""

CLEANED=0

# Helper: query USDC balance for an address via Horizon
get_balance() {
  local addr="$1"
  curl -sf "https://horizon-testnet.stellar.org/accounts/$addr" 2>/dev/null \
    | node -e "
        let d=''; process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
          try {
            const b = JSON.parse(d).balances?.find(b => b.asset_type !== 'native');
            console.log(b ? b.balance : '0');
          } catch { console.log('0'); }
        });
      " 2>/dev/null || echo "0"
}

# Helper: send USDC via Soroban token contract invoke
send_usdc() {
  local from_secret="$1"
  local from_pubkey="$2"
  local to_pubkey="$3"
  local amount_stroops="$4"

  if [[ "$amount_stroops" == "0" ]]; then return 0; fi

  echo "[cleanup] Sending $amount_stroops stroops from ${from_pubkey:0:8}... to ${to_pubkey:0:8}..."
  stellar contract invoke \
    --source-account "$from_secret" \
    --network "$STELLAR_NETWORK" \
    --id "$USDC_TOKEN_CONTRACT" \
    -- transfer \
    --from "$from_pubkey" \
    --to "$to_pubkey" \
    --amount "$amount_stroops"
}

# --- Clean up seller ---
SELLER_BALANCE=$(get_balance "$SELLER_PUBKEY")
echo "[cleanup] Seller USDC balance: $SELLER_BALANCE"

if [[ "$SELLER_BALANCE" != "0" && "$SELLER_BALANCE" != "0.0000000" ]]; then
  SELLER_STROOPS=$(node -e "console.log(BigInt(Math.floor(parseFloat('$SELLER_BALANCE') * 1e7)).toString())")
  send_usdc "$SELLER_SECRET" "$SELLER_PUBKEY" "$TREASURY_PUBKEY" "$SELLER_STROOPS"
  CLEANED=1
else
  echo "[cleanup] Seller balance is zero — nothing to return."
fi

echo ""

# --- Clean up buyer ---
BUYER_BALANCE=$(get_balance "$BUYER_PUBKEY")
echo "[cleanup] Buyer USDC balance: $BUYER_BALANCE"

if [[ "$BUYER_BALANCE" != "0" && "$BUYER_BALANCE" != "0.0000000" ]]; then
  BUYER_STROOPS=$(node -e "console.log(BigInt(Math.floor(parseFloat('$BUYER_BALANCE') * 1e7)).toString())")
  send_usdc "$BUYER_SECRET" "$BUYER_PUBKEY" "$TREASURY_PUBKEY" "$BUYER_STROOPS"
  CLEANED=1
else
  echo "[cleanup] Buyer balance is zero — nothing to return."
fi

echo ""

# --- Deregister agent identities (allows re-registration on next run) ---
AGENT_IDENTITY_CONTRACT="${AGENT_IDENTITY_CONTRACT:-CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5}"

cleanup_identity() {
  local label="$1"
  local secret="$2"
  local pubkey="$3"

  # Look up agent ID via agent_of
  local agent_id
  agent_id=$(stellar contract invoke \
    --source-account "$secret" \
    --network "$STELLAR_NETWORK" \
    --id "$AGENT_IDENTITY_CONTRACT" \
    -- agent_of \
    --owner "$pubkey" 2>/dev/null || echo "")

  if [[ -n "$agent_id" && "$agent_id" != "" && "$agent_id" != "()" ]]; then
    echo "[cleanup] Deregistering $label agent (id=$agent_id)..."
    stellar contract invoke \
      --source-account "$secret" \
      --network "$STELLAR_NETWORK" \
      --id "$AGENT_IDENTITY_CONTRACT" \
      -- deregister \
      --owner "$pubkey" \
      --id "$agent_id" || echo "[cleanup] WARN: deregister failed for $label (may already be deregistered)"
  else
    echo "[cleanup] $label has no registered agent — skipping deregister."
  fi
}

cleanup_identity "seller" "$SELLER_SECRET" "$SELLER_PUBKEY"
cleanup_identity "buyer"  "$BUYER_SECRET"  "$BUYER_PUBKEY"

echo ""

if [[ $CLEANED -eq 1 ]]; then
  echo "[cleanup] Done — funds returned to treasury, agents deregistered."
else
  echo "[cleanup] Done — balances already clean."
fi
