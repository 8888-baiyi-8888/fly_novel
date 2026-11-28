# 故事级工作流目录说明

## 仓库结构

- `types.ts`：规划、任务、场景设置和结果、模拟经过及版本化回报的定义与校验。
- `store.ts`：规划及协作记录的保存、读取和目录隔离，核对场景结果引用。
- `workflow.ts`：组织导演调用与故事推进，决定何时拆分、演绎、暂停和收尾。
- `story-query.ts`：只读查询故事任务、上下级归属、同层顺序和子项结果。
- `scenes.ts`：校验场景所属故事，提供设置创建及场景状态和结果查询。
- `map-scene.ts`：场景地图需求和核查记录格式。
- `character-participation.ts`：角色邀请及参与相关的业务契约。
- `scene-interaction.ts`：场景互动事件、当时条件及记录校验。
- `scene-event.ts`：已采用场景事件的身份和记录格式。
- `convoy-state.ts`：商队状态、获准操作的业务格式及有界记录读写。
- `world-progress.ts`：供导演评估使用的可信状态和场景事件引用。
- `world-schedule.ts`：世界时间、场景排期和版本化时间窗记录。
- `run-records.ts`：可信运行意图和恢复步骤的版本化记录。
- `progress.ts`：核查故事与场景进度，受理审阅决定、期限结算和依据更新，独占领取暂停位置。
- `user-review.ts`：父故事安排审阅的模式、选项、版本和决定校验。
- `simulation.ts`：执行最小子故事的模拟演绎，处理场景结果写入、提前汇报、上级决定和取消。
- `README.md`：模块职责、文件格式和使用边界。
- `tests/`：所属模块的自动化测试，`round.test.ts` 贯通曲水城整轮，`user-review.test.ts` 核对审阅与恢复，`world-schedule.test.ts` 核对排期、跨故事交接和结算。
