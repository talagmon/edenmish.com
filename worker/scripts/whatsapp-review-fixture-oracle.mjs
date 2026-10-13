// Test oracle ONLY for one pinned synthetic request. Never used to normalize
// customer drafts. Caller must first pass the unchanged strict evidence validator.
import {createHash} from 'node:crypto';
import {semanticDiagnostics} from './whatsapp-review-semantics.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const requestHash='0bc34140b6fde49c5efe294fddbe0fb3227a7ae9301ce7f073a8ae77ff928ff3';
const expectedHash='6739733dd2d6a696549da4fa2aa716f9d138bc9f675a4ae46bf71c906f3cd779';
const sort=rows=>JSON.stringify([...rows].sort(([a],[b])=>a.localeCompare(b)));
// Enumerated complete source strings, not a punctuation stripper, fuzzy matcher,
// label remover or general paraphrase rule. Other fields remain byte-exact.
const variants=Object.freeze({
 notes:Object.freeze(['מסמכים','מעטפה קטנה עם מסמכים']),
 pickup_detail:Object.freeze(['אצל השומר','אצל השומר.','באיסוף אצל השומר','באיסוף אצל השומר.']),
 dropoff_detail:Object.freeze(['לנועה','לנועה.']),
});
export function fixedFixtureSemantics(raw,accepted,request,now) {
 const exact=semanticDiagnostics(raw,accepted,request.expectedEntries);
 const fixtureBound=request.sha256===requestHash&&digest(JSON.stringify(request.payload))===requestHash
  &&digest(sort(request.expectedEntries))===expectedHash&&now===1791788400000
  &&JSON.stringify(request.syntheticState)===JSON.stringify({phase:'collect',data:{},revision:0,consent_at:1791788400000,multilingual:true,language:'he'});
 const values=new Map(accepted.entries),expected=new Map(request.expectedEntries);
 const complete=accepted.entries.length===9&&values.size===9&&expected.size===9
  &&exact.missingFields.length===0&&exact.unexpectedFieldCount===0;
 const equivalentFields=[];
 const equivalentEntries=fixtureBound&&complete&&request.expectedEntries.every(([field,value])=>{
  const actual=values.get(field);if(actual===value)return true;
  const allowed=variants[field];if(!allowed?.includes(actual))return false;
  // A differing text detail must itself be the validated literal source quote.
  // Inferred notes remain allowed only when already equal to the expected value.
  const quote=raw.fields.find(item=>item.field===field)?.quote;
  if(typeof quote!=='string'||quote.trim()!==actual)return false;
  equivalentFields.push(field);return true;
 });
 const {exactEntries,...metadata}=exact.checks;
 return {...exact,matched:fixtureBound&&equivalentEntries&&Object.values(metadata).every(Boolean),
  fixtureBound,equivalentEntries,equivalentFields:equivalentEntries?equivalentFields.sort():[]};
}
