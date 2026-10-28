/**
 * G2 behavior oracle: summary-per-status-counts
 *
 * Selected by the `probe:summary-per-status-counts` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "summary-per-status-counts";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 28;

export const title = `/summary gains openCount/paidCount/voidedCount; existing fields unchanged`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Issue: /summary gains openCount/paidCount/voidedCount, existing fields unchanged.
        const empty = await api(base, "GET", "/summary");
        await api(base, "POST", "/invoices", { customerId: "c28-open", amountCents: 100 });
        const paid = await api(base, "POST", "/invoices", { customerId: "c28-paid", amountCents: 200 });
        const voided = await api(base, "POST", "/invoices", { customerId: "c28-void", amountCents: 300 });
        await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
        await api(base, "PUT", `/invoices/${voided.body.id}/status`, { status: "voided" });
        const s = await api(base, "GET", "/summary");
        const zeroOk = empty.status === 200 && ["openCount", "paidCount", "voidedCount"].every((k) => empty.body[k] === 0);
        const countsOk = s.status === 200 && s.body.openCount === 1 && s.body.paidCount === 1 && s.body.voidedCount === 1;
        const keptOk = ["invoiceCount", "totalCents", "openCents", "paidCents"].every((k) => typeof s.body[k] === "number");
        return {
          ok: zeroOk && countsOk && keptOk,
          detail: `empty counts ${JSON.stringify([empty.body.openCount, empty.body.paidCount, empty.body.voidedCount])} (want 0,0,0), after 1/1/1 got ${JSON.stringify([s.body.openCount, s.body.paidCount, s.body.voidedCount])}, totals kept=${keptOk}`,
        };
}
