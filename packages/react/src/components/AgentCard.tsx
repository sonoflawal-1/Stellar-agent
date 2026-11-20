'use client';

import React from 'react';
import type { Agent } from 'marc-stellar-sdk';

export interface AgentCardProps {
  agent: Agent;
  onHire?: (agent: Agent) => void;
  className?: string;
  style?: React.CSSProperties;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}

export function AgentCard({
  agent,
  onHire,
  className,
  style,
  headingLevel = 3,
}: AgentCardProps): React.ReactElement {
  const headingId = React.useId();
  const HeadingTag = `h${headingLevel}` as keyof JSX.IntrinsicElements;

  return (
    <div
      className={className}
      aria-labelledby={headingId}
      style={{
        border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: '0.5rem',
        padding: '1rem',
        background: '#ffffff',
        color: '#111827',
        ...style,
      }}
    >
      <HeadingTag
        id={headingId}
        style={{ fontWeight: 600, fontSize: '1.125rem', margin: '0 0 0.5rem 0' }}
      >
        Agent #{agent.id.toString()}
      </HeadingTag>
      <dl style={{ margin: 0 }}>
        <div style={{ fontSize: '0.875rem', color: '#4b5563', marginBottom: '0.25rem' }}>
          <dt style={{ display: 'inline', fontWeight: 500 }}>Owner: </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{agent.owner}</dd>
        </div>
        <div style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.75rem' }}>
          <dt style={{ display: 'inline', fontWeight: 500 }}>Metadata: </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{agent.uri}</dd>
        </div>
      </dl>
      {onHire ? (
        <button
          type="button"
          onClick={() => onHire(agent)}
          aria-label={`Hire Agent #${agent.id.toString()}`}
          style={{
            background: '#3b82f6',
            color: '#ffffff',
            border: 'none',
            borderRadius: '0.375rem',
            padding: '0.375rem 0.75rem',
            cursor: 'pointer',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          Hire Agent
        </button>
      ) : null}
    </div>
  );
}

export default AgentCard;