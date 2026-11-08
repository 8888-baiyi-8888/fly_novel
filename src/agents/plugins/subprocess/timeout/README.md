# @fly-novel/timeout

提供可释放的期限信号、带代码的超时原因和原因识别。期限只发出取消通知；消费方必须自行停止工作并等待清理。`timeoutMs <= 0` 是内部无期限约定，调用方输入须在边界另行校验。

适配用户提供的 DeepSeek Harness 官方下载快照 `packages/util/timeout/src/index.ts`，版本 `0.2.2-rc.1`，SHA-256 `cadc1aea5b85854f59ca68cee8b7d08c4ebdd378d1c8e081e0031423c262e6b1`，快照无已核验提交标识；仅保留搜索所需的期限与原因识别，许可证见 [LICENSE](LICENSE)。
