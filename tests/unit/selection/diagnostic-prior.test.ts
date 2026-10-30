// D62: the starting diagnostic only shifts the selection priority of skills that have no practice evidence yet.
import { describe, expect, it } from "vitest";
import { computePriority, diagnosticPrior } from "../../../packages/learning/src/index.js";

const unknown = computePriority({ score: null, reliable: false, nEff: null, failuresLast20: 0, daysSinceLastIndependent: null }).p;

describe("diagnostic prior", () => {
  it("raises failed skills, lowers fully correct ones, and leaves untested ones alone", () => {
    expect(diagnosticPrior(unknown, undefined)).toBe(unknown);
    expect(diagnosticPrior(unknown, { attempts: 1, failures: 0 })).toBeCloseTo(unknown - 0.1);
    expect(diagnosticPrior(unknown, { attempts: 1, failures: 1 })).toBeCloseTo(unknown + 0.15);
    expect(diagnosticPrior(unknown, { attempts: 5, failures: 5 })).toBeCloseTo(unknown + 0.3); // capped
    expect(diagnosticPrior(0.95, { attempts: 3, failures: 3 })).toBe(1);
  });
});
