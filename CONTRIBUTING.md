# 参与贡献

感谢你帮助改进 NCM Sync。

## 开发环境

- Windows 10/11 x64；
- Node.js 22.12+；
- NTFS 临时目录（硬链接相关测试需要）。

```powershell
npm.cmd ci
npm.cmd run dev
```

## 提交前检查

```powershell
npm.cmd test
npm.cmd run test:e2e
```

请保持测试使用模拟账号和临时音乐库。不得提交真实用户 ID、昵称、Cookie、个人歌单统计、音乐文件、`.cloudmusic`、`release/` 或机器专用绝对路径。

提交改动时请同时更新相关测试与文档，避免混入无关格式化。提交信息建议使用简洁的 Conventional Commits 风格，例如 `fix: prevent duplicate playlist discovery`。

## Issue 与 Pull Request

- Bug 报告请提供版本、复现步骤、预期行为和实际行为。
- 日志和截图必须先移除个人路径、用户 ID、Cookie 和歌曲版权内容。
- Pull Request 应说明用户可见变化、风险和已执行的测试。
- 安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开披露。
