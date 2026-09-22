# 小说创作项目源码

自动化测试放在所属一级模块的 `tests/` 中，例如 `app/tests/`、`config/tests/`；更深的源码子目录共用所属一级模块的测试目录。存在测试时创建目录，正式构建排除测试。

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [app/](app/README.md) | 凭据加解密与密钥初始化命令行入口。 |
| [config/](config/README.md) | 固定应用数据路径、配置校验与本地凭据加密存储。 |
| [workflow/](workflow/README.md) | 工作流模块目录说明。 |
| [novel/](novel/README.md) | 小说业务模块目录说明。 |
