import { activeRehearsal, claimRehearsalCharge, REHEARSAL_PRODUCT, REHEARSAL_SHOP } from './payment-rehearsal-capability.js';
// Three bounded requests, no retries: identity/product audit, calculate, create.
export const REHEARSAL_AUDIT = `query RehearsalAudit($id: ID!) {
 shop { id myshopifyDomain currencyCode taxesIncluded }
 product(id:$id) { id status
  variants(first:2) { nodes { id sku price taxable inventoryItem { tracked requiresShipping } } pageInfo { hasNextPage } }
  resourcePublications(first:20) { nodes { isPublished } pageInfo { hasNextPage } }
 }
}`;
const totals=`taxesIncluded totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
 totalShippingPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
 totalDiscountsSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
 totalTaxSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }`;
export const REHEARSAL_CALCULATE=`mutation RehearsalCalculate($input:DraftOrderInput!) {
 draftOrderCalculate(input:$input) { calculatedDraftOrder { ${totals} } userErrors { field message } }
}`;
export const REHEARSAL_CREATE=`mutation RehearsalCreate($input:DraftOrderInput!) {
 draftOrderCreate(input:$input) { draftOrder { id legacyResourceId invoiceUrl ${totals} } userErrors { field message } }
}`;
const fail=()=>{throw Object.assign(new Error('rehearsal_checkout_unconfirmed_no_retry'),{code:'rehearsal_checkout_unconfirmed_no_retry'});};
export function verifyRehearsalTotals(c) {
 if(!c||c.taxesIncluded!==true)fail();
 for(const [field,expected] of [['totalPriceSet',100],['totalShippingPriceSet',0],['totalDiscountsSet',0],['totalTaxSet',0]])
  for(const key of ['shopMoney','presentmentMoney']) {
   const v=c[field]?.[key];
   if(v?.currencyCode!=='ILS'||typeof v.amount!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(v.amount)||Math.round(Number(v.amount)*100)!==expected)fail();
  }
 return true;
}
export function rehearsalDraftInput(audit,r,order) {
 const p=audit?.product,shop=audit?.shop,v=p?.variants?.nodes?.[0];
 if(shop?.id!==REHEARSAL_SHOP||shop.myshopifyDomain!==r.shop||shop.currencyCode!=='ILS'||shop.taxesIncluded!==true
   ||p?.id!==REHEARSAL_PRODUCT||p.status!=='DRAFT'||p.variants?.pageInfo?.hasNextPage!==false||p.variants.nodes.length!==1
   ||v?.id!==r.variant_id||v.sku!=='EDENMISH-PAYMENT-REHEARSAL-1ILS'||v.price!=='1.00'||v.taxable!==false
   ||v.inventoryItem?.tracked!==false||v.inventoryItem.requiresShipping!==false
   ||p.resourcePublications?.pageInfo?.hasNextPage!==false||!Array.isArray(p.resourcePublications.nodes)||p.resourcePublications.nodes.some(n=>n.isPublished!==false))fail();
 return {presentmentCurrencyCode:'ILS',acceptAutomaticDiscounts:false,allowDiscountCodesInCheckout:false,discountCodes:[],taxExempt:false,
   email:r.email,tags:['edenmish-payment-rehearsal','no-real-delivery'],note:`EdenMish payment rehearsal ${r.run_id}; no physical delivery`,
   lineItems:[{variantId:v.id,quantity:1,priceOverride:{amount:'1.00',currencyCode:'ILS'},customAttributes:[
     {key:'_tracking_token',value:order.token},{key:'_edenmish_rehearsal_id',value:r.run_id}]}]};
}
export async function createRehearsalDraftOrder(env,order,price,{canProceed=async()=>true}={}) {
 if(!env.SHOPIFY_ADMIN_TOKEN) return null;
 if(!await canProceed())fail();
 const r=await claimRehearsalCharge(env,order,price); if(!r)fail();
 const deadline=Math.min(r.expires_at,Date.now()+15000);
 async function request(query,variables) {
  if(!await canProceed()||!await activeRehearsal(env,order)||Date.now()>=deadline)fail();
  const timeout=Math.min(5000,deadline-Date.now()); if(timeout<=0)fail();
  const response=await fetch(`https://${r.shop}/admin/api/2026-04/graphql.json`,{method:'POST',
   headers:{'X-Shopify-Access-Token':env.SHOPIFY_ADMIN_TOKEN,'Content-Type':'application/json'},
   body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(timeout)});
  if(!response.ok)fail();
  const reader=response.body?.getReader(); if(!reader)fail();
  let bytes=0,parts=[];
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536){await reader.cancel();fail();}parts.push(value);}
  const raw=new Uint8Array(bytes);let offset=0;for(const part of parts){raw.set(part,offset);offset+=part.byteLength;}
  const data=JSON.parse(new TextDecoder().decode(raw));
  if(data.errors?.length||!data.data)fail();
  return data.data;
 }
 const audit=await request(REHEARSAL_AUDIT,{id:REHEARSAL_PRODUCT});
 const input=rehearsalDraftInput(audit,r,order);
 const calc=(await request(REHEARSAL_CALCULATE,{input})).draftOrderCalculate;
 if(!Array.isArray(calc?.userErrors)||calc.userErrors.length)fail(); verifyRehearsalTotals(calc.calculatedDraftOrder);
 const result=(await request(REHEARSAL_CREATE,{input})).draftOrderCreate;
 if(!Array.isArray(result?.userErrors)||result.userErrors.length)fail();
 const draft=result.draftOrder,id=String(draft?.legacyResourceId||'');
 if(!/^\d+$/.test(id))fail();
 // Preserve financial reference even if the response's totals/link are rejected.
 await env.DB.prepare('UPDATE orders SET shopify_draft_order_id=? WHERE id=? AND rehearsal_run_id=? AND shopify_draft_order_id IS NULL')
  .bind(id,order.id,r.run_id).run();
 verifyRehearsalTotals(draft);
 const url=new URL(draft.invoiceUrl);
 if(url.protocol!=='https:'||url.username||url.password||!['pay.edenmish.com',r.shop].includes(url.hostname))fail();
 if(!await canProceed()||!await activeRehearsal(env,order)||Date.now()>=deadline)fail();
 return {id,invoice_url:url.toString()};
}
