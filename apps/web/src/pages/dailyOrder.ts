import type { JourneyMode } from "../api";
import { MODES } from "./Journey";

/** the day's practice order: the modes rotated by the date, so each day starts with a different one (kept apart from DailyPractice so App can use it without loading that page) */
export function dailyOrder(date:string, base:JourneyMode[]=MODES):JourneyMode[] {const n=Math.floor(Date.parse(date+"T00:00:00Z")/86400000)%base.length;return [...base.slice(n),...base.slice(0,n)];}
