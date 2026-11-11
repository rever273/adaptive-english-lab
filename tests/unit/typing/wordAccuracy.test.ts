import { describe, expect, it } from "vitest";
import type { TypingResult } from "../../../apps/web/src/api";
import { wordAccuracy } from "../../../apps/web/src/typingWordAccuracy";

const result = (words: Array<{destroyed:boolean;errors:number|null}>, errors: number, mode: "words" | "books" = "words") => ({ mode, words, metrics: { errors } }) as TypingResult;

describe("Words result accuracy", () => {
  it("separates clean words, words with errors and unassigned wrong keys", () => {
    const words = [...Array.from({length:17},()=>({destroyed:true,errors:0})), ...Array.from({length:13},()=>({destroyed:true,errors:1}))];
    expect(wordAccuracy(result(words,16))).toMatchObject({shown:30,completed:30,clean:17,withErrors:13,unfinished:0,unknown:0,unassigned:3,accuracy:17/30*100});
  });
  it("keeps unfinished words apart and never assumes old missing error data was clean", () => {
    expect(wordAccuracy(result([{destroyed:true,errors:0},{destroyed:true,errors:null},{destroyed:false,errors:2}],2))).toMatchObject({shown:3,completed:2,clean:1,withErrors:1,unfinished:1,unknown:1,accuracy:null,unassigned:null});
    expect(wordAccuracy(result([{destroyed:false,errors:0}],0))?.accuracy).toBeNull();
    expect(wordAccuracy(result([],0,"books"))).toBeNull();
  });
});
