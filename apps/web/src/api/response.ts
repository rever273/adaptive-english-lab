import type { ZodType } from "zod";

export const typed = <T>(): ZodType<T> => ({ parse: (x: unknown) => x as T }) as unknown as ZodType<T>;

export const anyOf = <T>() => ({ parse: (x: unknown) => x as T }) as unknown as ZodType<T>;
