/**
 * G2 behavior oracle: idempotent-status-transition
 *
 * Selected by the `probe:idempotent-status-transition` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "idempotent-status-transition";

// Which fleet repo this oracle boots against (factory/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 18;

export const title = `re-applying a status is a no-op; paid->voided stays 409`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  const inv = await api(base, "POST", "/invoices", { customerId: "t-idem", amountCents: 50 });
        const sameOpen = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "open" });
        await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "paid" });
        const samePaid = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "paid" });
        const invalid = await api(base, "PUT", `/invoices/${inv.body.id}/status`, { status: "voided" });
        return {
          ok:
            sameOpen.status === 200 && sameOpen.body.status === "open" &&
            samePaid.status === 200 && samePaid.body.status === "paid" &&
            invalid.status === 409,
          detail: `open->open ${sameOpen.status} (want 200), paid->paid ${samePaid.status} (want 200), paid->voided ${invalid.status} (want 409)`,
        };
}
