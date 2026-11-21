/** Pure helpers shared by maintainer scripts (unit-tested). */

export function exceedsGasRegressionThreshold(
  current: number,
  baseline: number,
  thresholdPercent: number,
): boolean {
  if (baseline <= 0) return false;
  const delta = ((current - baseline) / baseline) * 100;
  return delta > thresholdPercent;
}

export function formatVerificationCheck(
  name: string,
  passed: boolean,
  detail: string,
): string {
  const mark = passed ? "PASS" : "FAIL";
  return `- [${mark}] **${name}** — ${detail}`;
}

export function extractReadmeContractAddresses(readme: string): Record<string, string> {
  const out: Record<string, string> = {};
  const row = /^\|\s*([^|]+?)\s*\|\s*`(C[A-Z0-9]{55})`\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = row.exec(readme)) !== null) {
    const label = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    out[label] = m[2];
  }
  return out;
}

export function diffDeploymentManifests(
  readmeAddrs: Record<string, string>,
  json: Record<string, string>,
): string[] {
  const mismatches: string[] = [];
  for (const [readmeKey, jsonKey] of Object.entries({
    agent_identity: "agent_identity",
    agentic_commerce: "agentic_commerce",
  })) {
    const fromReadme = readmeAddrs[readmeKey];
    const fromJson = json[jsonKey];
    if (fromReadme && fromJson && fromReadme !== fromJson) {
      mismatches.push(`${jsonKey}: README=${fromReadme} json=${fromJson}`);
    }
  }
  return mismatches;
}