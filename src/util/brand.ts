declare const BRAND: unique symbol

/** 一个携带仅在编译期存在的品牌标记 B 的字符串。 */
export type Branded<B extends string> = string & { readonly [BRAND]: B }
