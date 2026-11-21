'use client';

import React from 'react';

export interface EscrowStepperProps {
  currentStep: number;
  steps?: string[];
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_STEPS = ['Funded', 'Submitted', 'Completed'];

export function EscrowStepper({
  currentStep,
  steps = DEFAULT_STEPS,
  className,
  style,
}: EscrowStepperProps): React.ReactElement {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        ...style,
      }}
    >
      {steps.map((step, idx) => {
        const isCompleted = idx < currentStep;
        const isCurrent = idx === currentStep;

        return (
          <React.Fragment key={step}>
            {idx > 0 && (
              <div
                style={{
                  flex: 1,
                  height: '2px',
                  background: isCompleted ? '#3b82f6' : '#e5e7eb',
                  minWidth: '1.5rem',
                }}
              />
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                fontSize: '0.875rem',
                fontWeight: isCurrent ? 600 : 400,
                color: isCurrent ? '#1d4ed8' : isCompleted ? '#059669' : '#6b7280',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '1.5rem',
                  height: '1.5rem',
                  borderRadius: '50%',
                  background: isCurrent ? '#3b82f6' : isCompleted ? '#10b981' : '#f3f4f6',
                  color: isCurrent || isCompleted ? '#ffffff' : '#6b7280',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                }}
              >
                {isCompleted ? '✓' : idx + 1}
              </span>
              <span>{step}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default EscrowStepper;
