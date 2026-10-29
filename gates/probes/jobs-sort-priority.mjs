/**
 * G2 behavior oracle: jobs-sort-priority  (factory-fixture-2 — the jobs queue service)
 *
 * Selected by the `probe:jobs-sort-priority` label on a fixture-2 issue; never by issue number.
 *
 * Contract source (factory-fixture-2 issue "GET /jobs should sort by priority (high first) with
 * ?sort=priority"): ordering high → normal → low, ascending id within each priority group; no
 * `sort` means today's ascending-id behavior is unchanged; `sort` composes with the existing
 * `priority` filter (filter first, then group); an unknown sort value returns 400 + JSON {error}.
 *
 * This is also the oracle that proves G2 can judge a second repo at all: fixture-2's server takes
 * its port from PORT and logs the *requested* value, so it needs the registry's portFrom="env"
 * boot (factory/repo-registry.json) rather than fixture-1's parse-the-log-port startup.
 *
 * Written from the acceptance criteria, not from any implementation. Do not weaken an assertion to
 * make a run pass — if the check and the issue disagree, the issue text is the contract.
 */
export const key = "jobs-sort-priority";
// Which fleet repo this oracle boots against (factory/repo-registry.json). Selection is by label; this is
// a guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture-2";
// Provenance only — never used to select this oracle.
export const sourceIssue = 11;

export const title = `GET /jobs?sort=priority orders high → normal → low, ascending id within group`;

const ids = (body) => (Array.isArray(body) ? body.map((j) => j.id) : undefined);

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Interleave priorities so both the group order and the within-group id order are observable,
  // and no correct answer coincides with the unsorted one.
  const created = [];
  for (const [title_, priority] of [
    ["low-first", "low"],
    ["high-a", "high"],
    ["normal-a", "normal"],
    ["high-b", "high"],
    ["low-last", "low"],
  ]) {
    const res = await api(base, "POST", "/jobs", { title: title_, priority });
    if (res.status !== 201) return { ok: false, detail: `seed POST /jobs ${title_} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}` };
    created.push(res.body);
  }
  const [lowFirst, highA, normalA, highB, lowLast] = created.map((j) => j.id);

  const plain = await api(base, "GET", "/jobs");
  const sorted = await api(base, "GET", "/jobs?sort=priority");
  const composed = await api(base, "GET", "/jobs?priority=high&sort=priority");
  const badSort = await api(base, "GET", "/jobs?sort=alphabetical");

  const plainOk = plain.status === 200 && JSON.stringify(ids(plain.body)) === JSON.stringify(created.map((j) => j.id));
  const sortedOk = sorted.status === 200 && JSON.stringify(ids(sorted.body)) === JSON.stringify([highA, highB, normalA, lowFirst, lowLast]);
  const composedOk = composed.status === 200 && JSON.stringify(ids(composed.body)) === JSON.stringify([highA, highB]);
  const badSortOk = badSort.status === 400 && typeof badSort.body?.error === "string" && badSort.body.error.length > 0;

  return {
    ok: plainOk && sortedOk && composedOk && badSortOk,
    detail: `seed ids low=${lowFirst} highA=${highA} normal=${normalA} highB=${highB} low2=${lowLast}; no-sort -> ${JSON.stringify(ids(plain.body))} (want ascending, status ${plain.status}), sort=priority -> ${JSON.stringify(ids(sorted.body))} (want [${[highA, highB, normalA, lowFirst, lowLast]}]), priority=high&sort=priority -> ${JSON.stringify(ids(composed.body))} (want [${[highA, highB]}), sort=alphabetical ${badSort.status} ${JSON.stringify(badSort.body).slice(0, 80)} (want 400 + error)`,
  };
}
