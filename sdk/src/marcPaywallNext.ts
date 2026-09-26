import { marcPaywallCore } from "./marcPaywallCore.js";
import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

export type MarcPaywallNextOptions = MarcPaywallCoreOptions;
export type MarcPaywallNextHandler = (request: Request) => Response | Promise<Response>;

export function marcPaywallNext(
  opts: MarcPaywallNextOptions,
  handler: MarcPaywallNextHandler,
): MarcPaywallNextHandler {
  return async (request) => {
    const result = await marcPaywallCore(opts, {
      headers: request.headers,
      method: request.method,
      url: request.url,
    });

    if (!result.ok) {
      return Response.json(result.body, { status: result.status });
    }

    return handler(request);
  };
}
