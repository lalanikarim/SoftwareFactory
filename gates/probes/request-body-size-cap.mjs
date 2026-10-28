/**
 * G2 behavior oracle: request-body-size-cap
 *
 * Selected by the `probe:request-body-size-cap` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "request-body-size-cap";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 36;

export const title = `bodies over 64 KiB -> 413 while streaming; small/empty bodies unaffected`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Issue: bodies over 64 KiB → 413 while streaming; small/empty bodies unaffected.
        const big = await api(base, "POST", "/invoices", { customerId: "c36", amountCents: 100, note: "x".repeat(70_000) });
        const small = await api(base, "POST", "/invoices", { customerId: "c36-small", amountCents: 100 });
        const emptyBody = await api(base, "POST", "/invoices", undefined);
        const stillUsable = await api(base, "GET", "/health");
        const tooBigOk = big.status === 413;
        const smallOk = small.status === 201;
        const emptyOk = emptyBody.status !== 413 && emptyBody.status < 500;
        const usableOk = stillUsable.status === 200;
        return {
          ok: tooBigOk && smallOk && emptyOk && usableOk,
          detail: `70 KB body ${big.status} (want 413), small POST ${small.status} (want 201), empty body ${emptyBody.status} (want not-413/<500), connection usable after=${usableOk}`,
        };
}
