# 组织模块首版 JSON 与存储契约

本文描述组织模块初始化期间的文件格式及受控存储。业务方向见[组织开发计划](world-initialization-stage-6a-organization-plan.md)和[场景走查](world-initialization-stage-6a-organization-scenarios.md)，实际入口与限制见[组织包说明](../../../src/agents/plugins/organization/README.md)。字段和文件均属于本次实现的版本 1 格式；示例用于解释，不是用户已经确认的世界设定。

## 一、文件、身份和共同规则

可信应用绑定世界、根目录、读写权限和初始化阶段。根目录下须预先存在 `organizations/`、`relations/`、`memberships/`，每个 JSON 文件名为小写 UUID 加 `.json`，与正文 ID 一致；组织、关系和成员使用各自的 ID，不按名称合并。新建使用独占写入，更新使用读取到的文件版本；用户没有要求的地方不建立文件或填满内容。

所有文件必需 `formatVersion: 1`、`worldId` 和 `id`；读取时核对可信世界及文件名。格式拒绝无效 UTF-8、非法 JSON、重复对象键、未知版本或字段；未知版本不迁移、不覆盖并保留原文件。字段中的等级为 0 至 4 的整数，保存时必须明确提供；角色过滤由独立查询视图执行，原始存储返回完整文档。初始化文件版本用于并发控制，不是世界内时间或世界演化历史。

## 二、组织文件

| 字段 | 规则 |
| --- | --- |
| `name`、`aliases` | 名称为非空字符串，别名为字符串数组；名称和别名可与其他组织重复。 |
| `organizationType` | 非空类型名称或 `null`；`null` 表示类型未确定，不预置所有世界共用的类型清单。 |
| `detailLevel` | `unexpanded`、`overview`、`detailed`，只描述本组织。 |
| `reviewStatus` | 初始化创建和更新为 `suggested`，不提供模型确认。 |
| `minLevel` | 名称、别名、身份及基本元数据所需组织权限等级。 |
| `sections` | 正文项数组，每项 `title`、`content`、`minLevel`；每项等级不得低于组织基本资料等级。 |
| `locations` | 地点线索数组，每项 `place`、`purpose`、`minLevel`；`place` 为已关联 ID 或未关联描述，等级不得低于组织基本资料等级。 |
| `reserved` | 用户明确要求留白的内容项数组，每项 `description`、`minLevel`；等级不得低于组织基本资料等级。 |

`sections`、`locations`、`reserved` 和 `aliases` 必须是数组；空数组只表示当前文档没有记录，不代表世界中不存在此类内容。自然语言正文按世界需要组织，不要求固定标题或填满所有资源、组织规则和成员。组织 ID 和地点 ID 分属不同类型；不从地点坐标或位置推断组织控制权。

```json
{
  "formatVersion": 1,
  "worldId": "cultivation-world",
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "青云宗",
  "aliases": [],
  "organizationType": "宗门",
  "detailLevel": "overview",
  "reviewStatus": "suggested",
  "minLevel": 0,
  "sections": [
    { "title": "概况", "content": "山中修行组织。", "minLevel": 0 },
    { "title": "内部线索", "content": "另有未公开事务。", "minLevel": 3 }
  ],
  "locations": [
    { "place": { "kind": "unresolved", "description": "尚未核实的山门" }, "purpose": "总部线索", "minLevel": 0 }
  ],
  "reserved": []
}
```

## 三、组织间关系文件

`fromId` 和 `toId` 为当前世界中已存在的不同组织；`label` 是非空的关系名称，`description` 为说明。`kind: 'subordination'` 表示 `fromId` 是下级、`toId` 是上级，`direction` 必须是 `one-way`；此类关系允许多个上级，但创建或覆盖后不能形成统属环。`kind: 'general'` 用于合作、竞争、联盟参与等其他关系，`direction` 明确为 `one-way` 或 `two-way`；不会仅因 `label` 推断方向、统属或反向态度。

`fromMinLevel`、`toMinLevel` 为两个组织各自对应的最低等级；角色视图同时检查关系自身等级及两端组织基本等级，字段本身不授予角色权限。两组织可以有多条不同关系；一条关系是一份 JSON，从两端展示时仍引用相同关系 ID。

```json
{
  "formatVersion": 1,
  "worldId": "cultivation-world",
  "id": "33333333-3333-4333-8333-333333333333",
  "fromId": "22222222-2222-4222-8222-222222222222",
  "toId": "11111111-1111-4111-8111-111111111111",
  "kind": "subordination",
  "label": "隶属",
  "direction": "one-way",
  "fromMinLevel": 0,
  "toMinLevel": 0,
  "description": "传功堂隶属于青云宗。"
}
```

## 四、人物成员关系文件

`organizationId` 必须是同世界已存在的组织。`person` 只能是 `{ "kind": "linked", "id": "角色UUID" }` 或 `{ "kind": "unresolved", "description": "可辨认线索" }`；未关联线索不能伪造人物 ID。`roles` 为职务字符串数组，空数组表示未记录职务；`period` 为说明字符串或 `null`，`null` 表示任期未知；`description` 为说明，`minLevel` 为相应组织的最低权限等级。是否仍任职不能从任期未知或空职务推断。

```json
{
  "formatVersion": 1,
  "worldId": "cultivation-world",
  "id": "44444444-4444-4444-8444-444444444444",
  "organizationId": "11111111-1111-4111-8111-111111111111",
  "person": { "kind": "unresolved", "description": "尚未建档的长老" },
  "roles": ["长老"],
  "period": null,
  "description": "具体人物待核实。",
  "minLevel": 3
}
```

组织与人物查询同一条关系；角色现有 `faction` 分类不会自动同步或迁移。角色视图须满足该记录与所属组织基本等级中较高的要求；原始存储读取不做权限过滤。

## 五、引用和写入

本步存储输入不接收由程序维护的身份和状态字段：

| 操作 | 内容参数 | 由存储确定 |
| --- | --- | --- |
| 新建 / 覆盖组织 | `name`、`aliases`、`organizationType`、`detailLevel`、`minLevel`、`sections`、`locations`、`reserved` | `formatVersion`、`worldId`、组织 ID 和 `reviewStatus`。 |
| 新建 / 覆盖组织间关系 | `fromId`、`toId`、`kind`、`label`、`direction`、`fromMinLevel`、`toMinLevel`、`description` | `formatVersion`、`worldId` 和关系 ID。 |
| 新建 / 覆盖成员关系 | `organizationId`、`person`、`roles`、`period`、`description`、`minLevel` | `formatVersion`、`worldId` 和成员关系 ID。 |

覆盖方法还接收要覆盖的当前记录 ID 及此前读取返回的文件版本。上述是存储方法的内容契约；组织工具由可信应用绑定世界、目录和身份，不接受路径或世界配置作为模型参数。

写入 `linked` 人物或地点时，可信应用须分别绑定 `resolvePerson` 或 `resolvePlace`，解析器返回实际 `id` 和 `worldId`；服务核验与输入及绑定世界一致。未配置解析器时返回 `ORG_REFERENCE_UNAVAILABLE`，目标不存在或返回不同世界 / ID 时返回 `ORG_INVALID_DOCUMENT`；解析器本身失败向调用方报告，不当成未找到。`unresolved` 不需要解析器。组织间关系及成员的组织端通过本存储检查真实组织文件。

写入时的外部引用核验只说明当时解析成功；读取组织或成员文件不会自动重新验证地图 / 人物是否仍存在或可访问。要向使用方声明引用当前有效，须使用规划者引用核验工具重新核验；可信应用可复用已打开的地图和人物存储装配解析器。

初始化期间分别提供创建、按 ID 读取和按版本完整覆盖组织、组织间关系及成员关系的存储方法。更新保持原 ID；文件版本不匹配或后端发生版本冲突返回 `ORG_CONFLICT`，不覆盖原文件。创建与关系更新前扫描并校验必要的组织文件和统属关系图，遇到损坏文件拒绝，不把它跳过当成空结果。公开方法与错误码以包导出及测试为准；JSON 状态、创建、覆盖或目录登记都不等于用户确认世界。

组织工具与角色过滤的具体接口、授权来源及保护边界见[组织包说明](../../../src/agents/plugins/organization/README.md)。可信应用不得将完整文件读取、未过滤的目录或其他旁路暴露给故事角色。组织专用 Agent 和世界演化历史尚未装配。
