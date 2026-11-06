import { useEffect, useRef } from "react";
import * as api from "./api";
type Item = { id:string;sessionId:string;mode:"words"|"books"|"dictation";startMs:number;endMs:number };
const KEY="el_typing_activity_v1"; let sending=false;
function read(): Item[] { try { const x:unknown=JSON.parse(sessionStorage.getItem(KEY) ?? "[]"); return Array.isArray(x) ? x as Item[] : []; } catch { return []; } }
function write(x:Item[]) { try { sessionStorage.setItem(KEY,JSON.stringify(x)); } catch { /* unavailable */ } }
async function drain() { if(sending)return; sending=true; try { for (;;) { const x=read()[0]; if(!x)break; try { await api.recordTypingInterval(x); } catch(e) { if(!(e instanceof api.ApiRequestError)||e.status===0||e.status===403||e.status>=500) break; } write(read().filter(y=>y.id!==x.id)); } } finally { sending=false; } }
export function counterInterval(last:number,current:number,lastWall:number,now:number): { startMs:number; endMs:number } | null {
 const diff=Math.round(current-last), elapsed=now-lastWall;
 if (diff<=0 || diff>15000 || elapsed<=0 || elapsed>15000 || diff>elapsed+500) return null;
 const startMs=now-Math.min(diff,elapsed); return now>startMs ? {startMs,endMs:now} : null;
}
/** Snapshot the existing mode clock; lifetime totals still come from the existing counters. */
export function useTypingActivity(sessionId:string,mode:Item["mode"],counter:()=>number):void {
 const counterRef=useRef(counter); counterRef.current=counter;
 useEffect(()=>{ let last=counterRef.current(), lastWall=Date.now();
  const tick=()=>{ const now=Date.now(), current=counterRef.current();
   const interval=counterInterval(last,current,lastWall,now); if(interval){write([...read(),{id:crypto.randomUUID(),sessionId,mode,...interval}]);void drain();}
   last=current;lastWall=now; };
  const timer=window.setInterval(tick,5000); const hide=()=>{tick();for(const x of read()) void api.sendKeepalive("/api/v1/journey/typing-interval",x);}; window.addEventListener("pagehide",hide);void drain();
  return ()=>{tick();window.clearInterval(timer);window.removeEventListener("pagehide",hide);};
 },[sessionId,mode]);
}
