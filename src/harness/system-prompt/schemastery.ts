type Schema<S = any, T = S> = Schemastery<S, T>

const Schema = function (options: Schema) {
  const schema = function (data: any, options: Schemastery.Options = {}) {
    return Schema.resolve(data, schema, options)[0]
  } as Schema

  if (options.refs) {
    const refs = valueMap(options.refs, options => new Schema(options))
    const getRef = (uid: any) => refs[uid]!
    for (const key in refs) {
      const options = refs[key]!
      options.sKey = getRef(options.sKey)
      options.inner = getRef(options.inner)
      options.list = options.list && options.list.map(getRef)
      options.dict = options.dict && valueMap(options.dict, getRef)
    }
    return refs[options.uid!]
  }

  Object.assign(schema, options)
  if (typeof schema.callback === 'string') {
    try {
      // eslint-disable-next-line no-new-func
      schema.callback = new Function('return ' + schema.callback)()
    } catch {}
  }
  Object.defineProperty(schema, 'uid', { value: globalThis.__schemastery_index__++ })
  Object.setPrototypeOf(schema, Schema.prototype)
  schema.meta ||= {}
  schema.toString = schema.toString.bind(schema)
  return schema
} as Schemastery.Static