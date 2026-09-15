# 大语言模型调用

本模块与 `harness/` 平级，负责模型调用接口与提供商适配。`deepseek.ts` 提供 `callDeepSeek` 和 `DeepSeekCallParameters`，通过参数接收地址、API Key、模型及消息，不依赖 app、config 或 Harness，也不读取应用配置文件。

`app/call-deepseek.ts` 负责读取配置、按需解密凭据，再调用本模块。调用返回文本或 `null`；请求失败或响应格式无效时抛出错误。

## 一级子目录

当前无一级子目录。
