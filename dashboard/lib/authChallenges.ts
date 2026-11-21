export class IssuedChallengeStore {
  private readonly challenges = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly pruneTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? 5 * 60_000);
    this.now = options.now ?? Date.now;
    this.pruneTimer = setInterval(() => this.prune(), this.ttlMs);
    this.pruneTimer.unref?.();
  }

  issue(hash: string): void {
    this.challenges.set(hash, this.now() + this.ttlMs);
  }

  has(hash: string): boolean {
    const expiresAt = this.challenges.get(hash);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.challenges.delete(hash);
      return false;
    }
    return true;
  }

  consume(hash: string): boolean {
    if (!this.has(hash)) return false;
    this.challenges.delete(hash);
    return true;
  }

  prune(): void {
    const now = this.now();
    for (const [hash, expiresAt] of this.challenges) {
      if (expiresAt <= now) this.challenges.delete(hash);
    }
  }

  stop(): void {
    clearInterval(this.pruneTimer);
  }
}
