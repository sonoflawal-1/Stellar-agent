import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
import OpenApiResponseValidator from 'openapi-response-validator';
import { createDashboardServer, createDashboardApp } from './server';

/**
 * Shape of the structured error envelope required by #967.
 */
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message, requestId } = err as Record<string, unknown>;
  return (
    typeof code === 'string' &&
    code.length > 0 &&
    typeof message === 'string' &&
    message.length > 0 &&
    typeof requestId === 'string' &&
    requestId.length > 0
  );
}

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, any>>;
  components?: Record<string, any>;
}

const OPENAPI_PATH = resolve(__dirname, '../../docs/openapi.yaml');

let openApiDoc: OpenApiDocument;
let server: Server;
let baseUrl: string;

function loadOpenApi(): OpenApiDocument {
  const raw = readFileSync(OPENAPI_PATH, 'utf8');
  return parseYaml(raw) as OpenApiDocument;
}

function buildValidator(
  path: string,
  method: string,
  statusCode: string,
): OpenApiResponseValidator {
  const operation = openApiDoc.paths[path]?.[method.toLowerCase()];
  if (!operation) {
    throw new Error(`No operation documented for ${method.toUpperCase()} ${path}`);
  }
  const responses = operation.responses ?? {};
  const responseSpec = responses[statusCode] ?? responses.default;
  if (!responseSpec) {
    throw new Error(
      `No response documented for ${method.toUpperCase()} ${path} status ${statusCode}`,
    );
  }
  return new OpenApiResponseValidator({
    responses: { [statusCode]: responseSpec },
    components: openApiDoc.components,
  } as any);
}

async function fetchJson(
  path: string,
  method: string = 'GET',
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, { ...init, method });
  const text = await res.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers };
}

/**
 * Resolves documented path templates (e.g. `/items/{id}`) into a concrete
 * request path using the provided parameter values.
 */
function resolvePath(
  template: string,
  params: Record<string, string> = {},
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for ${template}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Enumerates every documented (path, method) pair from the OpenAPI document.
 */
function documentedOperations(): Array<{
  path: string;
  method: string;
  operation: any;
}> {
  const ops: Array<{ path: string; method: string; operation: any }> = [];
  for (const [path, methods] of Object.entries(openApiDoc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        ops.push({ path, method, operation });
      }
    }
  }
  return ops;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Introspects the Express app's registered routes. Express stores routes on
 * the router stack; each layer exposes `route` (with `path` and `methods`)
 * for concrete routes, or `name === 'router'` for mounted sub-routers.
 */
function registeredRoutes(): Array<{ path: string; method: string }> {
  const app = createDashboardApp() as any;
  const routes: Array<{ path: string; method: string }> = [];

  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const routePath = `${prefix}${layer.route.path}`.replace(/\/+$/, '') || '/';
        for (const method of Object.keys(layer.route.methods ?? {})) {
          if (layer.route.methods[method]) {
            routes.push({ path: routePath, method: method.toLowerCase() });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Best-effort prefix extraction from the mounted router's regexp.
        const match = layer.regexp?.source?.match(/\\\/([^\\]+)/);
        const mountPath = match ? `/${match[1]}` : '';
        walk(layer.handle.stack, `${prefix}${mountPath}`);
      }
    }
  };

  walk(app._router?.stack ?? app.router?.stack ?? [], '');
  return routes;
}

/**
 * Normalizes an Express route path (e.g. `/items/:id`) into the OpenAPI
 * template form (e.g. `/items/{id}`).
 */
function toOpenApiTemplate(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Returns true when the given (path, method) is documented in the OpenAPI
 * document, either directly or via a documented path template.
 */
function isDocumented(path: string, method: string): boolean {
  const methods = openApiDoc.paths[path];
  if (methods && methods[method]) {
    return true;
  }
  // Fall back to template matching for parameterized paths.
  for (const [template, templateMethods] of Object.entries(openApiDoc.paths)) {
    if (!templateMethods[method]) continue;
    const pattern = new RegExp(
      `^${template.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/')}$`,
    );
    if (pattern.test(path)) {
      return true;
    }
  }
  return false;
}

beforeAll(async () => {
  openApiDoc = loadOpenApi();
  server = createDashboardServer();
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    });
  }
});

describe('dashboard API contract (docs/openapi.yaml)', () => {
  it('documents at least one route', () => {
    expect(documentedOperations().length).toBeGreaterThan(0);
  });

  it('covers every documented route with a contract test', () => {
    // This assertion guards against silently skipping routes: every documented
    // operation must be reachable through the parametrized suite below.
    const ops = documentedOperations();
    const covered = new Set(
      ops.map((op) => `${op.method.toUpperCase()} ${op.path}`),
    );
    expect(covered.size).toBe(ops.length);
  });

  it('documents every Express route registered on the app', () => {
    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThan(0);

    const undocumented = routes
      .filter((route) => !isDocumented(toOpenApiTemplate(route.path), route.method))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(
      undocumented,
      `Undocumented Express routes found (add them to docs/openapi.yaml):\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });

  it('exposes every unversioned route under the /api/v1 alias', () => {
    const routes = registeredRoutes();
    const unversioned = routes.filter(
      (route) => route.path.startsWith('/api/') && !route.path.startsWith('/api/v1/'),
    );
    expect(unversioned.length).toBeGreaterThan(0);

    const missingAlias = unversioned
      .filter((route) => {
        const aliasPath = route.path.replace(/^\/api\//, '/api/v1/');
        return !routes.some(
          (candidate) =>
            candidate.method === route.method && candidate.path === aliasPath,
        );
      })
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(
      missingAlias,
      `Routes missing a /api/v1 alias:\n${missingAlias.join('\n')}`,
    ).toEqual([]);
  });

  it('documents the /api/v1 alias routes in the OpenAPI document', () => {
    const routes = registeredRoutes().filter((route) =>
      route.path.startsWith('/api/v1/'),
    );
    expect(routes.length).toBeGreaterThan(0);

    const undocumented = routes
      .filter((route) => !isDocumented(toOpenApiTemplate(route.path), route.method))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect(
      undocumented,
      `Undocumented /api/v1 routes found (add them to docs/openapi.yaml):\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });

  describe.each(
    documentedOperations().map((op) => [
      `${op.method.toUpperCase()} ${op.path}`,
      op,
    ]),
  )('%s', (_label, op) => {
    it('returns a response matching the documented schema', async () => {
      const pathParams: Record<string, string> = {};
      const parameters = op.operation.parameters ?? [];
      for (const param of parameters) {
        if (param.in === 'path') {
          // Use a representative value; servers should return 404 for unknown
          // ids, which must also be documented.
          pathParams[param.name] = param.example ?? '1';
        }
      }

      const requestPath = resolvePath(op.path, pathParams);
      const { status, body } = await fetchJson(requestPath, op.method);

      const statusKey = String(status);
      const responses = op.operation.responses ?? {};
      const documentedStatus =
        responses[statusKey] !== undefined
          ? statusKey
          : responses.default !== undefined
            ? 'default'
            : undefined;

      expect(
        documentedStatus,
        `Response status ${status} for ${op.method.toUpperCase()} ${op.path} is not documented`,
      ).toBeDefined();

      const validator = buildValidator(op.path, op.method, statusKey);
      const result = validator.validateResponse(status, body);
      expect(result, JSON.stringify(result, null, 2)).toBeUndefined();
    });
  });

  describe('structured error envelope (#967)', () => {
    it('returns { error: { code, message, requestId } } for unknown /api routes', async () => {
      const { status, body } = await fetchJson('/api/__does_not_exist__');
      expect(status).toBe(404);
      expect(isErrorEnvelope(body)).toBe(true);
      if (isErrorEnvelope(body)) {
        expect(body.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns the envelope for malformed request bodies', async () => {
      const { status, body } = await fetchJson('/api/agents/match', 'POST', {
        headers: { 'content-type': 'application/json' },
        body: '{ not valid json',
      });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(isErrorEnvelope(body)).toBe(true);
      if (isErrorEnvelope(body)) {
        expect(body.error.code).toBe('INVALID_REQUEST');
      }
    });

    it('propagates a request id header that matches the envelope', async () => {
      const { body, headers } = await fetchJson('/api/__does_not_exist__');
      const headerId = headers.get('x-request-id');
      expect(headerId).toBeTruthy();
      if (isErrorEnvelope(body)) {
        expect(body.error.requestId).toBe(headerId);
      }
    });

    it('uses the envelope for every documented /api error response', async () => {
      const apiOps = documentedOperations().filter((op) =>
        op.path.startsWith('/api/'),
      );
      expect(apiOps.length).toBeGreaterThan(0);
      for (const op of apiOps) {
        const pathParams: Record<string, string> = {};
        for (const param of op.operation.parameters ?? []) {
          if (param.in === 'path') pathParams[param.name] = param.example ?? '1';
        }
        const requestPath = resolvePath(op.path, pathParams);
        const { status, body } = await fetchJson(requestPath, op.method);
        if (status >= 400) {
          expect(
            isErrorEnvelope(body),
            `Expected error envelope for ${op.method.toUpperCase()} ${op.path} (status ${status})`,
          ).toBe(true);
        }
      }
    });
  });

  describe('/readyz dependency readiness (#966)', () => {
    it('returns 200 with per-dependency status when healthy', async () => {
      const { status, body } = await fetchJson('/readyz');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ready: true });
      const deps = (body as { dependencies?: Record<string, unknown> })
        .dependencies;
      expect(deps).toBeDefined();
      expect(deps).toHaveProperty('rpc');
      expect(deps).toHaveProperty('indexerDb');
      expect(deps).toHaveProperty('model');
    });

    it('returns 503 when the RPC dependency is unreachable', async () => {
      // Point the server at a closed port so the RPC probe fails fast.
      const unreachable = createDashboardServer({
        rpcUrl: 'http://127.0.0.1:1',
        readinessTimeoutMs: 250,
      });
      await new Promise<void>((resolveListen) => {
        unreachable.listen(0, '127.0.0.1', () => resolveListen());
      });
      const address = unreachable.address() as AddressInfo;
      try {
        const res = await fetch(`http://127.0.0.1:${address.port}/readyz`);
        const body = (await res.json()) as {
          ready?: boolean;
          dependencies?: Record<string, { ok?: boolean }>;
        };
        expect(res.status).toBe(503);
        expect(body.ready).toBe(false);
        expect(body.dependencies?.rpc?.ok).toBe(false);
      } finally {
        await new Promise<void>((resolveClose, reject) => {
          unreachable.close((err) => (err ? reject(err) : resolveClose()));
        });
      }
    });
  });

  describe('/api/agents/match embedding cache and memory ceiling (#965)', () => {
    const matchBody = {
      query: 'find an agent that summarizes documents',
      limit: 5,
    };

    it('reports a cache miss on the first call and a hit on the second', async () => {
      const first = await fetchJson('/api/agents/match', 'POST', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(matchBody),
      });
      expect(first.status).toBe(200);
      expect(first.headers.get('x-embedding-cache')).toBe('miss');

      const second = await fetchJson('/api/agents/match', 'POST', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(matchBody),
      });
      expect(second.status).toBe(200);
      expect(second.headers.get('x-embedding-cache')).toBe('hit');
    });

    it('keeps the embedding cache under its memory ceiling', async () => {
      const { status, body } = await fetchJson('/api/agents/match', 'POST', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(matchBody),
      });
      expect(status).toBe(200);
      const stats = (body as { cache?: { size?: number; maxEntries?: number } })
        .cache;
      expect(stats).toBeDefined();
      expect(typeof stats?.size).toBe('number');
      expect(typeof stats?.maxEntries).toBe('number');
      expect(stats!.size!).toBeLessThanOrEqual(stats!.maxEntries!);
    });
  });

  describe('/api/admin/audit filtering and pagination (#968)', () => {
    it('filters by actor', async () => {
      const { status, body } = await fetchJson(
        '/api/admin/audit?actor=alice&page=1&pageSize=10',
      );
      expect(status).toBe(200);
      const entries = (body as { entries?: Array<{ actor?: string }> }).entries;
      expect(Array.isArray(entries)).toBe(true);
      for (const entry of entries ?? []) {
        expect(entry.actor).toBe('alice');
      }
    });

    it('filters by action and time range', async () => {
      const from = encodeURIComponent('2024-01-01T00:00:00.000Z');
      const to = encodeURIComponent('2030-01-01T00:00:00.000Z');
      const { status, body } = await fetchJson(
        `/api/admin/audit?action=login&from=${from}&to=${to}&page=1&pageSize=10`,
      );
      expect(status).toBe(200);
      const entries = (
        body as { entries?: Array<{ action?: string; timestamp?: string }> }
      ).entries;
      expect(Array.isArray(entries)).toBe(true);
      for (const entry of entries ?? []) {
        expect(entry.action).toBe('login');
        if (entry.timestamp) {
          expect(entry.timestamp >= '2024-01-01T00:00:00.000Z').toBe(true);
          expect(entry.timestamp <= '2030-01-01T00:00:00.000Z').toBe(true);
        }
      }
    });

    it('paginates results and reports total count', async () => {
      const first = await fetchJson('/api/admin/audit?page=1&pageSize=2');
      expect(first.status).toBe(200);
      const firstBody = first.body as {
        entries?: unknown[];
        total?: number;
        page?: number;
        pageSize?: number;
      };
      expect(firstBody.page).toBe(1);
      expect(firstBody.pageSize).toBe(2);
      expect(typeof firstBody.total).toBe('number');
      expect((firstBody.entries ?? []).length).toBeLessThanOrEqual(2);

      const second = await fetchJson('/api/admin/audit?page=2&pageSize=2');
      expect(second.status).toBe(200);
      const secondBody = second.body as { entries?: unknown[] };
      expect((secondBody.entries ?? []).length).toBeLessThanOrEqual(2);
    });

    it('rejects an invalid time range with the error envelope', async () => {
      const { status, body } = await fetchJson(
        '/api/admin/audit?from=not-a-date',
      );
      expect(status).toBe(400);
      expect(isErrorEnvelope(body)).toBe(true);
      if (isErrorEnvelope(body)) {
        expect(body.error.code).toBe('INVALID_REQUEST');
      }
    });
  });

  describe('negative validation (proves the validator catches drift)', () => {
    it('fails the route coverage check when a route is undocumented', () => {
      // Simulate an undocumented route by checking a path that is not present
      // in the OpenAPI document. This proves the coverage assertion would fail
      // on drift rather than silently passing.
      expect(isDocumented('/__contract_test_undocumented__', 'get')).toBe(false);
    });

    it('fails validation when a response violates the documented schema', () => {
      const ops = documentedOperations();
      const op = ops.find((o) => o.method === 'get');
      expect(op, 'expected at least one documented GET route').toBeDefined();

      const successStatus = Object.keys(op!.operation.responses ?? {}).find(
        (code) => /^2\d\d$/.test(code),
      );
      expect(
        successStatus,
        `expected a documented 2xx response for ${op!.path}`,
      ).toBeDefined();

      const validator = buildValidator(op!.path, op!.method, successStatus!);

      // Deliberately malformed payload: wrong type for every field and a
      // missing required property. This must be rejected by the validator.
      const invalidBody = {
        __contract_test_invalid__: true,
        unexpected: 'this should not validate',
      };

      const result = validator.validateResponse(
        Number(successStatus),
        invalidBody,
      );
      expect(result).toBeDefined();
      expect(result?.errors?.length ?? 0).toBeGreaterThan(0);
    });

    it('fails validation when a required field is missing', () => {
      const ops = documentedOperations();
      const op = ops.find((o) => o.method === 'get');
      expect(op, 'expected at least one documented GET route').toBeDefined();

      const successStatus = Object.keys(op!.operation.responses ?? {}).find(
        (code) => /^2\d\d$/.test(code),
      );
      expect(successStatus).toBeDefined();

      const validator = buildValidator(op!.path, op!.method, successStatus!);

      // Empty object: any required property in the documented schema will be
      // reported as missing.
      const result = validator.validateResponse(Number(successStatus), {});
      expect(result).toBeDefined();
    });
  });
});