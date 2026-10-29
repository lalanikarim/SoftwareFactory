/**
 * G2 behavior oracle: list-sort-amount
 *
 * Selected by the `probe:list-sort-amount` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Contract source (fixture issue "GET /invoices should support ?sort=amountCents&dir=asc|desc"):
 * sorting by amountCents with dir defaulting to asc; unknown sort field or dir -> 400 JSON error;
 * sorting happens BEFORE limit/offset; without `sort` the id-ascending order is unchanged.
 */
export const key = "list-sort-amount";

// Which fleet repo this oracle boots against (factory/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 45;

export const title = `GET /invoices ?sort=amountCents&dir= orders before paging; bad values -> 400`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  const ids = [];
  for (const amount of [300, 100, 200]) {
    const created = await api(base, "POST", "/invoices", { customerId: `sort-${amount}`, amountCents: amount });
    ids.push(created.body.id);
  }
  const amounts = (list) => (list ?? []).map((i) => i.amountCents);

  const desc = await api(base, "GET", "/invoices?sort=amountCents&dir=desc");
  const ascDefault = await api(base, "GET", "/invoices?sort=amountCents");
  const pagedAfterSort = await api(base, "GET", "/invoices?sort=amountCents&dir=desc&limit=2");
  const unsorted = await api(base, "GET", "/invoices");
  const badField = await api(base, "GET", "/invoices?sort=id2");
  const badDir = await api(base, "GET", "/invoices?sort=amountCents&dir=up");

  const descOk = JSON.stringify(amounts(desc.body.invoices)) === JSON.stringify([300, 200, 100]);
  const ascOk = JSON.stringify(amounts(ascDefault.body.invoices)) === JSON.stringify([100, 200, 300]);
  // The point of server-side sorting: this must be the two largest, not the first two re-sorted.
  const orderBeforePagingOk = JSON.stringify(amounts(pagedAfterSort.body.invoices)) === JSON.stringify([300, 200]);
  const unchangedOk = JSON.stringify(unsorted.body.invoices?.map((i) => i.id)) === JSON.stringify(ids);
  const rejectOk = badField.status === 400 && badDir.status === 400;

  return {
    ok: descOk && ascOk && orderBeforePagingOk && unchangedOk && rejectOk,
    detail: `dir=desc -> ${JSON.stringify(amounts(desc.body.invoices))} (want [300,200,100]), default dir -> ${JSON.stringify(amounts(ascDefault.body.invoices))} (want [100,200,300]), desc+limit=2 -> ${JSON.stringify(amounts(pagedAfterSort.body.invoices))} (want [300,200]), unsorted ids=${JSON.stringify(unsorted.body.invoices?.map((i) => i.id))} (want ${JSON.stringify(ids)}), sort=id2 ${badField.status} & dir=up ${badDir.status} (want 400/400)`,
  };
}
