# 按角色 ID 保存角色记忆

问题：角色记忆需要在重启或重建 Agent 后恢复，并允许应用读取该角色的全部已保存记录，同时保持 CharacterAgent 的公开构造参数不增加存储路径。

决定：应用注册 Agent 运行时时提供 `characterMemoryDirectory`，样例使用 `APP_HOME/memories/characters`。每个角色仅以安全的 `characterId` 定位 `<characterId>.json`，不加入小说或分支层级。CharacterAgent 在结构化响应校验成功后原子写入本轮 `scene` 对象与结构化响应对象；每轮从文件记忆重建完整历史，不保留实例内 session；`getAllMemories()` 返回全部记录。未配置目录时每轮只使用当前场景。

影响：相同角色 ID 在不同小说或分支之间共享文件，这是当前用户明确选择的首版范围。模型不获得文件工具；读取和写入由应用代码完成。文件属于 `.fly-novel`，不会提交 Git。

验证：角色 Agent 聚焦测试覆盖成功写入、按角色 ID 的文件名和新实例恢复；同时运行类型检查、构建测试与空白检查。
