/**
 * G2 behavior oracle: invoice-status-history
 *
 * Selected by the `probe:invoice-status-history` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "invoice-status-history";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 35;

export const title = `invoices carry history [{from,to}]; rejected transitions append nothing`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Issue: invoices carry history [{from,to}], rejected transitions append nothing.
        const inv = await api(base, "POST", "/invoices", { customerId: "c35", amountCents: 100 });
        const created = await api(base, "GET", `/invoices/${inv.body.id}`);
        const createdOk = Array.isArray(created.body.history) && created.body.history.length === 1 &&
          created.body.history[0].from === null && created.body.history[0].to === "open";
        const toPaid = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "paid" });
        const appendedOk = Array.isArray(toPaid.body.history) && JSON.stringify(toPaid.body.history.at(-1)) === JSON.stringify({ from: "open", to: "paid" });
        const beforeRejected = JSON.stringify((await api(base, "GET", `/invoices/${inv.body.id}`)).body.history);
        const rejected = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "voided" });
        const afterRejected = JSON.stringify((await api(base, "GET", `/invoices/${inv.body.id}`)).body.history);
        const cleanOk = rejected.status >= 400 && beforeRejected === afterRejected;
        return {
          ok: createdOk && appendedOk && cleanOk,
          detail: `created history ${JSON.stringify(created.body.history)} (want [{from:null,to:"open"}]), after paid last=${JSON.stringify(toPaid.body.history?.at(-1))} (want {from:"open",to:"paid"}), rejected ${rejected.status} unchanged=${cleanOk}`,
        };
}
