import { EventEmitter } from 'events';

export type AgentStatus = 'Online' | 'Offline';

export interface AgentRecord {
  id: string;
  manifestUrl?: string;
  metadataUri?: string;
  status?: AgentStatus;
  ownerEndpoint?: string;
  ownerWebhookUrl?: string;
  [key: string]: unknown;
}

export interface AgentHealthMonitorOptions {
  /**
   * Returns the current map of registered agents keyed by agent id.
   * Called on every probe cycle so the registry server can supply live data.
   */
  getAgents: () => Map<string, AgentRecord> | Record<string, AgentRecord>;
  /**
   * Sets the status of an agent in the registry cache.
   */
  setStatus: (agentId: string, status: AgentStatus) => void | Promise<void>;
  /**
   * Interval between probe cycles in milliseconds. Defaults to 60_000.
   */
  intervalMs?: number;
  /**
   * Per-probe timeout in milliseconds. Defaults to 5_000.
   */
  timeoutMs?: number;
  /**
   * Number of consecutive failures before an agent is marked Offline. Defaults to 3.
   */
  failureThreshold?: number;
  /**
   * Time-to-live in milliseconds since the last heartbeat. Agents whose last
   * heartbeat is older than this are marked Offline and hidden from discovery.
   * Defaults to 120_000.
   */
  heartbeatTtlMs?: number;
  /**
   * Returns the last heartbeat timestamp (epoch ms) for an agent, if known.
   * Used by the TTL sweep to detect stale agents.
   */
  getLastHeartbeat?: (agentId: string) => number | undefined;
  /**
   * Optional fetch implementation (defaults to global fetch). Useful for tests.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional alert webhook URL. If not provided, the agent's ownerWebhookUrl or
   * ownerEndpoint is used.
   */
  alertWebhookUrl?: string;
  /**
   * Optional logger.
   */
  logger?: Pick<Console, 'warn' | 'error' | 'info' | 'log'>;
}

export interface ProbeResult {
  agentId: string;
  ok: boolean;
  status: AgentStatus;
  consecutiveFailures: number;
  transitionedToOffline: boolean;
  transitionedToOnline: boolean;
  error?: string;
}

interface AgentState {
  consecutiveFailures: number;
  status: AgentStatus;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_HEARTBEAT_TTL_MS = 120_000;

function normalizeAgents(
  agents: Map<string, AgentRecord> | Record<string, AgentRecord>,
): Map<string, AgentRecord> {
  if (agents instanceof Map) {
    return agents;
  }
  return new Map(Object.entries(agents));
}

function resolveManifestUrl(agent: AgentRecord): string | undefined {
  return agent.manifestUrl ?? agent.metadataUri;
}

function buildHealthUrl(manifestUrl: string): string {
  const trimmed = manifestUrl.replace(/\/+$/, '');
  return `${trimmed}/health`;
}

export class AgentHealthMonitor extends EventEmitter {
  private readonly getAgents: AgentHealthMonitorOptions['getAgents'];
  private readonly setStatus: AgentHealthMonitorOptions['setStatus'];
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly heartbeatTtlMs: number;
  private readonly getLastHeartbeat?: AgentHealthMonitorOptions['getLastHeartbeat'];
  private readonly fetchImpl: typeof fetch;
  private readonly alertWebhookUrl?: string;
  private readonly logger: Pick<Console, 'warn' | 'error' | 'info' | 'log'>;

  private readonly states = new Map<string, AgentState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private probing = false;

  constructor(options: AgentHealthMonitorOptions) {
    super();
    if (!options || typeof options.getAgents !== 'function') {
      throw new Error('AgentHealthMonitor requires a getAgents function');
    }
    if (typeof options.setStatus !== 'function') {
      throw new Error('AgentHealthMonitor requires a setStatus function');
    }
    this.getAgents = options.getAgents;
    this.setStatus = options.setStatus;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    this.getLastHeartbeat = options.getLastHeartbeat;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.alertWebhookUrl = options.alertWebhookUrl;
    this.logger = options.logger ?? console;
  }

  /**
   * Starts the background poller. The timer is unref'd so it never keeps the
   * process alive or blocks HTTP request threads.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.probeOnce().catch((err) => {
        this.logger.error('[AgentHealthMonitor] probe cycle failed', err);
      });
      void this.sweepStaleAgents().catch((err) => {
        this.logger.error('[AgentHealthMonitor] TTL sweep failed', err);
      });
    }, this.intervalMs);
    // Do not keep the event loop alive just for the monitor.
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
    this.emit('started');
  }

  /**
   * Stops the background poller.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Runs a single probe cycle across all registered agents. Safe to call
   * concurrently; overlapping cycles are skipped.
   */
  async probeOnce(): Promise<ProbeResult[]> {
    if (this.probing) {
      return [];
    }
    this.probing = true;
    try {
      const agents = normalizeAgents(this.getAgents());
      const results: ProbeResult[] = [];
      const tasks: Array<Promise<void>> = [];
      for (const [agentId, agent] of agents.entries()) {
        tasks.push(
          this.probeAgent(agentId, agent).then((result) => {
            results.push(result);
          }),
        );
      }
      await Promise.all(tasks);
      return results;
    } finally {
      this.probing = false;
    }
  }

  /**
   * Marks agents Offline when their last heartbeat is older than the TTL.
   * Offline agents are excluded from discovery by the registry server.
   */
  async sweepStaleAgents(now: number = Date.now()): Promise<string[]> {
    if (!this.getLastHeartbeat) {
      return [];
    }
    const agents = normalizeAgents(this.getAgents());
    const stale: string[] = [];
    const tasks: Array<Promise<void>> = [];
    for (const [agentId, agent] of agents.entries()) {
      const lastHeartbeat = this.getLastHeartbeat(agentId);
      if (lastHeartbeat === undefined) {
        continue;
      }
      if (now - lastHeartbeat <= this.heartbeatTtlMs) {
        continue;
      }
      const state = this.getState(agentId, agent);
      if (state.status === 'Offline') {
        continue;
      }
      state.status = 'Offline';
      stale.push(agentId);
      tasks.push(
        Promise.resolve(this.setStatus(agentId, 'Offline')).catch((err) => {
          this.logger.error(
            `[AgentHealthMonitor] failed to set status Offline for ${agentId}`,
            err,
          );
        }),
      );
      this.emit('offline', {
        agentId,
        agent,
        error: `heartbeat TTL exceeded (${now - lastHeartbeat}ms > ${this.heartbeatTtlMs}ms)`,
      });
    }
    await Promise.all(tasks);
    return stale;
  }

  private getState(agentId: string, agent: AgentRecord): AgentState {
    let state = this.states.get(agentId);
    if (!state) {
      const initialStatus: AgentStatus =
        agent.status === 'Offline' ? 'Offline' : 'Online';
      state = { consecutiveFailures: 0, status: initialStatus };
      this.states.set(agentId, state);
    }
    return state;
  }

  private async probeAgent(
    agentId: string,
    agent: AgentRecord,
  ): Promise<ProbeResult> {
    const state = this.getState(agentId, agent);
    const manifestUrl = resolveManifestUrl(agent);

    if (!manifestUrl) {
      // No endpoint to probe; treat as a failure so it can be marked offline.
      return this.recordFailure(agentId, agent, state, 'missing manifest URL');
    }

    const healthUrl = buildHealthUrl(manifestUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof (timeout as { unref?: () => void }).unref === 'function') {
      (timeout as { unref: () => void }).unref();
    }

    try {
      const response = await this.fetchImpl(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return this.recordFailure(
          agentId,
          agent,
          state,
          `health check returned ${response.status}`,
        );
      }
      return this.recordSuccess(agentId, agent, state);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? `health check timed out after ${this.timeoutMs}ms`
            : err.message
          : String(err);
      return this.recordFailure(agentId, agent, state, message);
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordSuccess(
    agentId: string,
    agent: AgentRecord,
    state: AgentState,
  ): ProbeResult {
    state.consecutiveFailures = 0;
    const wasOffline = state.status === 'Offline';
    let transitionedToOnline = false;
    if (wasOffline) {
      state.status = 'Online';
      transitionedToOnline = true;
      void Promise.resolve(this.setStatus(agentId, 'Online')).catch((err) => {
        this.logger.error(
          `[AgentHealthMonitor] failed to set status Online for ${agentId}`,
          err,
        );
      });
      this.emit('online', { agentId, agent });
    }
    return {
      agentId,
      ok: true,
      status: state.status,
      consecutiveFailures: 0,
      transitionedToOffline: false,
      transitionedToOnline,
    };
  }

  private recordFailure(
    agentId: string,
    agent: AgentRecord,
    state: AgentState,
    error: string,
  ): ProbeResult {
    state.consecutiveFailures += 1;
    let transitionedToOffline = false;
    if (
      state.status !== 'Offline' &&
      state.consecutiveFailures >= this.failureThreshold
    ) {
      state.status = 'Offline';
      transitionedToOffline = true;
      void Promise.resolve(this.setStatus(agentId, 'Offline')).catch((err) => {
        this.logger.error(
          `[AgentHealthMonitor] failed to set status Offline for ${agentId}`,
          err,
        );
      });
      this.emit('offline', { agentId, agent, error });
      void this.sendAlert(agentId, agent, error).catch((err) => {
        this.logger.error(
          `[AgentHealthMonitor] failed to send alert for ${agentId}`,
          err,
        );
      });
    }
    return {
      agentId,
      ok: false,
      status: state.status,
      consecutiveFailures: state.consecutiveFailures,
      transitionedToOffline,
      transitionedToOnline: false,
      error,
    };
  }

  private async sendAlert(
    agentId: string,
    agent: AgentRecord,
    error: string,
  ): Promise<void> {
    const target =
      this.alertWebhookUrl ?? agent.ownerWebhookUrl ?? agent.ownerEndpoint;
    if (!target) {
      return;
    }
    const payload = {
      type: 'agent.offline',
      agentId,
      status: 'Offline',
      error,
      consecutiveFailures: this.failureThreshold,
      timestamp: new Date().toISOString(),
    };
    try {
      await this.fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      this.emit('alert', { agentId, target, payload });
    } catch (err) {
      this.logger.warn(
        `[AgentHealthMonitor] alert webhook failed for ${agentId}`,
        err,
      );
      throw err;
    }
  }

  /**
   * Returns the current tracked state for an agent (for tests / introspection).
   */
  getAgentState(agentId: string): AgentState | undefined {
    const state = this.states.get(agentId);
    return state ? { ...state } : undefined;
  }

  /**
   * Clears tracked state for an agent (e.g. when it is unregistered).
   */
  forget(agentId: string): void {
    this.states.delete(agentId);
  }
}

export function createAgentHealthMonitor(
  options: AgentHealthMonitorOptions,
): AgentHealthMonitor {
  return new AgentHealthMonitor(options);
}

export default AgentHealthMonitor;