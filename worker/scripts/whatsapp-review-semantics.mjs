// Value-free semantic comparison for the reviewed synthetic preflight.
// Keep the exact acceptance predicate; diagnostics cannot relax it.
// Invoke only after the existing strict proposal validator accepts a response.
export function semanticDiagnostics(raw, accepted, expectedEntries) {
  const sort=rows=>JSON.stringify([...rows].sort(([a],[b])=>a.localeCompare(b)));
  const expected=new Map(expectedEntries), actual=new Map(accepted.entries);
  const allowed=new Set(['size','notes','pickup','dropoff','schedule','dropoff_detail','name','email','pickup_detail']);
  const known=keys=>keys.filter(k=>allowed.has(k)).sort();
  const checks={versionV4:raw.version===4,replyStylePresent:!!accepted.replyStyle,
    updateIntent:accepted.intent==='update',hebrewReply:accepted.replyLanguage==='he',
    exactEntries:sort(accepted.entries)===sort(expectedEntries)};
  return {matched:Object.values(checks).every(Boolean),checks,
    missingFields:known([...expected.keys()].filter(k=>!actual.has(k))),
    valueMismatchFields:known([...expected.keys()].filter(k=>actual.has(k)&&actual.get(k)!==expected.get(k))),
    unexpectedFieldCount:accepted.entries.filter(([k])=>!expected.has(k)).length,
    duplicateFieldCount:accepted.entries.length-actual.size};
}
