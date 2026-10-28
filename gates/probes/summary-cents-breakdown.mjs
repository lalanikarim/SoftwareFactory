/**
 * G2 behavior oracle: summary-cents-breakdown
 *
 * Selected by the `probe:summary-cents-breakdown` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "summary-cents-breakdown";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 17;

export const title = `/summary splits totals into openCents/paidCents with voided excluded`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  const before = await api(base, "GET", "/summary");
        await api(base, "POST", "/invoices", { customerId: "s-open", amountCents: 100 });
        const paid = await api(base, "POST", "/invoices", { customerId: "s-paid", amountCents: 200 });
        const voided = await api(base, "POST", "/invoices", { customerId: "s-void", amountCents: 999 });
        await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
        await api(base, "PUT", `/invoices/${voided.body.id}/status`, { status: "voided" });
        const after = await api(base, "GET", "/summary");
        return {
          ok:
            after.body.invoiceCount === before.body.invoiceCount + 2 &&
            after.body.totalCents === before.body.totalCents + 300 &&
            after.body.openCents === before.body.openCents + 100 &&
            after.body.paidCents === before.body.paidCents + 200 &&
            after.body.openCents + after.body.paidCents === after.body.totalCents,
          detail: `count ${before.body.invoiceCount}->${after.body.invoiceCount} (want +2), open ${before.body.openCents}->${after.body.openCents} (want +100), paid ${before.body.paidCents}->${after.body.paidCents} (want +200)`,
        };
}
