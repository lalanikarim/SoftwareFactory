/**
 * G2 behavior oracle: customer-filter
 *
 * Selected by the `probe:customer-filter` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "customer-filter";

// Which fleet repo this oracle boots against (factory/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 16;

export const title = `GET /invoices?customer= filters by customerId and composes with ?status=`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  const a = await api(base, "POST", "/invoices", { customerId: "f-c1", amountCents: 10 });
        const b = await api(base, "POST", "/invoices", { customerId: "f-c2", amountCents: 20 });
        const c = await api(base, "POST", "/invoices", { customerId: "f-c1", amountCents: 30 });
        const onlyC1 = await api(base, "GET", "/invoices?customer=f-c1");
        const miss = await api(base, "GET", "/invoices?customer=no-such-customer");
        const composed = await api(base, "GET", "/invoices?customer=f-c2&status=open");
        const all = await api(base, "GET", "/invoices");
        const c1Ok = onlyC1.status === 200 &&
          onlyC1.body.invoices.length === 2 &&
          onlyC1.body.invoices.every((i) => i.customerId === "f-c1") &&
          onlyC1.body.invoices[0].id < onlyC1.body.invoices[1].id;
        const missOk = miss.status === 200 && miss.body.invoices.length === 0;
        const composedOk = composed.status === 200 && composed.body.invoices.length === 1 && composed.body.invoices[0].id === b.body.id;
        const allOk = all.status === 200 && [a.body.id, b.body.id, c.body.id].every((id) => all.body.invoices.some((i) => i.id === id));
        return {
          ok: c1Ok && missOk && composedOk && allOk,
          detail: `?customer=f-c1 ok=${c1Ok}, miss ok=${missOk}, composed ok=${composedOk}, unfiltered ok=${allOk}`,
        };
}
