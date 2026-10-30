import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExerciseType } from "@english-lab/contracts";
import { detectProjectRoot } from "../../../config.js";

let schemaText: string | null = null;
/** The exact exercise-v1 schema file (content/schemas, byte-identical to documentation/spec): hashed into the generation prompt version. */
export function exerciseSchemaText(): string {
  return (schemaText ??= readFileSync(path.join(detectProjectRoot(), "content", "schemas", "exercise.schema.json"), "utf8"));
}

/** JSON-schema `format` handed to the model for one inference unit: {exercises:[<exercise-v1 variant of this type>]}, at most `count` items. */
export function generationFormat(type: ExerciseType, count: number): object {
  const all = JSON.parse(exerciseSchemaText()) as { oneOf: Array<{ properties: { type: { const: string } } }> };
  const variant = all.oneOf.find((v) => v.properties.type.const === type);
  if (!variant) throw new Error(`no exercise-v1 variant for ${type}`);
  return { type: "object", additionalProperties: false, required: ["exercises"], properties: { exercises: { type: "array", minItems: 1, maxItems: count, items: variant } } };
}
