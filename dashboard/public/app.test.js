// dashboard/public/app.test.js
// Unit tests for the pre-flight transaction simulation helpers.
// Run with: npm test (see package.json "test" script)

const {
  parseSimulationResult,
  extractSimulationError,
  createWalletStateMachine,
  WALLET_STATES,
  validateJobForm,
  computeFeePreview,
  buildJobTimeline,
} = require('./app.js');

describe('parseSimulationResult', () => {
  test('extracts cpuInsns, memBytes, minResourceFee and balance diffs from a successful simulation', () => {
    const sample = {
      // Mirrors the shape returned by rpc.Server.simulateTransaction()
      transactionData: {
        buildSuccess: true,
        resources: {
          instructions: 1234567,
          readBytes: 2048,
          writeBytes: 512,
        },
        footprint: {
          readOnly: ['AAAA'],
          readWrite: ['BBBB'],
        },
      },
      cost: {
        cpuInsns: '1234567',
        memBytes: '4096',
      },
      minResourceFee: '100234',
      result: {
        retval: 'AAAAAA==',
        auth: [],
      },
      // Balance diffs as produced by the simulation (token balance changes)
      balanceDiffs: [
        {
          asset: 'native',
          amount: '-100234',
        },
        {
          asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '-5000000',
        },
      ],
      latestLedger: 12345,
      events: [],
    };

    const parsed = parseSimulationResult(sample);

    expect(parsed).not.toBeNull();
    expect(parsed.cpuInsns).toBe(1234567);
    expect(parsed.memBytes).toBe(4096);
    expect(parsed.minResourceFee).toBe(100234);

    expect(Array.isArray(parsed.balanceDiffs)).toBe(true);
    expect(parsed.balanceDiffs).toHaveLength(2);
    expect(parsed.balanceDiffs[0]).toEqual({
      asset: 'native',
      amount: -100234,
    });
    expect(parsed.balanceDiffs[1].asset).toBe(
      'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
    expect(parsed.balanceDiffs[1].amount).toBe(-5000000);
  });

  test('falls back to transactionData.resources when cost block is absent', () => {
    const sample = {
      transactionData: {
        buildSuccess: true,
        resources: {
          instructions: 999,
          readBytes: 100,
          writeBytes: 200,
        },
      },
      minResourceFee: '42',
      result: { retval: 'AAAAAA==', auth: [] },
      balanceDiffs: [],
    };

    const parsed = parseSimulationResult(sample);

    expect(parsed).not.toBeNull();
    expect(parsed.cpuInsns).toBe(999);
    // memBytes derived from readBytes + writeBytes
    expect(parsed.memBytes).toBe(300);
    expect(parsed.minResourceFee).toBe(42);
    expect(parsed.balanceDiffs).toEqual([]);
  });

  test('returns null for a null/undefined simulation result', () => {
    expect(parseSimulationResult(null)).toBeNull();
    expect(parseSimulationResult(undefined)).toBeNull();
  });

  test('returns null when the simulation indicates failure', () => {
    const failed = {
      error: 'HostError: Error(Contract, #1)',
      transactionData: { buildSuccess: false },
    };
    expect(parseSimulationResult(failed)).toBeNull();
  });
});

describe('extractSimulationError', () => {
  test('returns null for a successful simulation', () => {
    const success = {
      transactionData: { buildSuccess: true },
      cost: { cpuInsns: '10', memBytes: '20' },
      minResourceFee: '5',
      result: { retval: 'AAAAAA==', auth: [] },
    };
    expect(extractSimulationError(success)).toBeNull();
  });

  test('returns null for a null/undefined simulation result', () => {
    expect(extractSimulationError(null)).toBeNull();
    expect(extractSimulationError(undefined)).toBeNull();
  });

  test('extracts contract error code and message for insufficient token balance', () => {
    const failed = {
      error: 'HostError: Error(Contract, #1)',
      transactionData: { buildSuccess: false },
      // Soroban contract error details
      diagnosticEvents: [
        {
          type: 'diagnostic',
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          topics: ['error'],
          data: 'insufficient balance',
        },
      ],
    };

    const err = extractSimulationError(failed);

    expect(err).not.toBeNull();
    expect(err.code).toBe(1);
    expect(typeof err.message).toBe('string');
    expect(err.message.toLowerCase()).toContain('insufficient');
    expect(err.raw).toBe('HostError: Error(Contract, #1)');
  });

  test('extracts contract error code from a plain error string', () => {
    const failed = {
      error: 'HostError: Error(Contract, #7)',
      transactionData: { buildSuccess: false },
    };

    const err = extractSimulationError(failed);

    expect(err).not.toBeNull();
    expect(err.code).toBe(7);
    expect(err.raw).toBe('HostError: Error(Contract, #7)');
  });

  test('returns a generic error object when no contract code is present', () => {
    const failed = {
      error: 'network timeout',
      transactionData: { buildSuccess: false },
    };

    const err = extractSimulationError(failed);

    expect(err).not.toBeNull();
    expect(err.code).toBeNull();
    expect(err.message).toBe('network timeout');
    expect(err.raw).toBe('network timeout');
  });
});

describe('wallet state machine', () => {
  test('exposes the expected states', () => {
    expect(WALLET_STATES).toEqual(
      expect.objectContaining({
        IDLE: 'idle',
        CONNECTING: 'connecting',
        SIGNING: 'signing',
        SUBMITTED: 'submitted',
        FAILED: 'failed',
      })
    );
  });

  test('starts in idle', () => {
    const sm = createWalletStateMachine();
    expect(sm.getState()).toBe(WALLET_STATES.IDLE);
  });

  test('walks the happy path idle -> connecting -> signing -> submitted', () => {
    const sm = createWalletStateMachine();
    expect(sm.transition(WALLET_STATES.CONNECTING)).toBe(true);
    expect(sm.getState()).toBe(WALLET_STATES.CONNECTING);
    expect(sm.transition(WALLET_STATES.SIGNING)).toBe(true);
    expect(sm.getState()).toBe(WALLET_STATES.SIGNING);
    expect(sm.transition(WALLET_STATES.SUBMITTED)).toBe(true);
    expect(sm.getState()).toBe(WALLET_STATES.SUBMITTED);
  });

  test('allows failure from connecting and signing', () => {
    const fromConnecting = createWalletStateMachine();
    fromConnecting.transition(WALLET_STATES.CONNECTING);
    expect(fromConnecting.transition(WALLET_STATES.FAILED)).toBe(true);
    expect(fromConnecting.getState()).toBe(WALLET_STATES.FAILED);

    const fromSigning = createWalletStateMachine();
    fromSigning.transition(WALLET_STATES.CONNECTING);
    fromSigning.transition(WALLET_STATES.SIGNING);
    expect(fromSigning.transition(WALLET_STATES.FAILED)).toBe(true);
    expect(fromSigning.getState()).toBe(WALLET_STATES.FAILED);
  });

  test('rejects invalid transitions and keeps the current state', () => {
    const sm = createWalletStateMachine();
    // idle -> signing is not allowed
    expect(sm.transition(WALLET_STATES.SIGNING)).toBe(false);
    expect(sm.getState()).toBe(WALLET_STATES.IDLE);
    // idle -> submitted is not allowed
    expect(sm.transition(WALLET_STATES.SUBMITTED)).toBe(false);
    expect(sm.getState()).toBe(WALLET_STATES.IDLE);
  });

  test('rejects transitions out of a terminal submitted state', () => {
    const sm = createWalletStateMachine();
    sm.transition(WALLET_STATES.CONNECTING);
    sm.transition(WALLET_STATES.SIGNING);
    sm.transition(WALLET_STATES.SUBMITTED);
    expect(sm.transition(WALLET_STATES.CONNECTING)).toBe(false);
    expect(sm.getState()).toBe(WALLET_STATES.SUBMITTED);
  });

  test('allows reset from failed back to idle', () => {
    const sm = createWalletStateMachine();
    sm.transition(WALLET_STATES.CONNECTING);
    sm.transition(WALLET_STATES.FAILED);
    expect(sm.transition(WALLET_STATES.IDLE)).toBe(true);
    expect(sm.getState()).toBe(WALLET_STATES.IDLE);
  });

  test('notifies subscribers on state change and records the error on failure', () => {
    const sm = createWalletStateMachine();
    const seen = [];
    const unsubscribe = sm.subscribe((state, error) => {
      seen.push({ state, error });
    });

    sm.transition(WALLET_STATES.CONNECTING);
    sm.transition(WALLET_STATES.FAILED, new Error('user rejected'));

    expect(seen).toHaveLength(2);
    expect(seen[0].state).toBe(WALLET_STATES.CONNECTING);
    expect(seen[1].state).toBe(WALLET_STATES.FAILED);
    expect(seen[1].error).toBeInstanceOf(Error);
    expect(seen[1].error.message).toBe('user rejected');

    unsubscribe();
    sm.transition(WALLET_STATES.IDLE);
    expect(seen).toHaveLength(2);
  });

  test('does not notify subscribers on a rejected transition', () => {
    const sm = createWalletStateMachine();
    const listener = jest.fn();
    sm.subscribe(listener);
    sm.transition(WALLET_STATES.SUBMITTED);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('validateJobForm', () => {
  const valid = {
    title: 'Build a dashboard',
    description: 'Implement the timeline view',
    budget: '100',
    deadline: '2030-01-01',
  };

  test('accepts a valid form', () => {
    const result = validateJobForm(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  test('requires a non-empty title', () => {
    const result = validateJobForm({ ...valid, title: '   ' });
    expect(result.valid).toBe(false);
    expect(result.errors.title).toBeDefined();
  });

  test('requires a description', () => {
    const result = validateJobForm({ ...valid, description: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.description).toBeDefined();
  });

  test('rejects a non-numeric or non-positive budget', () => {
    expect(validateJobForm({ ...valid, budget: 'abc' }).errors.budget).toBeDefined();
    expect(validateJobForm({ ...valid, budget: '0' }).errors.budget).toBeDefined();
    expect(validateJobForm({ ...valid, budget: '-5' }).errors.budget).toBeDefined();
  });

  test('rejects a budget with too many decimal places', () => {
    const result = validateJobForm({ ...valid, budget: '1.12345678' });
    expect(result.valid).toBe(false);
    expect(result.errors.budget).toBeDefined();
  });

  test('rejects a deadline in the past', () => {
    const result = validateJobForm(
      { ...valid, deadline: '2000-01-01' },
      { now: new Date('2024-01-01T00:00:00Z') }
    );
    expect(result.valid).toBe(false);
    expect(result.errors.deadline).toBeDefined();
  });

  test('ties each error to its field', () => {
    const result = validateJobForm({
      title: '',
      description: '',
      budget: 'x',
      deadline: 'bad',
    });
    expect(Object.keys(result.errors).sort()).toEqual(
      ['budget', 'deadline', 'description', 'title'].sort()
    );
  });
});

describe('computeFeePreview', () => {
  test('computes fee and net payout from budget and simulated fee', () => {
    const preview = computeFeePreview({ budget: '100', fee: '2.5' });
    expect(preview.budget).toBe(100);
    expect(preview.fee).toBe(2.5);
    expect(preview.netPayout).toBe(97.5);
  });

  test('handles zero fee', () => {
    const preview = computeFeePreview({ budget: '50', fee: '0' });
    expect(preview.netPayout).toBe(50);
  });

  test('never returns a negative net payout', () => {
    const preview = computeFeePreview({ budget: '1', fee: '5' });
    expect(preview.netPayout).toBe(0);
  });

  test('returns null when inputs are invalid', () => {
    expect(computeFeePreview({ budget: 'abc', fee: '1' })).toBeNull();
    expect(computeFeePreview({ budget: '10', fee: 'abc' })).toBeNull();
  });
});

describe('buildJobTimeline', () => {
  const events = [
    { type: 'created', ledger: 100, txHash: 'AAA', ledgerCloseTime: '2024-01-01T00:00:00Z' },
    { type: 'funded', ledger: 110, txHash: 'BBB', ledgerCloseTime: '2024-01-02T00:00:00Z' },
    { type: 'submitted', ledger: 120, txHash: 'CCC', ledgerCloseTime: '2024-01-03T00:00:00Z' },
    { type: 'completed', ledger: 130, txHash: 'DDD', ledgerCloseTime: '2024-01-04T00:00:00Z' },
  ];

  test('maps events into ordered lifecycle steps', () => {
    const timeline = buildJobTimeline(events);
    expect(timeline.map((s) => s.type)).toEqual([
      'created',
      'funded',
      'submitted',
      'completed',
    ]);
    expect(timeline[0].ledger).toBe(100);
    expect(timeline[0].txHash).toBe('AAA');
    expect(timeline[0].ledgerCloseTime).toBe('2024-01-01T00:00:00Z');
  });

  test('marks steps without events as pending', () => {
    const timeline = buildJobTimeline(events.slice(0, 2));
    const submitted = timeline.find((s) => s.type === 'submitted');
    expect(submitted.status).toBe('pending');
    expect(submitted.ledger).toBeNull();
  });

  test('handles a disputed job', () => {
    const disputed = [
      ...events.slice(0, 3),
      { type: 'disputed', ledger: 140, txHash: 'EEE', ledgerCloseTime: '2024-01-05T00:00:00Z' },
    ];
    const timeline = buildJobTimeline(disputed);
    const disputedStep = timeline.find((s) => s.type === 'disputed');
    expect(disputedStep.status).toBe('done');
    expect(disputedStep.ledger).toBe(140);
  });

  test('handles missing or empty events', () => {
    expect(buildJobTimeline([]).every((s) => s.status === 'pending')).toBe(true);
    expect(buildJobTimeline(null).every((s) => s.status === 'pending')).toBe(true);
    expect(buildJobTimeline(undefined).every((s) => s.status === 'pending')).toBe(true);
  });

  test('tolerates partial events without ledger time or tx hash', () => {
    const partial = [{ type: 'created', ledger: 100 }];
    const timeline = buildJobTimeline(partial);
    const created = timeline.find((s) => s.type === 'created');
    expect(created.status).toBe('done');
    expect(created.txHash).toBeNull();
    expect(created.ledgerCloseTime).toBeNull();
  });
});