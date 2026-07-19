<p align="center">
  <img src="assets/ncmsync-logo-256.png" width="112" alt="NCM Sync Logo" />
</p>

<h1 align="center">NCM Sync</h1>

<p align="center">将网易云音乐在线歌单可靠地增量同步到 Windows 本地音乐库。</p>

<p align="center">
  <a href="../../releases/latest">下载最新版</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="PRIVACY.md">隐私说明</a> ·
  <a href="SECURITY.md">安全策略</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

![NCM Sync 主界面](docs/images/ncm-sync-overview.png)

## 为什么使用 NCM Sync

NCM Sync 面向需要把网易云音乐歌单整理为本地文件夹的用户，尤其适合 VirtualDJ、Rekordbox 等依赖本地音乐库的工作流。

- 分页读取创建和收藏的公开歌单，并完整处理数千首歌曲的超大歌单。
- 增量扫描新增、减少、离线和重命名，仅下载真正缺少的歌曲。
- 支持一键同步、独立歌单同步、自动扫描和实时同步。
- 所有同步来源统一显示任务提示、逐歌单进度、暂停、继续和取消操作。
- 默认使用 4 路受控并发下载，并在失败后安全暂停。
- 歌曲实体集中保存在 `songs/`，歌单文件夹优先使用 NTFS 硬链接，避免重复占用空间。
- 自动发现音乐库中与在线歌单同名的现有文件夹，并吸收可识别的歌曲。
- 内置 NCM 流式转换，无需额外配置 ncmdump 程序。
- Cookie、用户 ID、歌单映射和任务状态只保存在本机。

## 系统要求

- Windows 10 或 Windows 11，64 位。
- 建议将音乐库存放在 NTFS 分区，以获得硬链接去重效果；跨文件系统时会安全回退为复制。
- 公开歌单通常无需登录。受限音源需要用户自己的网易云音乐登录状态和相应内容访问权限。

## 安装

1. 在仓库右侧的 **Releases** 中下载 `NCMSync-<版本>-Setup.exe`。
2. 运行安装程序并选择安装位置。
3. 首次启动后输入网易云用户 ID，或使用“一键获取 ID 和 Cookie”完成登录。
4. 选择音乐库位置，然后添加需要同步的在线歌单。

当前公开安装包未进行商业代码签名。Windows 可能显示 SmartScreen“无法识别的应用”提示；请只从本仓库的 Releases 下载，并使用随 Release 提供的 `SHA256SUMS.txt` 核对文件完整性。

## 快速开始

首次运行默认使用当前 Windows 用户“音乐”目录下的 `music library`。如果所选位置已经存在与在线歌单同名的文件夹，NCM Sync 会直接将其显示为本地歌单，并根据“歌名 + 艺术家”匹配已有音频，避免重复下载。

同步策略默认较为保守：在线歌单减少的歌曲不会自动从本地删除，除非用户明确开启相应选项。

### 实时同步

打开一键同步按钮上方的“实时同步”开关后，应用会持续检测所有未暂停歌单。发现更新或添加新歌单时会立即开始下载；空闲监测期间环形进度条持续旋转，实际下载时则显示真实进度。

### 登录、Cookie 与受限音源

应用可以打开隔离、沙箱化的网易云音乐登录窗口，只读取登录成功后的 `MUSIC_U` Cookie。Cookie 默认隐藏，仅保存在音乐库的 `.cloudmusic/cloudmusic.sqlite` 中，不会上传到 NCM Sync 的服务器——本项目没有遥测或云端服务。

请勿分享 `.cloudmusic` 目录、数据库或 Cookie。重新获取 Cookie 后，因权限问题暂停的当前下载任务会自动继续。

## 音乐库结构

```text
Music Library/
├─ .cloudmusic/cloudmusic.sqlite  # 本机配置、映射与任务状态
├─ songs/                         # 唯一歌曲实体
├─ 歌单 A/                        # 指向 songs/ 的硬链接
└─ 歌单 B/
```

移除本地歌单只会删除对应歌单文件夹；共享的歌曲实体仍保留在 `songs/` 中。修改音乐库位置时，可以选择迁移现有内容，或保留旧文件并在新位置重新识别、同步。

## 从源码运行

需要 Node.js 22.12 或更高版本。PowerShell 建议使用 `.cmd` 入口：

```powershell
git clone <本仓库地址>
cd NCM-Sync
npm.cmd ci
npm.cmd run dev
```

开发模式的 Electron 用户数据和缓存保存在仓库内的 `.cloudmusic/electron-dev/`，不会使用正式版的 AppData 数据。

### 测试

```powershell
npm.cmd test
npm.cmd run test:e2e
```

测试全部使用模拟接口和临时音乐库，不会接触真实账号、Cookie 或现有音乐文件。

### 构建 Windows 安装包

```powershell
npm.cmd run dist
npm.cmd run test:packaged
```

输出位于 `release/`。构建产物、音乐库、Cookie 和下载文件均被排除在 Git 跟踪之外。

## 隐私与安全

- 不收集遥测，不提供远程账号系统，也不运行 NCM Sync 云端服务。
- 主窗口启用 Electron 沙箱、上下文隔离和受限 preload API。
- 本地 HTTP API 只监听 `127.0.0.1`，并拒绝非应用来源的写操作。
- 网易云登录窗口限制为网易云音乐 HTTPS 域名。
- 完整的数据处理说明见 [PRIVACY.md](PRIVACY.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露 Cookie 或可利用细节。

## 免责声明

NCM Sync 是独立的开源项目，与网易云音乐及其关联公司无隶属、授权或认可关系。网易云音乐名称及相关商标归其权利人所有。

本工具只应处理用户依法获得访问权限的内容。用户应自行遵守适用法律、平台规则和内容许可，不得使用本工具传播、出售或侵犯第三方版权。项目不提供账号、会员权限或内容访问权。

## 贡献与许可

欢迎提交问题和改进。开始贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

源代码采用 [MIT License](LICENSE)。NCM 格式兼容实现的参考来源及许可文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
