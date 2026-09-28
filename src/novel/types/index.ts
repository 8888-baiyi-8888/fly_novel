/**
 * 小说领域共享数据模型（文档 §3 核心数据模型）。
 * 定义一次，小说级与章节级工作流共同引用；本模块不依赖 harness / llm / config，
 * 可独立编译与测试。
 */
export * from './identifiers.ts'
export * from './book-config.ts'
export * from './beat.ts'
export * from './fact.ts'
export * from './hook.ts'
export * from './thread.ts'
export * from './character.ts'
export * from './chapter-state.ts'
export * from './dispatch.ts'
export * from './hook-context.ts'
export * from './simulation.ts'
export * from './weave-plan.ts'
export * from './scene-sheet.ts'
export * from './runtime-delta.ts'
