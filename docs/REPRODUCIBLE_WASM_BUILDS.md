# Reproducible WASM builds

Build Soroban contracts in a pinned Docker image so two runs yield identical WASM SHA-256 hashes.

```bash
docker build -f contracts/Dockerfile.reproducible -t marc-wasm-repro .
```

Record the printed hashes in release notes and in `deployments/<network>.json` under `wasm_hashes`.

Verify a local build against the recorded hashes:

```bash
stellar contract build --optimize
./scripts/verify-wasm-hash.sh deployments/testnet.json
```