declare const BRAND: unique symbol

/** 一个携带仅在编译期存在的品牌标记 B 的字符串。 */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** A number carrying a compile-time-only brand `B`. */
export type BrandedNumber<B extends string> = number & { readonly [BRAND]: B }

/**
 * Apply a compile-time number brand without changing the value.
 * @param value - number admitted by the domain that owns the target brand.
 * @returns the same number with the requested compile-time brand.
 */
export function brandNumber<T extends BrandedNumber<string>>(value: number | T): T {
  return value as T
}

/**
 * Apply a compile-time string brand without changing the value.
 * @param value - string admitted by the domain that owns the target brand.
 * @returns the same string with the requested compile-time brand.
 */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T
}