import { expect,it } from "vitest";
import { counterInterval } from "../../../apps/web/src/typingActivity";
it("uses only new active clock time and ignores resets and long gaps",()=>{
 expect(counterInterval(10000,12500,100000,105000)).toEqual({startMs:102500,endMs:105000});
 expect(counterInterval(10000,10000,100000,105000)).toBeNull();
 expect(counterInterval(10000,9000,100000,105000)).toBeNull();
 expect(counterInterval(0,20000,100000,120000)).toBeNull();
 expect(counterInterval(0,5000,100000,101000)).toBeNull();
});
