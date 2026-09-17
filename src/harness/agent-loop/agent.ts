import type {Phase,StepEndReason,PreparedStep} from './types.ts'
import {Agent} from '../agent'

/**驱动一个会话（Session）跨越多个轮次（Turn）和步骤（Step）边界运行。 */
export class ReactLoopAgent implements Agent {
    readonly inbox: ReactLoopInbox  // Agent 的收件箱，管理等待处理的用户消息和注入的上下文
    private phase: Phase  // 当前运行阶段：空闲（idle）、维护（maintenance）或运行中（running），以及该阶段的相关状态
    private activityDone: Promise<void> = Promise.resolve()  // 当前活动结束时完成的Promise；初始为已经完成状态，用于等待 Agent 停止当前活动
    readonly scope: Scope  // 此 Agent 专属的注册作用域；生命周期管理者会在驱动器退出厚撤销其中的注册
    readonly ctx: Context  // 此 Agent 专属的上下文，用于访问服务，并注册仅对当前 Agent 生效的能力和事件监听器
    private readonly dispatch: AgentEventDispatch  // Agent事件分发器，在构造函数中创建一次，避免高频发发时重复分配对象
    private requestHeaderLogged = false  // 当前循环实例是否已记录首次启动或恢复时的请求头
    private requestSurfaceGeneration: number  // 接入会话时或上一次构建请求时的会话消息内容版本号，用于检测消息内容是否发生变化
    private readonly runtimeContext: RuntimeContextProjection  // 运行时上下文处理器，将组装出的上下文转换为回会话中可记录、可供模型使用的内容
    private assistantStreamRevision = 0  // 当前接入会话的 Assistant 流事件修订号，用于标识事件更新；尽在本进程内有效
    private assistantAttemptCounter = 0  // 当前 Agent 实例的模型回答尝试计数器，每次新建回答尝试时递增
    private readonly systemPrompt: SystemPromptProjection  // 系统提示词处理器，根据当前提示词及模型能力，生成需要记录到会话中的系统消息变更
    private readonly frozenMessages = new WeakSet<Message>()  // 记录此循环已完全冻结的消息对象，避免重复冻结；弱引用不会阻止旧消息被垃圾回收
}