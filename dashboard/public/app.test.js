// dashboard/public/app.test.js
// Unit tests for the pre-flight transaction simulation helpers.
// Run with: npm test (see package.json "test" script)

const {
  parseSimulationResult,
  extractSimulationError,
  validateAgentMetadata,
  buildAgentProfile,
  clearNetworkCaches,
  requiresMainnetConfirmation,
  getWalletNetworkMismatch,
  migrateAuditLogs,
  applyAuditRetention,
  parseApiError,
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

describe('validateAgentMetadata', () => {
  test('accepts metadata that conforms to the schema', () => {
    const metadata = {
      name: 'Example Agent',
      description: 'Does useful things',
      version: '1.0.0',
      capabilities: ['simulate', 'execute'],
      endpoint: 'https://agent.example.com',
    };

    const result = validateAgentMetadata(metadata);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('reports a warning instead of throwing for invalid metadata', () => {
    const metadata = {
      // name missing, capabilities wrong type
      description: 42,
      capabilities: 'not-an-array',
    };

    let result;
    expect(() => {
      result = validateAgentMetadata(metadata);
    }).not.toThrow();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/name|capabilities|description/i);
  });

  test('handles malformed JSON strings without crashing', () => {
    let result;
    expect(() => {
      result = validateAgentMetadata('{ not valid json');
    }).not.toThrow();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('handles null/undefined metadata gracefully', () => {
    expect(validateAgentMetadata(null).valid).toBe(false);
    expect(validateAgentMetadata(undefined).valid).toBe(false);
  });
});

describe('buildAgentProfile', () => {
  test('builds a profile with jobs and reputation from the indexer', () => {
    const agent = {
      id: 'GAGENT',
      metadata: { name: 'Example Agent', version: '1.0.0' },
    };
    const indexer = {
      jobs: [{ id: 'job-1', status: 'completed' }],
      reputation: { score: 4.5, reviews: 10 },
    };

    const profile = buildAgentProfile(agent, indexer);

    expect(profile.id).toBe('GAGENT');
    expect(profile.jobs).toHaveLength(1);
    expect(profile.reputation.score).toBe(4.5);
    expect(profile.metadataWarning).toBeNull();
  });

  test('surfaces a metadata warning for invalid metadata without throwing', () => {
    const agent = {
      id: 'GBAD',
      metadata: { capabilities: 'nope' },
    };

    let profile;
    expect(() => {
      profile = buildAgentProfile(agent, { jobs: [], reputation: null });
    }).not.toThrow();

    expect(profile.metadataWarning).toBeTruthy();
    expect(profile.jobs).toEqual([]);
  });
});

describe('network switching', () => {
  test('clearNetworkCaches clears all registered caches', () => {
    const caches = {
      agents: { clear: jest.fn() },
      jobs: { clear: jest.fn() },
      reputation: { clear: jest.fn() },
    };

    clearNetworkCaches(caches);

    expect(caches.agents.clear).toHaveBeenCalled();
    expect(caches.jobs.clear).toHaveBeenCalled();
    expect(caches.reputation.clear).toHaveBeenCalled();
  });

  test('requiresMainnetConfirmation is true only for mainnet', () => {
    expect(requiresMainnetConfirmation('mainnet')).toBe(true);
    expect(requiresMainnetConfirmation('testnet')).toBe(false);
    expect(requiresMainnetConfirmation('futurenet')).toBe(false);
  });

  test('getWalletNetworkMismatch returns a banner when networks differ', () => {
    const mismatch = getWalletNetworkMismatch('testnet', 'mainnet');
    expect(mismatch).not.toBeNull();
    expect(typeof mismatch.message).toBe('string');
    expect(mismatch.message.toLowerCase()).toContain('mainnet');
  });

  test('getWalletNetworkMismatch returns null when networks match', () => {
    expect(getWalletNetworkMismatch('testnet', 'testnet')).toBeNull();
  });
});

describe('parseApiError', () => {
  test('parses the structured error envelope', () => {
    const body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'amount must be positive',
        requestId: 'req-123',
      },
    };

    const err = parseApiError(400, body);

    expect(err).not.toBeNull();
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('amount must be positive');
    expect(err.requestId).toBe('req-123');
    expect(err.status).toBe(400);
  });

  test('parses the structured envelope from a JSON string body', () => {
    const body = JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: 'agent not found',
        requestId: 'req-456',
      },
    });

    const err = parseApiError(404, body);

    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('agent not found');
    expect(err.requestId).toBe('req-456');
  });

  test('falls back gracefully on legacy { error: "message" } shapes', () => {
    const err = parseApiError(500, { error: 'internal failure' });

    expect(err).not.toBeNull();
    expect(err.code).toBeNull();
    expect(err.message).toBe('internal failure');
    expect(err.requestId).toBeNull();
    expect(err.status).toBe(500);
  });

  test('falls back gracefully on legacy { message } shapes', () => {
    const err = parseApiError(422, { message: 'bad input' });

    expect(err.code).toBeNull();
    expect(err.message).toBe('bad input');
    expect(err.requestId).toBeNull();
  });

  test('returns a generic error for empty or unparseable bodies', () => {
    expect(parseApiError(502, null).message).toBeTruthy();
    expect(parseApiError(502, '').message).toBeTruthy();
    expect(parseApiError(502, 'not json').message).toBeTruthy();
    expect(parseApiError(502, {}).code).toBeNull();
  });
});

describe('audit store migration and retention', () => {
  test('migrateAuditLogs imports JSONL records into the store', () => {
    const jsonl = [
      '{"ts":"2024-01-01T00:00:00Z","action":"login"}',
      '{"ts":"2024-01-02T00:00:00Z","action":"logout"}',
    ].join('\n');

    const store = { insertMany: jest.fn() };
    const result = migrateAuditLogs(jsonl, store);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(store.insertMany).toHaveBeenCalledTimes(1);
    expect(store.insertMany.mock.calls[0][0]).toHaveLength(2);
  });

  test('migrateAuditLogs skips malformed lines without throwing', () => {
    const jsonl = ['{"action":"login"}', 'not json', ''].join('\n');
    const store = { insertMany: jest.fn() };

    let result;
    expect(() => {
      result = migrateAuditLogs(jsonl, store);
    }).not.toThrow();

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  test('applyAuditRetention deletes records older than the retention window', () => {
    const now = new Date('2024-06-01T00:00:00Z').getTime();
    const store = {
      deleteOlderThan: jest.fn().mockReturnValue(3),
    };

    const deleted = applyAuditRetention(store, 30, now);

    expect(deleted).toBe(3);
    expect(store.deleteOlderThan).toHaveBeenCalledTimes(1);
    const cutoff = store.deleteOlderThan.mock.calls[0][0];
    expect(cutoff).toBe(now - 30 * 24 * 60 * 60 * 1000);
  });
});