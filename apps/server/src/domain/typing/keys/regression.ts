/**
 * Least-squares polynomial fit for the Key Builder speed forecast, taken from keybr.com packages/keybr-math/lib
 * ({linear,polynomial}-regression.ts, sle.ts, polynomial.ts, model.ts). The regression and SLE solver there are
 * MIT-licensed (Copyright (c) Tom Alexander <me@tomalexander.co.nz>); the rest is keybr.com, AGPL-3.0.
 */

export class Polynomial {
  readonly coef: readonly number[];
  constructor(coef: readonly number[]) {
    let n = coef.length;
    while (n > 1 && coef[n - 1] === 0) n--;
    if (n === 0) throw new Error("empty polynomial");
    this.coef = coef.slice(0, n);
  }
  eval(x: number): number {
    let y = 0;
    for (let i = this.coef.length - 1; i > 0; i--) y = (y + this.coef[i]!) * x;
    return y + this.coef[0]!;
  }
  derivative(): Polynomial {
    return this.coef.length === 1 ? new Polynomial([0]) : new Polynomial(this.coef.slice(1).map((c, i) => c * (i + 1)));
  }
}

function linearRegression(xs: readonly number[], ys: readonly number[]): Polynomial {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s1 += (xs[i]! - mx) * (ys[i]! - my);
    s2 += (xs[i]! - mx) ** 2;
  }
  return new Polynomial([my - (s1 / s2) * mx, s1 / s2]);
}

/** Gaussian elimination with partial pivoting; A is stored column-major with y as its last column, as in keybr's Sle */
function solve(A: number[][], size: number): number[] {
  for (let i = 0; i < size; i++) {
    let maxrow = i;
    for (let j = i + 1; j < size; j++) if (Math.abs(A[i]![j]!) > Math.abs(A[i]![maxrow]!)) maxrow = j;
    for (let k = i; k < size + 1; k++) {
      const tmp = A[k]![i]!;
      A[k]![i] = A[k]![maxrow]!;
      A[k]![maxrow] = tmp;
    }
    for (let j = i + 1; j < size; j++) for (let k = size; k >= i; k--) A[k]![j]! -= (A[k]![i]! * A[i]![j]!) / A[i]![i]!;
  }
  const x = new Array<number>(size);
  for (let j = size - 1; j >= 0; j--) {
    let s = 0;
    for (let k = j + 1; k < size; k++) s += A[k]![j]! * x[k]!;
    x[j] = (A[size]![j]! - s) / A[j]![j]!;
  }
  return x;
}

export function polynomialRegression(xs: readonly number[], ys: readonly number[], degree: number): Polynomial {
  if (xs.length !== ys.length || xs.length === 0) throw new Error("bad regression input");
  if (degree === 1) return linearRegression(xs, ys);
  const size = degree + 1;
  const A: number[][] = Array.from({ length: size + 1 }, () => new Array<number>(size).fill(0));
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) A[i]![j] = xs.reduce((t, x) => t + x ** (i + j), 0);
  for (let i = 0; i < size; i++) A[size]![i] = xs.reduce((t, x, l) => t + x ** i * ys[l]!, 0);
  return new Polynomial(solve(A, size));
}

/** coefficient of determination of the model on the data */
export function r2(xs: readonly number[], ys: readonly number[], model: Polynomial): number {
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssres = 0;
  let sstot = 0;
  for (let i = 0; i < xs.length; i++) {
    ssres += (ys[i]! - model.eval(xs[i]!)) ** 2;
    sstot += (ys[i]! - my) ** 2;
  }
  return 1 - ssres / sstot;
}
