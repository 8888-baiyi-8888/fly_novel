# 会话状态与事件日志

本模块维护仅追加的会话事件日志，并从日志派生模型可见的消息视图。事件名称、字段名、枚举值和格式版本属于协议，不随中文文案调整而变化。

## 文件职责与阅读顺序

| 文件 | 职责 |
| --- | --- |
| [index.ts](index.ts) | 公共入口，导出会话类型、Session、消息视图查询及请求头工具。 |
| [types/index.ts](types/index.ts) | 事件映射、事件信封和消息视图操作类型；汇总导出其他类型。 |
| [types/identifiers.ts](types/identifiers.ts) | 会话标识、事件序号、日志偏移及其构造函数。 |
| [types/headers.ts](types/headers.ts) | 会话头、请求头、路由元数据和恢复状态类型。 |
| [session.ts](session.ts) | 完整的 Session 类，负责历史接收、事件追加和派生结果缓存。 |
| [validation/header.ts](validation/header.ts) | 会话创建头快照、恢复头校验与冻结。 |
| [validation/event.ts](validation/event.ts) | 导入历史的事件信封、消息和模型请求字段校验。 |
| [validation/event-data.ts](validation/event-data.ts) | 请求头及工具结果的载荷关系校验。 |
| [session-observers.ts](session-observers.ts) | 内部存储关联、观察者快照和异常隔离。 |
| [request-header.ts](request-header.ts) | 请求头规范化、比较与日志折叠。 |
| [surface/index.ts](surface/index.ts) | 增量消息视图管理及原有视图接口的统一导出。 |
| [surface/types.ts](surface/types.ts) | 投影上下文、视图接口和折叠结果类型。 |
| [surface/message.ts](surface/message.ts) | 消息事件判断与单事件消息派生。 |
| [surface/metadata.ts](surface/metadata.ts) | 消息视图操作及源事件引用校验。 |
| [surface/fold.ts](surface/fold.ts) | 替换规则、状态转换规划与提交、完整日志折叠。 |
| [types/known-events.ts](types/known-events.ts) | 沿用的已知事件集合及需要插件投影的事件集合。 |

`types/index.ts` 定义事件映射并汇总类型，`surface/index.ts` 负责增量视图管理并汇总消息视图接口。模块外的调用方通过顶层 `index.ts` 使用会话自身的公共能力。

## 公共入口

顶层入口导出事件协议类型与标识构造函数、`Session`、消息视图与投影类型、消息事件判断函数、`deriveEventMessage`、`foldSurface`，以及请求头工具 `canonicalHeader`、`headerEquals`、`foldRequestHeader`。

```ts
import { Session, SessionId } from './index.ts'
import type { SessionSurface } from './index.ts'

const session = Session.create(SessionId('example'))
const surface: SessionSurface = session.surface
```

`SurfaceManager`、内部校验函数、观察者关联和折叠状态转换不通过顶层入口导出。LLM 消息类型和其他模块的接口由各自所属模块提供。

## 状态与校验边界

会话创建头先复制、校验并冻结；恢复流程按约定提供独立持有或可共享的历史值。事件数据和消息视图元数据保持原有校验规则。消息视图先规划候选事件的状态转换，在日志接纳该事件后提交；完整重放与增量处理共用状态转换实现。

存储关联由弱引用映射保存，观察者通知分别隔离同步异常和异步拒绝。此次整理不改变资源归属、通知顺序或释放逻辑。

## 一级子目录

| 子目录 | 职责 |
| --- | --- |
| [types/](types/index.ts) | 会话标识、头部、事件协议及已知事件集合。 |
| [validation/](validation/event.ts) | 会话头、事件信封与事件载荷的边界校验。 |
| [surface/](surface/index.ts) | 消息视图契约、派生、元数据校验与状态转换。 |

消息视图元数据校验与视图替换规则一起维护在 `surface/`，不拆到通用边界校验目录。顶层保留会话类、观察者通知、请求头折叠与公共入口。
