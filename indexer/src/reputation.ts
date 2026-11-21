/**
 * Reputation scoring engine for on-chain agents (issue #729).
 *
 * Computes a dynamic trustworthiness rating (0-100) for provider agents based on
 * historical job completions, disputes, cancellations and response times.
 *
 * The core score uses a Bayesian average so that agents with very few jobs are
 * pulled toward a neutral prior and cannot outrank established agents with a
 * strong track record. Deterministic penalties are then applied for disputes
 * and cancellations.
 */

/** A single persisted event row relevant to reputation. */
export interface ReputationEvent {
  /** Agent the event belongs to. */
  agentId: string;
  /** Event type, e.g. "JobCompleted", "JobDisputed", "JobCancelled". */
  type: string;
  /** Optional completion time in seconds (for completed jobs). */
  completionTimeSecs?: number | null;
  /** Optional timestamp (ms since epoch) of the event. */
  timestamp?: number | null;
}

/** Aggregated historical metrics for a single agent. */
export interface AgentMetrics {
  agentId: string;
  totalJobs: number;
  completedJobs: number;
  cancelledJobs: number;
  disputedJobs: number;
  /** Average completion time in seconds across completed jobs (0 if none). */
  avgCompletionTimeSecs: number;
}

/** Full reputation result with breakdown. */
export interface ReputationResult {
  agentId: string;
  /** Version of the scoring algorithm that produced this result. */
  scoringVersion: number;
  /** Final normalized score in [0, 100]. */
  score: number;
  /** Percentile rank in [0, 100] relative to all known agents. */
  percentileRank: number;
  breakdown: {
    /** Raw Bayesian average before penalties, in [0, 100]. */
    bayesianScore: number;
    /** Deterministic penalty points subtracted for disputes/cancellations. */
    penalty: number;
    /** Completion rate in [0, 1]. */
    completionRate: number;
    /** Dispute rate in [0, 1]. */
    disputeRate: number;
    /** Cancellation rate in [0, 1]. */
    cancellationRate: number;
    /** Average completion time in seconds. */
    avgCompletionTimeSecs: number;
    /** Number of ratings (completed jobs) feeding the Bayesian average. */
    sampleSize: number;
  };
  metrics: AgentMetrics;
  /** Timestamp (ms) when this score was computed. */
  updatedAt: number;
}

/**
 * Minimal storage abstraction the engine depends on. Implementations may be
 * backed by SQLite, Postgres, an in-memory map, etc.
 */
export interface ReputationStore {
  /** Return all events for a single agent. */
  getEventsForAgent(agentId: string): Promise<ReputationEvent[]> | ReputationEvent[];
  /** Return all events for every agent (used for percentile ranking). */
  getAllEvents(): Promise<ReputationEvent[]> | ReputationEvent[];
  /** Persist a computed reputation result. */
  saveReputation?(result: ReputationResult): Promise<void> | void;
}

/**
 * Version stamp for the scoring algorithm. Bump this whenever the scoring
 * rules change so persisted reputations can be identified and recomputed.
 */
export const SCORING_VERSION = 1;

/** Bayesian prior strength (C): number of pseudo-observations. */
export const PRIOR_WEIGHT = 10;
/** Bayesian prior mean (m): neutral rating on the 0-100 scale. */
export const PRIOR_MEAN = 70;

/** Points subtracted per dispute (deterministic). */
export const DISPUTE_PENALTY = 15;
/** Points subtracted per cancellation (deterministic). */
export const CANCELLATION_PENALTY = 5;
/** Maximum total penalty that can be applied. */
export const MAX_PENALTY = 100;

/** Reference completion time (seconds) used to derive a per-job rating. */
export const REFERENCE_COMPLETION_SECS = 3600;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Convert a single completed job into a rating on the 0-100 scale.
 * Faster completions yield higher ratings; missing/zero times get the prior mean.
 */
export function ratingForCompletion(completionTimeSecs?: number | null): number {
  if (
    completionTimeSecs === undefined ||
    completionTimeSecs === null ||
    !Number.isFinite(completionTimeSecs) ||
    completionTimeSecs <= 0
  ) {
    return PRIOR_MEAN;
  }
  // Ratio of reference time to actual time, capped so very fast jobs don't
  // dominate. At the reference time the rating equals the prior mean.
  const ratio = REFERENCE_COMPLETION_SECS / completionTimeSecs;
  const rating = PRIOR_MEAN * clamp(ratio, 0.5, 1.5);
  return clamp(rating, 0, 100);
}

/**
 * Aggregate raw events into per-agent metrics.
 */
export function aggregateMetrics(
  agentId: string,
  events: ReputationEvent[],
): AgentMetrics {
  let completedJobs = 0;
  let cancelledJobs = 0;
  let disputedJobs = 0;
  let totalCompletionSecs = 0;
  let completionSamples = 0;

  for (const event of events) {
    if (event.agentId !== agentId) continue;
    switch (event.type) {
      case 'JobCompleted':
        completedJobs += 1;
        if (
          event.completionTimeSecs !== undefined &&
          event.completionTimeSecs !== null &&
          Number.isFinite(event.completionTimeSecs) &&
          event.completionTimeSecs > 0
        ) {
          totalCompletionSecs += event.completionTimeSecs;
          completionSamples += 1;
        }
        break;
      case 'JobDisputed':
        disputedJobs += 1;
        break;
      case 'JobCancelled':
        cancelledJobs += 1;
        break;
      default:
        break;
    }
  }

  const totalJobs = completedJobs + cancelledJobs + disputedJobs;
  const avgCompletionTimeSecs =
    completionSamples > 0 ? totalCompletionSecs / completionSamples : 0;

  return {
    agentId,
    totalJobs,
    completedJobs,
    cancelledJobs,
    disputedJobs,
    avgCompletionTimeSecs,
  };
}

/**
 * Compute the raw Bayesian average for a set of per-job ratings.
 * Score = (C * m + sum(ratings)) / (C + n)
 */
export function bayesianAverage(ratings: number[]): number {
  const n = ratings.length;
  const sum = ratings.reduce((acc, r) => acc + r, 0);
  const score = (PRIOR_WEIGHT * PRIOR_MEAN + sum) / (PRIOR_WEIGHT + n);
  return clamp(score, 0, 100);
}

/**
 * Compute the deterministic penalty for disputes and cancellations.
 */
export function computePenalty(metrics: AgentMetrics): number {
  const penalty =
    metrics.disputedJobs * DISPUTE_PENALTY +
    metrics.cancelledJobs * CANCELLATION_PENALTY;
  return clamp(penalty, 0, MAX_PENALTY);
}

/**
 * Compute a reputation result from already-aggregated metrics and the ratings
 * that feed the Bayesian average. Exposed for testing and reuse.
 */
export function scoreFromMetrics(
  metrics: AgentMetrics,
  ratings: number[],
): ReputationResult {
  const bayesianScore = bayesianAverage(ratings);
  const penalty = computePenalty(metrics);
  const score = clamp(bayesianScore - penalty, 0, 100);

  const total = metrics.totalJobs;
  const completionRate = total > 0 ? metrics.completedJobs / total : 0;
  const disputeRate = total > 0 ? metrics.disputedJobs / total : 0;
  const cancellationRate = total > 0 ? metrics.cancelledJobs / total : 0;

  return {
    agentId: metrics.agentId,
    scoringVersion: SCORING_VERSION,
    score,
    percentileRank: 0,
    breakdown: {
      bayesianScore,
      penalty,
      completionRate,
      disputeRate,
      cancellationRate,
      avgCompletionTimeSecs: metrics.avgCompletionTimeSecs,
      sampleSize: ratings.length,
    },
    metrics,
    updatedAt: Date.now(),
  };
}

/** Build per-job ratings for an agent from its events. */
function ratingsForAgent(agentId: string, events: ReputationEvent[]): number[] {
  const ratings: number[] = [];
  for (const event of events) {
    if (event.agentId !== agentId) continue;
    if (event.type === 'JobCompleted') {
      ratings.push(ratingForCompletion(event.completionTimeSecs));
    }
  }
  return ratings;
}

/**
 * Compute the percentile rank of a score within a sorted ascending list of
 * scores. Returns a value in [0, 100].
 */
export function percentileRank(score: number, allScores: number[]): number {
  if (allScores.length === 0) return 0;
  let below = 0;
  for (const s of allScores) {
    if (s < score) below += 1;
  }
  return clamp((below / allScores.length) * 100, 0, 100);
}

/**
 * Compute the reputation for a single agent.
 */
export async function computeReputation(
  store: ReputationStore,
  agentId: string,
): Promise<ReputationResult> {
  const agentEvents = await store.getEventsForAgent(agentId);
  const metrics = aggregateMetrics(agentId, agentEvents);
  const ratings = ratingsForAgent(agentId, agentEvents);
  const result = scoreFromMetrics(metrics, ratings);

  // Percentile rank requires the full population.
  const allEvents = await store.getAllEvents();
  const agentIds = new Set<string>();
  for (const event of allEvents) {
    agentIds.add(event.agentId);
  }
  agentIds.add(agentId);

  const allScores: number[] = [];
  for (const id of [...agentIds].sort()) {
    if (id === agentId) {
      allScores.push(result.score);
      continue;
    }
    const events = allEvents.filter((e) => e.agentId === id);
    const m = aggregateMetrics(id, events);
    const r = ratingsForAgent(id, events);
    allScores.push(scoreFromMetrics(m, r).score);
  }

  result.percentileRank = percentileRank(result.score, allScores);

  if (store.saveReputation) {
    await store.saveReputation(result);
  }

  return result;
}

/**
 * Recalculate reputations for every known agent. Returns a map of agentId to
 * result. Used when a JobCompleted / JobDisputed event arrives.
 */
export async function recalculateAllReputations(
  store: ReputationStore,
): Promise<Map<string, ReputationResult>> {
  const allEvents = await store.getAllEvents();
  const agentIds = new Set<string>();
  for (const event of allEvents) {
    agentIds.add(event.agentId);
  }

  const results = new Map<string, ReputationResult>();
  const scores: number[] = [];

  // Sort agent ids so recomputation is deterministic across runs.
  for (const id of [...agentIds].sort()) {
    const events = allEvents.filter((e) => e.agentId === id);
    const metrics = aggregateMetrics(id, events);
    const ratings = ratingsForAgent(id, events);
    const result = scoreFromMetrics(metrics, ratings);
    results.set(id, result);
    scores.push(result.score);
  }

  for (const id of [...results.keys()].sort()) {
    const result = results.get(id)!;
    result.percentileRank = percentileRank(result.score, scores);
    if (store.saveReputation) {
      await store.saveReputation(result);
    }
  }

  return results;
}

/**
 * In-memory store implementation, useful for tests and lightweight setups.
 */
export class InMemoryReputationStore implements ReputationStore {
  private events: ReputationEvent[] = [];
  private saved = new Map<string, ReputationResult>();

  constructor(events: ReputationEvent[] = []) {
    this.events = [...events];
  }

  addEvent(event: ReputationEvent): void {
    this.events.push(event);
  }

  getEventsForAgent(agentId: string): ReputationEvent[] {
    return this.events.filter((e) => e.agentId === agentId);
  }

  getAllEvents(): ReputationEvent[] {
    return [...this.events];
  }

  saveReputation(result: ReputationResult): void {
    this.saved.set(result.agentId, result);
  }

  getSaved(agentId: string): ReputationResult | undefined {
    return this.saved.get(agentId);
  }
}