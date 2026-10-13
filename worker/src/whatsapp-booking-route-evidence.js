// Role checks use source positions, never the model's proposed field name.
function roleBefore(before) {
  const pickup=/(?:^|[\s,;:])(?:pickup|collect|enlèvement|enlevement|ramassage|забор|забрать|استلام|الاستلام|האיסוף|איסוף|לאסוף)\s*(?::\s*|(?:from|to|de|depuis|vers|à|из|от|в|до|من|إلى|الى)\s+|[מל])?$/iu.test(before);
  const dropoff=/(?:^|[\s,;:])(?:dropoff|delivery|deliver|livraison|livrer|доставка|доставить|تسليم|التسليم|המסירה|מסירה|למסור|יעד)\s*(?::\s*|(?:from|to|de|depuis|vers|à|из|от|в|до|من|إلى|الى)\s+|[מל])?$/iu.test(before);
  if(pickup||dropoff) return pickup&&dropoff?'ambiguous':pickup?'pickup':'dropoff';
  if(/(?:^|[\s,;:])(?:מ|(?:from|de|depuis|из|от|من)\s+)$/iu.test(before))return 'pickup';
  if(/(?:^|[\s,;:])(?:ל|(?:to|אל|vers|à|в|до|إلى|الى)\s+)$/iu.test(before))return 'dropoff';
  return null;
}
function quotedMarker(source) {
  // A quote may include its literal route marker. Require a complete-looking
  // address, not an arbitrary word starting with מ/ל. Canonical address parsing
  // and authoritative geocoding still follow; this never corrects a street.
  const match=/^(from\s+|to\s+|מ(?=[א-ת])|ל(?=[א-ת]))(.{2,100}?\s+\d{1,5}[א-תa-z]?(?:\s*,\s*|\s+).{2,100})$/iu.exec(source.value);
  return match?{marker:match[1],value:match[2],role:/^(?:from|מ)/iu.test(match[1])?'pickup':'dropoff'}:null;
}
export function validateRouteEvidence(text,sources) {
  const routes=sources.filter(s=>['pickup','dropoff'].includes(s.field)).map(source=>({source,role:roleBefore(text.slice(0,source.start)),offset:0}));
  // Explicit labels win: 'איסוף: משה שרת...' keeps the actual street's מ.
  // Prefix-inclusive pickup needs a shipment lead-in, or a separate English
  // marker. Bare Hebrew street-name pairs remain ambiguous, never stripped.
  for(const route of routes) {
    if(route.role)continue;
    const marker=quotedMarker(route.source);if(!marker)continue;
    const before=text.slice(0,route.source.start);
    const boundary=!/[\p{L}\p{M}\p{N}_]$/u.test(before);
    const correction = /\s(?:אלא|instead|but)\s*$/iu.test(before);
    const correctionPickup = correction && /(?:^|[\s,;:])(?:האיסוף|איסוף|pickup)(?=$|[\s,:])/iu.test(before)
      && !/(?:^|[\s,;:])(?:המסירה|מסירה|dropoff|delivery)(?=$|[\s,:])/iu.test(before);
    const correctionDropoff = correction && /(?:^|[\s,;:])(?:המסירה|מסירה|dropoff|delivery)(?=$|[\s,:])/iu.test(before)
      && !/(?:^|[\s,;:])(?:האיסוף|איסוף|pickup)(?=$|[\s,:])/iu.test(before);
    const correctionRole = correctionPickup?'pickup':correctionDropoff?'dropoff':null;
    const lead=/(?:^|\s)(?:לשלוח|משלוח|לאסוף|איסוף)\s+(?:[\p{L} '״׳-]+\s*)?$/u.test(before)
      && !/(?:^|\s)(?:לא|או)(?:\s|$)/u.test(before);
    if(boundary && (/^(?:from|to)\s/iu.test(marker.marker)||marker.role==='pickup'&&lead||marker.role===correctionRole)) {
      route.role=marker.role;route.offset=marker.marker.length;
    }
  }
  // The quoted ל of the destination can be interpreted only directly after an
  // independently established pickup span. No field-name-based role inference.
  for(const route of routes) {
    if(route.role)continue;
    const marker=quotedMarker(route.source);if(marker?.marker!=='ל')continue;
    const pickup=routes.find(r=>r.role==='pickup'&&r.source.end<route.source.start
      && /^\s+$/.test(text.slice(r.source.end,route.source.start)));
    if(pickup){route.role='dropoff';route.offset=1;}
  }
  const normalized=[];
  for(const {source,role,offset} of routes) {
    const before=text.slice(0,source.start+offset);
    const clause=before.split(/(?:[;.!?\n]|\s(?:אלא|אבל|instead|but)\s)/iu).at(-1);
    const after=text.slice(source.end);
    if(/(?:^|\s)(?:לא|not|don't|do not|не|без|ليس|ليست|لا|pas|sans)\s+(?:(?:לאסוף|למסור|איסוף|מסירה|collect|deliver|pick up|from|to)\s+)*[מל]?$/iu.test(clause)) return {reason:'quote_negated'};
    if(/(?:^|\s)(?:או|or|ou|или|أو|او)\s+(?:(?:from|to|de|depuis|vers|à|из|от|в|до|من|إلى|الى)\s+|[מל])?$/iu.test(clause)
      || /^[\s,]+(?:או|or|ou|или|أو|او)(?:\s|$)/iu.test(after)) return {reason:'route_ambiguous'};
    if(role==='ambiguous')return {reason:'route_ambiguous'};
    if(role&&role!==source.field)return {reason:'route_role'};
    if(routes.length>1&&!role)return {reason:'route_unmarked'};
    normalized.push([source.field,source.value.slice(offset)]);
  }
  return {reason:null,normalized};
}
export const routeEvidenceReason=(text,sources)=>validateRouteEvidence(text,sources).reason;
