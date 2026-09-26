import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

export type MarcPaywallHonoOptions = MarcPaywallCoreOptions;

type HonoContext = {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
};

export function marcPaywallHono(opts: MarcPaywallHonoOptions) {
  return async (c: HonoContext, next: () => Promise<void>) => {
    if (!c.req.header("x-payment")) {
      return c.json(
        {
          error: "payment_required",
          payTo: opts.payTo,
          price: opts.price,
          network: opts.network ?? "stellar:testnet",
          token: opts.token,
          description: opts.description ?? "MARC-protected API call",
        },
        402,
      );
    }
    return next();
  };
}
