# @fly-novel/initial-situation

初始局势格式与初始化受控文件存储。业务背景及后续 Agent、查询工具规划见[详细计划](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-initial-situation-plan.md)，文件约定见[资料契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-initial-situation-contract.md)。

`SituationStore.open` 接受可信世界、现有真实负责人目录、文件后端、访问模式、初始化阶段及单可信写入进程声明；`overviews/`、`situations/` 和 `candidates/` 必须已存在。调用方负责保持后端与引用解析器有效并等待 `close()`；身份占用限于当前进程，不是跨进程锁或系统级隔离。已关联引用须由可信解析器验证，同一方案内条目关联验证目标存在。目录登记、跨模块事务、确认提交和世界演化留存不由存储提供。

首次独占创建世界起点，随后创建不同待审总览及其条目。初始化起点说明可按读取版本更新；调用方须先核查已有相对时间资料，存储不自动换算历史。未确认文件按版本更新，已确认文件通过独占候选记录修改，不提供候选提交。发生结果不确定时须检查返回路径，不能盲目重复创建。完整文档不能直接作为角色认知，角色可见性需由后续运行装配保护。
