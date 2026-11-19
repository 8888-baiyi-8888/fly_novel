# @fly-novel/world-specific

世界专有主题与内容项的版本化 JSON 和初始化受控存储。业务范围及文件契约见[开发计划](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-world-specific-content-plan.md)和[资料契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-world-specific-content-contract.md)。

`SpecificStore.open` 由可信应用绑定已有真实根、世界、文件后端、访问模式与单可信写入进程声明；根下必须已有 `topics/`、`items/`、`candidates/`。调用者持有后端与外部解析器，关闭时等待已受理操作。同一进程的世界或根独占不是跨进程锁或系统级隔离。

主题与内容使用分离的 UUID 文件，内容可引用多个已存在主题；每份内容独立维护全部归属，不维护需要人工同步的条目总表。外部已关联引用由可信解析器核验，未配置或读取错误不能当作无结果。未确认资料按版本更新，已确认资料可准备独占候选并检查基线；确认提交及演化留存尚未实现。

未知版本、损坏、跨世界及无效关联拒绝；发布结果不确定时保留目标路径并先核查实际文件。目录登记与文件保存分开，Session 仅恢复对话；完整规则资料不等于故事角色的认知。
