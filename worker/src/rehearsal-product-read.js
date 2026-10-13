// Fixed metadata-only query. Never accepts a shop, query, token or URL from callers.
export const PRODUCT_READ_PATH = '/api/ops/rehearsal-product-read';
const PRODUCT = 'gid://shopify/Product/15422576689469';
const SHOP = 'gid://shopify/Shop/100603396413';
const DOMAIN = 'r013gt-fc.myshopify.com';
const KEY = 'rehearsal-product-read:15422576689469:v1';
export const PRODUCT_READ_QUERY = `query ProtectedProductMetadata($id: ID!) {
 shop { id myshopifyDomain currencyCode }
 currentAppInstallation { accessScopes { handle } }
 product(id:$id) { id status
  variants(first:2) { nodes { id sku price taxable inventoryItem { tracked requiresShipping } } pageInfo { hasNextPage } }
  resourcePublications(first:20) { nodes { isPublished } pageInfo { hasNextPage } }
 }
}`;
export function productReadEnabled(env, now=Date.now()) {
 const start=Number(env.PRODUCTION_REHEARSAL_PRODUCT_READ_START),end=Number(env.PRODUCTION_REHEARSAL_PRODUCT_READ_END);
 return env.PRODUCTION_REHEARSAL_PRODUCT_READ==='on' && Number.isSafeInteger(start) && Number.isSafeInteger(end)
  && start>0 && end>start && end-start<=1800000 && start<=now && now<end;
}
export const productReadPage = `<!doctype html><meta charset="utf-8"><title>Protected product metadata</title><h1>Read Eden rehearsal product metadata</h1><p>No orders, payments or credential export. Maximum three reserved Shopify read attempts across this installation.</p><button id="read">Read product metadata once</button><pre id="result"></pre><script>document.querySelector('#read').onclick=async()=>{document.querySelector('#read').disabled=true;try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"product_id":"15422576689469"}'});document.querySelector('#result').textContent=JSON.stringify(await r.json(),null,2)}catch{document.querySelector('#result').textContent='Read unconfirmed; no automatic retry.'}};</script>`;
export async function readProtectedProduct(env) {
 if(!productReadEnabled(env)||!env.SHOPIFY_ADMIN_TOKEN)return {status:503,body:{error:'product_read_disabled'}};
 let claim;
 try {
  // Never-reset durable cap; ordinary retention cannot remove the locked audit row.
  claim=await env.DB.prepare(`INSERT INTO rate_limits(key,count,window_start,last_at,locked_until) VALUES(?,1,?,?,9007199254740991)
   ON CONFLICT(key) DO UPDATE SET count=count+1,last_at=excluded.last_at
   WHERE count>=1 AND count<3 AND locked_until=9007199254740991 RETURNING count`).bind(KEY,Date.now(),Date.now()).first();
 } catch {return {status:503,body:{error:'product_read_authority_unconfirmed'}};}
 if(!claim)return {status:429,body:{error:'product_read_limit'}};
 if(!productReadEnabled(env))return {status:503,body:{error:'product_read_expired',attempt:claim.count}};
 try {
  const response=await fetch(`https://${DOMAIN}/admin/api/2026-04/graphql.json`,{method:'POST',redirect:'error',
   headers:{'X-Shopify-Access-Token':env.SHOPIFY_ADMIN_TOKEN,'Content-Type':'application/json'},
   body:JSON.stringify({query:PRODUCT_READ_QUERY,variables:{id:PRODUCT}}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error();
  const reader=response.body?.getReader();if(!reader)throw new Error();let size=0,parts=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new Error();}parts.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}
  const raw=JSON.parse(new TextDecoder().decode(bytes));const d=raw.data;
  if(raw.errors?.length||d?.shop?.id!==SHOP||d.shop.myshopifyDomain!==DOMAIN||d?.product?.id!==PRODUCT)throw new Error();
  const scopes=d.currentAppInstallation?.accessScopes?.map(s=>s.handle);
  const p=d.product,variants=p.variants?.nodes;
  if(!Array.isArray(scopes)||scopes.some(s=>typeof s!=='string'||!/^\w{1,100}$/.test(s))||!Array.isArray(variants)||variants.length>2
   ||!Array.isArray(p.resourcePublications?.nodes)||p.resourcePublications.nodes.length>20)throw new Error();
  // Explicit allowlist; never forward a raw API response/error or credential.
  const body={attempt:claim.count,shop_id:SHOP,shop:DOMAIN,currency:d.shop.currencyCode,scopes,
   product_id:PRODUCT,status:p.status,variants:variants.map(v=>({id:v.id,sku:v.sku,price:v.price,taxable:v.taxable,tracked:v.inventoryItem?.tracked,requires_shipping:v.inventoryItem?.requiresShipping})),
   variants_more:p.variants.pageInfo?.hasNextPage,publications_more:p.resourcePublications.pageInfo?.hasNextPage,
   published_count:p.resourcePublications.nodes.filter(n=>n.isPublished===true).length};
  return {status:200,body};
 }catch{return {status:503,body:{error:'product_read_unconfirmed_no_retry',attempt:claim.count}};}
}
