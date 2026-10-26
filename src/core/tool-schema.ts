import { type TUnsafe, Type } from "typebox";

/**
 * A string that is one of `values`, written as a plain JSON `enum`: some model providers
 * (Google's among them) refuse the anyOf/const shape TypeBox gives a union of literals.
 */
export function StringEnum<T extends readonly string[]>(values: T, options?: { readonly description?: string; readonly default?: T[number] }): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, ...(options?.description && { description: options.description }), ...(options?.default && { default: options.default }) });
}
