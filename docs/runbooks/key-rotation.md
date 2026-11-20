# Runbook: key rotation

**Alert:** suspected compromise of deployer, treasury, or JWT signing material.

## Steps

1. Revoke exposed secrets in vault; issue new deployer/treasury/JWT keys.
2. Rotate `JWT_SECRET` and `STELLAR_SERVER_SECRET` on dashboard; invalidate all sessions.
3. If contract admin key rotated, invoke contract admin transfer functions per deployment script docs.
4. Redeploy agents with updated env; verify registry heartbeats.
5. Post-mortem within 48h; update this runbook if gaps found.

**Dry-run:** rotate JWT in staging only; confirm all users must re-authenticate via SEP-0010.