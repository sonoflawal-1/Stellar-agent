import type { MarcPaywallCoreOptions } from "./marcPaywallCore.js";

export type MarcPaywallNextOptions = MarcPaywallCoreOptions;
export type MarcPaywallNextHandler = (request: Request) => Response | Promise<Response>;

function paymentRequiredResponse(opts: MarcPaywallNextOptions): Response {
  return Response.json(
    {
      error: "payment_required",
      payTo: opts.payTo,
      price: opts.price,
      network: opts.network ?? "stellar:testnet",
      token: opts.token,
      description: opts.description ?? "MARC-protected API call",
    },
    { status: 402 },
  );
}

export function marcPaywallNext(
  opts: MarcPaywallNextOptions,
  handler: MarcPaywallNextHandler,
): MarcPaywallNextHandler {
  return async (request) => {
    const payment = request.headers.get("x-payment");
    if (!payment) return paymentRequiredResponse(opts);
    return handler(request);
  };
}
