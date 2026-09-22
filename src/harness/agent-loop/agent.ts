import type {Phase,StepEndReason,PreparedStep} from './types.ts'
import {Agent,InboxTarget,AgentStatus} from '../agent'
import {Context} from '@deepseek-ai/cordis'
import { Session, SessionId } from '../session/index.ts'
import { AgentOptions } from '../agent/runtime-types.ts'
import { agentEvents,AgentEventDispatch} from '../agent/dispatch.ts'
import type { AgentCancelCause, TurnEndReason } from '../session/index.ts'
import { createScope,Scope } from '../scope/index.ts'
import {LlmError, Message,errorChain} from '@fly-novel/llm'
import type {UserMessage} from '@fly-novel/llm'

import { ReactLoopInbox } from './inbox.ts'

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
	// private readonly runtimeContext: RuntimeContextProjection  // 运行时上下文处理器，将组装出的上下文转换为回会话中可记录、可供模型使用的内容
	private assistantStreamRevision = 0  // 当前接入会话的 Assistant 流事件修订号，用于标识事件更新；尽在本进程内有效
	private assistantAttemptCounter = 0  // 当前 Agent 实例的模型回答尝试计数器，每次新建回答尝试时递增
	// private readonly systemPrompt: SystemPromptProjection  // 系统提示词处理器，根据当前提示词及模型能力，生成需要记录到会话中的系统消息变更
	private readonly frozenMessages = new WeakSet<Message>()  // 记录此循环已完全冻结的消息对象，避免重复冻结；弱引用不会阻止旧消息被垃圾回收

	/**
	 * 创建与指定会话绑定的Agent允许实例，并初始化作用域、输入队列和上下文投影。
	 * @param loopCtx Agent所属运行环境的Context，用于访问服务、派发事件和创建作用域
	 * @param id 当前Agent实例的标识
	 * @param options 当前Agent的运行选项
	 * @param session 当前Agent使用的会话，包含已有事件历史及消息状态
	 */
	constructor(
		private loopCtx: Context,
		public readonly id: SessionId,
		public readonly options: AgentOptions,
		public readonly session: Session
	) {
		this.requestSurfaceGeneration = session.surface.contentGeneration  // 记录初始化时的消息内容版本，作为后续判断内容是否变化的基准。
		this.dispatch = agentEvents(loopCtx, this)  //创建绑定到当前Agent的事件派发接口
		this.scope = createScope(loopCtx, this)
		this.ctx = this.scope.ctx
		// todo：待完善功能
		// this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch)
		// const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
		const lastTurn = 0
		this.phase = {kind: 'idle',lastTurn}
		// this.runtimeContext = new 

	}

	/** 
	 * 获取Agent当前对外暴露的运行状态 
	 * 内部 `phase` 可能包含多种执行阶段，但对外统一映射为：
	 * - `idle`：当前处于空闲（idle）或维护（maintenance）阶段。
	 * - `running`：当前正在执行 Agent Driver。
	 *
	 * @returns Agent 当前的对外状态：`idle` 或 `running`。
	 */
  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

	/**
	 * 更新Agent当前的内部执行阶段（Phase）
	 * 并在对外状态发送变化时发布'agent/status'状态变更事件。
	 * @param next 要切换的新执行阶段。
	 */
	private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

	private throwError(error:unknown): never{
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
	}

	/**
	 * 调用模型前，取出待处理消息、准备上下文，并让插件决定是否执行这一步。
	 * @param tartget 本次步骤的输入领取目标：
	 *  - next-turn 用于新轮次首步，领取一条下一轮消息及全部下一步消息
	 *  - next-step 用于当前轮次后续步骤，仅领取全部下一步消息
	 * @param position 这一步所属的轮次编号和步骤编号
	 * @returns 是否允许执行；允许时，同时返回准备好的消息和提示词组装结果
	 */
	private async preStep(tartget: InboxTarget, position:{turn:number;step:number}): Promise<PreparedStep>{
		// Agent必须已经进入允许状态，才能准备下一步。
		if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)

		// 获取当前任务的取消信号，用来检查用户是否已经停止任务。
		const signal = this.phase.abort.signal

		const claimed = this.inbox.claim(tartget,position.turn)

		// 收集当前 Agent 需要的提示词、工具定义等内容
		const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))

    
	}

	/**
	 * 执行一个轮次，包括步骤准备、模型请求、工具执行和轮次收尾。一个轮次可以包含多个步骤：领取首步输入前先记录轮次开始。
	 * 
	 * @returns 正常结束后仍有待处理输入时返回 true，通知驱动继续下一轮；
	 * 无待处理输入、步骤被拒绝或首步输入为空时返回 false。
	 * @throws 执行失败或收到取消信号时抛出，由外层驱动收尾。
	 */
	private async turn(): Promise<boolean>{
		// 轮次只能由已进入 running 状态的驱动执行
		if (this.phase.kind !== 'running') {
			this.throwError(
				new Error(`agent "${this.id}": turn without driver reservation`)
			)
		}

		const phase = this.phase
		const {signal} = phase.abort
		signal.throwIfAborted()		// 已取消时不再开启新轮次

		const turn = phase.turn + 1

		// 先记录轮次开始：记录成功后才更新内存中的当前轮次编号
		try {
			this.session.append('turn/start',{turn})
		} catch (error: unknown) {
			this.throwError(error)
		}
		phase.turn = turn

		// null 表示尚未得到轮次结束原因，仍需继续执行步骤
		let turnEnds: TurnEndReason | null = null
		let target: InboxTarget = 'next-turn'
		
		try {
			while (true) {
				signal.throwIfAborted()
				const step = phase.step + 1
				// 领取输入、组装上下文，并通过 pre-step 扩展点决定是否进入步骤
				const decision = await this.preStep(target,{turn,step})
				if (decision.kink = 'reject') {  // 步骤被拒绝时，将本轮标记为blocked，并停止驱动继续开轮
					turnEnds = {kind:'blocked'}
					return false
				}
				if (turnEnds && decision.messages.length === 0) break  // 前一步已经给出结束原因，且准备后没有新增输入，不再调用模型
				if (phase.step === 0 && decision.messages.length === 0) {  
					turnEnds = {kind: 'completed'}
					return false
				}

				signal.throwIfAborted()
				
				// 正式进入步骤内容
				this.session.append('step/start',{turn,step})
				phase.step = step

				try {
					// 执行模型请求及其工具调用
					const stepEnd = await this.step(decision) // 返回null表示还需继续；否则返回本轮的候选结束原因

					// 一旦轮次中出现 max-tokens，后续步骤不能覆盖这一结束原因
					if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
				} finally {
					this.session.append('step/end',{turn,step})
				}
				signal.throwIfAborted()

				// 监听器可以在这里补充next-step输入，使本轮继续
				if (turnEnds && this.inbox.nextStep.length === 0) {
					await this.dispatch.serial('agent/turn-stopping',{turn,signal})
					signal.throwIfAborted()
				}
				if (turnEnds && this.inbox.nextStep.length === 0) break
				
				target = 'next-step'
			} 
		} catch (error: unknown) {
			// 取消使用独立的结束原因，随后将异常交给外层驱动处理
			if (signal.aborted) {
				turnEnds = {kind:'aborted',reason:signal.reason as AgentCancelCause}
				throw error
			}

			turnEnds = {
				kind: 'error',
				error: error instanceof LlmError
					? error.failure
					: {message:errorChain(error),code:'UNKNOWN'},
			}
			this.throwError(error)
		} finally {
			// 正常退出、提前return、失败或取消，都尝试记录轮次结束
			try {
				this.session.append('turn/end',{turn,reason:turnEnds!})
			} catch (error:unknown){
				this.throwError(error)
			}
		}
		if (!this.inbox.hasPending) return false
		phase.abort = new AbortController()
		phase.wakeRequested = false
		phase.step = 0
		return true
	}

	/**
	 * 驱动 Agent 连续执行轮次，并在结束后恢复空闲状态。执行期间延后的唤醒请求，会在当前驱动结束后按需重新启动。
	 * @returns 当前驱动执行及状态收尾完成时兑现的 Promise。
	 */
	private async kick(): Promise<void> {
		try{
			// 每次执行一轮：返回true时继续下一轮，返回false时退出
			while (await this.turn()) {}
		} catch (_error) {
			// 报告的故障与取消操作均被限定在驱动程序边界内处理
		} finally {
			if (this.phase.kind == 'running') {
				const {turn,wakeRequested} = this.phase		// 保留最后的轮次编号，以及执行期间是否有延后处理的唤醒请求
				this.setPhase({kind:'idle',lastTurn:turn})  // 恢复空闲状态，保留轮次编号，供下次运行继续计数
				if (wakeRequested && this.inbox.hasPending) this.wakeDriver()  // 收到延后唤醒请求，且收件箱仍有待处理输入时：重新启动驱动
			}
		}
	}
	/**
	 * 唤醒 Agent Driver，启动或安排Agent的执行流程。
	 * @param wakeAfterAbort 是否是在当前活动已经中止后收到的唤醒请求
	 *  - `true`：当前活动已经中止，需要记录唤醒请求，等待当前活动结束后重新启动
	 *  - `false`：普通唤醒请求，默认值。
	 * @returns 无返回值
	 */
	private wakeDriver(wakeAfterAbort = false): void {

		// agent非空闲状态下，记录相关信息，不启动Drive，直接返回
		if (this.phase.kind !== 'idle') {
				const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined // 记录中止原因，
				if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
						this.phase.wakeRequested = true  // 当前活动结束后，是否需要被启动
				}
				return
		}

		
		const driver = Promise.withResolvers<void>()  // 用于追踪这次 Driver 的执行生命周期
		this.activityDone = driver.promise		//  保存，方便其他地方查询
		//将Agent从idle切换为running，并初始化运行状态
		this.setPhase({
		kind: 'running',
		abort: new AbortController(),
		turn: this.phase.lastTurn,
		step: 0,
		wakeRequested: false,
		})
		// 启动Agent Driver
		this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
	}

	/**
	 * 将用户消息发送到指定的 Inbox 队列，并根据需要唤醒 Agent 执行。
	 * 
	 * 如果消息需要唤醒 Agent，但当前执行任务已经被中止（aborted），
	 * 则该消息不能再加入当前执行流程，会被重新归类到`next-turn`，
	 * 作为下一轮（Turn）的输入处理
	 * @param message 用户消息
	 * @param target 消息的目标队列，决定消息在哪个执行边界被处理。可选值看{@link InboxTarget}
	 * @param wakeup 是否主动唤醒 Agent：true，消息入队后尝试唤醒；false，仅将消息入队。
	 * @returns 无返回值
	 */
	send(message: UserMessage, target: InboxTarget,wakeup: boolean): void{
		// 特定情况强制转为`next-turn`：需要唤醒Agent+agent非空闲+任务被终止
		const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
		const resolvedTarget = wakingAfterAbort ? 'next-turn' : target

		// 将消息追加到对应的 Inbox 队列末尾
		this.inbox.splice(resolvedTarget, Infinity,0,[message])

		// 根据wakeup参数决定是否主动唤醒 Agent Driver
		if (wakeup) this.wakeDriver(wakingAfterAbort)
	}

	/** 将用户消息加入下一轮（turn）队列，并唤醒Agent执行 */
	followup(input: UserMessage): void {

	}

	/** 将用户消息加入当前轮的下一步骤（step）队列，并唤醒Agent执行 */
	steer(input: UserMessage): void {

	}

	/** 将用户消息加入当前轮的下一步骤（step）队列，但不主动唤醒Agent执行 */
	inject(input: UserMessage): void {

	}
}