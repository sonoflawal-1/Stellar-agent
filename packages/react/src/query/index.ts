/**
 * TanStack Query adapter for the Marc SDK React bindings.
 *
 * This module is optional: `@tanstack/react-query` is a peer dependency that
 * is only required if you import from `@marc/react/query`. The main
 * `@marc/react` entrypoint does not depend on it.
 *
 * ## Query key factory
 *
 * Query keys are exposed as small factories so that consumers can build
 * consistent keys for their own `useQuery` / `invalidateQueries` calls:
 *
 * ```ts
 * import { jobKeys, agentKeys } from '@marc/react/query';
 *
 * jobKeys.all;            // ['marc', 'jobs']
 * jobKeys.detail('abc');  // ['marc', 'jobs', 'abc']
 *
 * agentKeys.all;          // ['marc', 'agents']
 * agentKeys.detail('xyz');// ['marc', 'agents', 'xyz']
 * ```
 *
 * ## Invalidation helpers
 *
 * ```ts
 * import { useQueryClient } from '@tanstack/react-query';
 * import { invalidateJob, invalidateAgent } from '@marc/react/query';
 *
 * const queryClient = useQueryClient();
 * await invalidateJob(queryClient, 'abc');   // invalidate a single job
 * await invalidateJob(queryClient);          // invalidate all jobs
 * await invalidateAgent(queryClient, 'xyz'); // invalidate a single agent
 * await invalidateAgent(queryClient);        // invalidate all agents
 * ```
 */

import { useQuery } from '@tanstack/react-query';
import type {
  QueryClient,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';

import { useClient } from '../client';
import type { Agent, Job, MarcClient } from '@marc/sdk';

/**
 * Query key factory for jobs.
 *
 * - `all` — root key for every job query.
 * - `detail(id)` — key for a single job by id.
 */
export const jobKeys = {
  all: ['marc', 'jobs'] as const,
  detail: (id: string) => ['marc', 'jobs', id] as const,
};

/**
 * Query key factory for agents.
 *
 * - `all` — root key for every agent query.
 * - `detail(id)` — key for a single agent by id.
 */
export const agentKeys = {
  all: ['marc', 'agents'] as const,
  detail: (id: string) => ['marc', 'agents', id] as const,
};

/**
 * Invalidate cached job queries.
 *
 * When `jobId` is provided only that job's detail query is invalidated;
 * otherwise every job query is invalidated.
 */
export function invalidateJob(
  queryClient: QueryClient,
  jobId?: string,
): Promise<void> {
  const queryKey = jobId ? jobKeys.detail(jobId) : jobKeys.all;
  return queryClient.invalidateQueries({ queryKey });
}

/**
 * Invalidate cached agent queries.
 *
 * When `agentId` is provided only that agent's detail query is invalidated;
 * otherwise every agent query is invalidated.
 */
export function invalidateAgent(
  queryClient: QueryClient,
  agentId?: string,
): Promise<void> {
  const queryKey = agentId ? agentKeys.detail(agentId) : agentKeys.all;
  return queryClient.invalidateQueries({ queryKey });
}

/**
 * Options accepted by {@link useJobQuery} and {@link useAgentQuery}.
 *
 * Extends the standard TanStack Query options (minus `queryKey` and
 * `queryFn`, which are managed by the hook) and adds an optional `client`
 * override for the Marc SDK client.
 */
export type MarcQueryOptions<TData> = Omit<
  UseQueryOptions<TData, Error, TData, readonly unknown[]>,
  'queryKey' | 'queryFn'
> & {
  /** Optional Marc SDK client. Defaults to the one from `MarcProvider`. */
  client?: MarcClient;
};

/**
 * Fetch a single job via TanStack Query.
 *
 * @param jobId  The id of the job to fetch.
 * @param options  Optional TanStack Query options plus an optional `client`.
 */
export function useJobQuery(
  jobId: string,
  options: MarcQueryOptions<Job> = {},
): UseQueryResult<Job, Error> {
  const { client: clientOverride, ...queryOptions } = options;
  const contextClient = useClient();
  const client = clientOverride ?? contextClient;

  return useQuery<Job, Error, Job, readonly unknown[]>({
    queryKey: jobKeys.detail(jobId),
    queryFn: () => client.jobs.get(jobId),
    ...queryOptions,
  });
}

/**
 * Fetch a single agent via TanStack Query.
 *
 * @param agentId  The id of the agent to fetch.
 * @param options  Optional TanStack Query options plus an optional `client`.
 */
export function useAgentQuery(
  agentId: string,
  options: MarcQueryOptions<Agent> = {},
): UseQueryResult<Agent, Error> {
  const { client: clientOverride, ...queryOptions } = options;
  const contextClient = useClient();
  const client = clientOverride ?? contextClient;

  return useQuery<Agent, Error, Agent, readonly unknown[]>({
    queryKey: agentKeys.detail(agentId),
    queryFn: () => client.agents.get(agentId),
    ...queryOptions,
  });
}