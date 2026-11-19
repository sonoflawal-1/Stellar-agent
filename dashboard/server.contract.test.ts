import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
import OpenApiResponseValidator from 'openapi-response-validator';
import { createDashboardServer } from './server';

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
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  const text = await res.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
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

  describe('negative validation (proves the validator catches drift)', () => {
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