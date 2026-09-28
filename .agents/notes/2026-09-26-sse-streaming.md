# 2026-09-26：OpenAI 兼容适配器上 SSE 流式 + write 超时重试

## 背景
第 4 章真实跑：direct/simulate/merge 全过（跨章持久化已生效——启动打印「恢复运行时状态」），
但 write 连续 3 次 `This operation was aborted`（默认 240s 超时），retry 预算耗尽挂起。
direct/simulate/merge 都是短 JSON 唯独 write 生成上千字正文——判断非流式长请求被 MaaS 网关
中途断开（网关对「长时间无响应」的连接主动切断），加大客户端超时治标不治本。

## 决策
1. **适配器默认 `stream:true`**（openai-compatible-agent.ts）：
   - 响应按 **content-type 是否含 event-stream** 判定走 SSE（`readSseContent`：逐块读取、
     按行 `data:` 取 `choices[0].delta.content` 累积、`[DONE]` 结束、坏行 catch 忽略）；
   - **必须按 content-type 判定而非 body 是否存在**——Node `new Response(JSON)` 也带 ReadableStream body，
     按 body 判定会让全部非流式测试误走 SSE；
   - 非 event-stream 响应退回 `res.json()` 路径，向后兼容。
2. **write agent 调用失败 → retry 回 write**（上一轮已改）+ 驱动默认超时 240s → 480s。

## 验证
- tsc 零诊断；全量 **fail 0**（新增 2 个 SSE 用例：纯中文 delta 累积；SSE+jsonMode 累积文本解析为 json）。
- 测试踩坑记录：SSE 行里嵌套 JSON 字符串时，`content` 值必须再 `JSON.stringify` 一层
  （否则 `"content":{...}` 变成对象而非字符串）；模板串 `${expr}}]}` 末尾的 `}` 是插值闭合符，
  括号数易少写一个——用字符串拼接构造 SSE 行更稳。

## 待真实端点验证
流式 + 480s 超时后 write 是否还 aborted，由用户重跑第 4 章确认。
若仍 aborted，则是 MaaS 服务端硬超时（与客户端无关），需考虑换模型/缩短正文预算。
