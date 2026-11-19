'use client';

// Core SDK types re-exported directly from marc-stellar-sdk.
export type { Agent, Job, JobStatus, MarcConfig } from 'marc-stellar-sdk';

// Shared async state type.
export type { AsyncState, UseAsyncResult } from './hooks/useAsync';
export { useAsync } from './hooks/useAsync';

// Hooks and their option/result interfaces.
export { useAgent, clearAgentCache } from './hooks/useAgent';
export type { UseAgentOptions, UseAgentResult } from './hooks/useAgent';

export { useJob, clearJobCache, isTerminalJobStatus, parseJobId } from './hooks/useJob';
export type { UseJobOptions, UseJobResult } from './hooks/useJob';

export { useCreateJob } from './hooks/useCreateJob';
export type { UseCreateJobResult } from './hooks/useCreateJob';

export { useCommerce } from './hooks/useCommerce';
export type {
  UseCommerceOptions,
  UseCommerceResult,
  CreateJobParams,
  SubmitJobParams,
  CompleteJobParams,
  CancelJobParams,
  CreateJobResult,
} from './hooks/useCommerce';

export { usePaymentChannel } from './hooks/usePaymentChannel';
export type {
  UsePaymentChannelOptions,
  UsePaymentChannelResult,
  OpenChannelParams,
} from './hooks/usePaymentChannel';

export { useWallet, useWalletState } from './hooks/useWallet';
export type {
  UseWalletOptions,
  UseWalletResult,
  WalletProvider as StellarWalletProvider,
  WalletStatus,
  WalletBalances,
} from './hooks/useWallet';

// Multi-wallet context provider
export { WalletProvider, WalletContext, useWalletContext } from './context/WalletContext';
export type { WalletProviderProps, WalletContextValue } from './context/WalletContext';

// Components and prop interfaces.
export { AgentCard } from './components/AgentCard';
export type { AgentCardProps } from './components/AgentCard';

export { JobStatusBadge } from './components/JobStatusBadge';
export type { JobStatusBadgeProps } from './components/JobStatusBadge';

export { EscrowStepper } from './components/EscrowStepper';
export type { EscrowStepperProps } from './components/EscrowStepper';

// Wallet connect button component and its props.
export { WalletConnectButton } from './components/WalletConnectButton';
export type { WalletConnectButtonProps } from './components/WalletConnectButton';

// Optional TanStack Query adapter (also available via '@bear-protocol/react/query').
export {
  jobKeys,
  agentKeys,
  invalidateJob,
  invalidateAgent,
  useJobQuery,
  useAgentQuery,
} from './query';
export type {
  UseJobQueryOptions,
  UseJobQueryResult,
  UseAgentQueryOptions,
  UseAgentQueryResult,
} from './query';