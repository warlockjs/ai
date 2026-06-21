import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Hand-rolled Standard Schema factory used across workflow specs. */
export function schema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

/** Schema that accepts `{ n: number }` shapes; rejects everything else. */
export const numberSchema = schema<{ n: number }>(v => {
  if (typeof v === "object" && v !== null && typeof (v as any).n === "number") {
    return { value: { n: (v as any).n } };
  }
  return { issues: [{ message: "expected { n: number }" }] };
});

/** Schema that wraps any value through unchanged — useful for output extracts. */
export const passthrough = schema<any>(v => ({ value: v }));
