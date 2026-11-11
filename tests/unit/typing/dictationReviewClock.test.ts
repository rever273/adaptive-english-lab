import { expect, it } from "vitest";
import { ActiveClock } from "../../../apps/web/src/game/dictationEngine";

it("excludes sentence review and does not continue counting old typing after the pause", () => {
  const clock = new ActiveClock();
  clock.input(0); clock.tick(0,{visible:true,playing:false}); clock.tick(1000,{visible:true,playing:false});
  clock.pause(1000);
  clock.tick(5000,{visible:false,playing:true}); clock.tick(10000,{visible:false,playing:true});
  expect(clock.ms).toBe(1000);
  clock.pause(10000); clock.tick(10500,{visible:true,playing:false});
  expect(clock.ms).toBe(1000);
  clock.input(10500); clock.tick(11000,{visible:true,playing:false}); expect(clock.ms).toBe(1500);
});
