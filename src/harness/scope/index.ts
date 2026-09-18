declare const ScopedBrand: unique symbol

/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }