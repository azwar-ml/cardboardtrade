import "server-only";
import { db, json } from "./db";

export type StockFreshness = { freshness:string; freshness_days:number; last_confirmed_at:string|null; price_confirmed_at:string|null; quantity:string|number|null; quantity_unit:string|null; availability:string|null };
export function inventoryFreshness(kind:"item"|"catalog", id:number):StockFreshness|null {
 const d=db();if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='stock_inventory_freshness'").get())return null;
 const row=d.prepare(`SELECT f.freshness,f.freshness_days,f.last_confirmed_at,w.details FROM stock_inventory_freshness f JOIN stock_watch w ON w.id=f.watch_id WHERE f.${kind==="item"?"item_id":"catalog_id"}=?`).get(id) as {freshness:string;freshness_days:number;last_confirmed_at:string|null;details:string}|undefined;
 if(!row)return null;const detail=json<Record<string,string|number|null>>(row.details,{});
 return {freshness:row.freshness,freshness_days:row.freshness_days,last_confirmed_at:row.last_confirmed_at,price_confirmed_at:typeof detail.price_confirmed_at==="string"?detail.price_confirmed_at:null,quantity:detail.quantity??null,quantity_unit:typeof detail.quantity_unit==="string"?detail.quantity_unit:null,availability:typeof detail.availability==="string"?detail.availability:null};
}

/** Shared matching/quotation guard. Unmonitored legacy records retain their existing behavior. */
export function stockRequiresConfirmation(id:number) {
 const state=inventoryFreshness("item",id);
 return state!==null&&(state.freshness!=="Fresh"||state.availability!=="Confirmed"||!state.price_confirmed_at||Date.now()-Date.parse(state.price_confirmed_at)>=state.freshness_days*86400000);
}
