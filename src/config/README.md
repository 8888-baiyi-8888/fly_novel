# 配置读取与凭据加解密

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| tests/ | 配置读取与凭据加解密测试。 |

## 配置文件

应用数据目录固定为 `E:/typescript/fly_novel/.fly-novel`，定义在 `src/config/paths.ts` 的 `APP_HOME` 中，与启动位置无关。迁移机器时需修改此常量。当前不读取环境变量。

首次使用时，在该目录中复制两份样例（已有真实配置时不要覆盖）：

| 提交到 Git 的样例 | 复制后的本地文件 | 用途 |
| --- | --- | --- |
| [settings.example.json](../../.fly-novel/settings.example.json) | `settings.json` | URL、默认模型和凭据引用。 |
| [.credentials.example.json](../../.fly-novel/.credentials.example.json) | `.credentials.json` | 加密凭据，由用户复制密文填写，不手填明文。 |

程序只读取本地文件，不读取样例。样例提交 Git；真实配置和加密密钥均被忽略。不要把真实密钥填入样例。文件缺失、格式错误、无效地址或凭据解密失败会在请求前报错。

`src/config/settings.ts` 的 `readSettings()` 一次读取两个配置文件，返回 `{ settings, credentials }`：`settings` 包含全部普通配置，`credentials` 包含 refs 下的全部原样密文。它只检查 JSON 对象结构和凭据值类型，不读取加密密钥、不解密、不写文件，也不限定模型提供商。配置不要求 version 字段。添加其他模型配置不需要新增读取函数。

`src/app/call-llm.ts` 按调用参数 `provider` 从 `settings[provider]` 取得模型设置并校验，使用时才读取加密密钥、解密对应 API Key，再用连接参数从 `src/app/llm-adapters.ts` 注册表创建适配器并注册到 `LlmRuntime`，通过运行时执行调用并在结束后注销路由；调用参数中的 `model` 可覆盖文件默认值。LLM 模块与 Harness 均不直接读取应用配置。目前没有自动保存接口，不承诺与 DeepSeek Harness 配置格式互通。

### 供应商与模型的选择

`settings.json` 的顶层键就是供应商标识，不需要在对象中再填写一个重复的 provider 字段。例如以下配置对应调用参数 `provider: "deepseek"`：

```json
{
  "deepseek": {
    "baseURL": "https://api.deepseek.com",
    "model": "你的模型ID",
    "credentialRef": "DEEPSEEK_API_KEY"
  }
}
```

调用方式为 `callConfiguredLlm({ provider: "deepseek", messages })`。model 可以在调用时覆盖；不传则采用该供应商的配置值。供应商标识区分大小写。现有 DeepSeek 配置不需要迁移，密文与加密密钥也无需修改。

新增供应商时，在 settings.json 添加对应顶层配置，并在 `src/app/llm-adapters.ts` 登记其适配器工厂；只填写配置不能自动支持新协议。目前仅注册 deepseek，未知供应商会在读取和解密前报错。DeepSeek 专有的 `thinking` 可选配置位于 `settings.deepseek` 中，值为 enabled 或 disabled，省略时使用服务端默认值。

### 开发时加密与解密

`src/config/credentials.ts` 只提供两个同步函数，不读取文件、不保存、不打印：

- `encryptSecret(明文, 加密密钥)`：返回密文字符串。
- `decryptSecret(密文, 加密密钥)`：返回明文字符串。

加密密钥参数是 32 字节密钥的 64 位十六进制字符串，由调用方提供。不再有 ref 或 directory 参数，不绑定 JSON 字段名称。文件读取属于 `settings.ts`，命令行入口调用 `readEncryptionKey()` 读取本机密钥后传入函数。

如果需要独立运行，`src/app/credentials-cli.ts` 只是这两个函数的交互入口，命令会先构建再运行：

```bash
pnpm run credentials encrypt
pnpm run credentials decrypt
```

`encrypt` 输入 API Key 时以圆点 `•` 回显，回车后仅输出密文，由用户复制到 `.credentials.json` 的 `refs.DEEPSEEK_API_KEY`。`decrypt` 提示粘贴密文，同样以圆点回显，回车后显示明文。长输入仅显示光标附近的一行圆点，不截断实际值。两种操作都不写文件，也不自动读取凭据文件。命令不再接收引用名称。Ctrl+C 取消，不支持管道输入；不要将 API Key 放入命令行参数。解密时避免录屏、共享终端和日志收集，普通模型调用不会输出明文。

手动填写的结构如下，密文占位文字必须替换为函数实际返回的完整字符串：

```json
{
  "refs": {
    "DEEPSEEK_API_KEY": "粘贴完整密文"
  }
}
```

密文使用 `gcm2` 标记，不绑定凭据名称。明文凭据需逐项加密并替换真实值、移除空项。配置文件不再区分版本，密文格式仍通过自身标记识别。

首次使用运行 `pnpm run init-encryption-key`，命令先构建再执行 `src/app/init-encryption-key.ts` 对应的入口。入口创建缺失的应用目录，将随机 32 字节密钥保存为 `APP_HOME/.encryption-key` 中的 64 位十六进制文本，末尾一个换行；文件已存在时拒绝覆盖。命令不输出密钥，也不读取或修改 `.credentials.json`。

密钥文件不提交 Git，需要安全备份。新克隆不会带有此文件；已有密文但密钥丢失时，应恢复原密钥，不能重新生成代替。迁移电脑需安全转移已有密钥。配置读取代码去掉密钥文本首尾空白，文件缺失时明确报错。加解密使用 Node 自带的 AES-256-GCM 和随机 IV，验证失败不返回明文。

这只能保护单独泄露的凭据文件；整个目录被读取仍可解密。Windows 文件访问保护依赖目录 ACL；`mode: 0o600` 不提供 Windows 权限隔离。

测试按模块放在 `src` 一级子目录内的 `tests/`，本模块测试位于 `src/config/tests/`，应用入口测试位于 `src/app/tests/`，更深的源码子目录不另设测试目录。测试使用虚构密钥和临时目录，不访问真实模型。`pnpm run build` 排除 `src/*/tests/`，测试单独编译到被 Git 忽略的 `.test-dist/`；`pnpm run typecheck` 同时检查源码和测试。

```bash
pnpm test
```
