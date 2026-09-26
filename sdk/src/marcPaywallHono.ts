import { marcPaywallCore } from "./marcPaywallCore.js";
import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

export type MarcPaywallHonoOptions = MarcPaywallCoreOptions;

type HonoContext = {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
};

export function marcPaywallHono(opts: MarcPaywallHonoOptions) {
  return async (c: HonoContext, next: () => Promise<void>) => {
    const result = await marcPaywallCore({
      ...opts,
      headers: {
        "x-payment": c.req.header("x-payment"),
        "x-payment-tx": c.req.header("x-payment-tx"),
      },
    });

    if (!result.ok) {
      return c.json(result.body, result.status);
    }

    return next();
  };
}
