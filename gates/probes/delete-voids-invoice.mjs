/**
 * G2 behavior oracle: delete-voids-invoice
 *
 * Selected by the `probe:delete-voids-invoice` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "delete-voids-invoice";

// Which fleet repo this oracle boots against (factory/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 29;

export const title = `DELETE /invoices/:id voids an open invoice; 409 paid/voided; 404 unknown`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Issue: DELETE voids an open invoice; 409 on paid/voided; 404 unknown.
        const open = await api(base, "POST", "/invoices", { customerId: "c29", amountCents: 100 });
        const del = await api(base, "DELETE", `/invoices/${open.body.id}`);
        const afterDel = await api(base, "GET", `/invoices/${open.body.id}`);
        const paid = await api(base, "POST", "/invoices", { customerId: "c29b", amountCents: 200 });
        await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
        const delPaid = await api(base, "DELETE", `/invoices/${paid.body.id}`);
        const stillPaid = await api(base, "GET", `/invoices/${paid.body.id}`);
        const missing = await api(base, "DELETE", "/invoices/999999");
        const voidOk = del.status === 200 && del.body.status === "voided" && afterDel.body.status === "voided";
        const conflictOk = delPaid.status === 409 && stillPaid.body.status === "paid";
        const notFoundOk = missing.status === 404;
        return {
          ok: voidOk && conflictOk && notFoundOk,
          detail: `DELETE open ${del.status}/${del.body.status} (want 200/voided), DELETE paid ${delPaid.status} then status=${stillPaid.body.status} (want 409/paid), unknown ${missing.status} (want 404)`,
        };
}
