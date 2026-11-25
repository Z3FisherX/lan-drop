# LAN Drop · 现场扫码收件箱

让一群人把文件交到同一台电脑。主办方选择一个本地文件夹，投屏展示二维码。同一局域网内的参与者用手机或电脑扫码打开浏览器，就能上传文件，无需安装应用或注册账号。

适合工作坊交练习、培训收材料，或在小组活动结束时收齐照片和素材。文件直接保存到主办方电脑。

## 快速开始

1. 在主机上安装 Node.js，推荐在下载页选择 22.x LTS 的 Windows 安装包。下载或克隆项目后，双击 [`start-inbox.cmd`](start-inbox.cmd)。首次安装依赖需要联网。 [Node.js 下载页](https://nodejs.org/en/download)
2. 用主机浏览器打开终端显示的管理地址，默认是 `http://127.0.0.1:38471/`。
3. 点击「选目录并开始」。选好保存位置后，页面会生成收件二维码。如果目录选择窗口打不开，可展开「手动填写路径」，输入本机目录的完整路径。
4. 点击二维码放大投屏，或点击「复制链接」。访客扫码后点击「选择文件并上传」，确认文件后即开始上传，可以一次选择多个文件。出现「主办方已收到」即表示该文件已保存。
5. 在主机页面查看本次收件结果。结束时点击「结束收件」并确认，当前二维码和链接随即失效，已收到的文件保留在磁盘上。

收件期间请保持终端运行。使用 `Ctrl+C` 可以停止服务。

### 命令行启动

在项目目录运行以下命令。服务启动后，使用同一个本机管理地址。

```sh
npm install --no-package-lock
npm start
```

下面的命令使用 8088 端口、指定的默认收件目录和 2 GiB 的单文件上限启动。

```sh
npm start -- --port 8088 --dir "./workshop-uploads" --max-size 2
```

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--port` | `38471` | 设置服务端口。端口占用时可改用其他端口 |
| `--dir` | `./shared/inbox` | 设置管理页的初始收件路径。实际保存位置由主机开启收件时选定 |
| `--max-size` | `10` | 设置单文件大小上限，单位为 GiB |

## 收件如何工作

- **主机管理页**只接受本机访问。每次开启一个收件箱，可查看当次成功写入的文件名、大小和时间。
- **访客投递页**仅提供上传权限，可查看自己的上传进度和逐个文件的结果。完整文件写入后才显示收件确认，同名文件会加数字后缀。
- **结束或重启**会使当前链接失效。结束收件时会中止尚未传完的上传。重新开启会生成新二维码。页面保留当前或最近一次的收件记录，重启会清空记录，磁盘文件会保留。

收件目录需要可写且支持硬链接，例如 Windows 的 NTFS 目录。传输中断后，可以在访客页重试该文件。

## 扫码后打不开？

1. **先试扫一次。** 活动开始前，用另一台设备打开二维码。访客设备需要能在局域网内访问主机，部分访客 Wi-Fi 会隔离设备。
2. **检查网卡和防火墙。** 主机连着多个网络时，展开「连接选项」，选与访客同网的 IPv4 地址。Windows 防火墙提示时，可允许专用网络访问。
3. **确认使用投递链接。** `127.0.0.1` 是主机管理地址。访客应使用当前二维码或「复制链接」得到的地址。若页面显示链接失效，请主办方重新开启并分享新码。

LAN Drop 使用 HTTP 明文传输，适合可信局域网。请只向现场参与者展示有效二维码或投递链接。安装依赖后，页面、二维码生成和文件传输均可在没有公网连接的局域网内运行。

## 开发与验证

主机端使用 Node.js HTTP 服务。页面使用原生 HTML、CSS 和 JavaScript，二维码在本机生成。上传以流式方式写入临时文件，接收完成后再发布到目标目录。

```sh
npm run check:syntax
npm test
```

- [收件测试](test/inbox.test.js)覆盖局域网入口、访客权限、文件完整性、同名文件、结束收件及链接失效。
- [共享模式测试](test/server.test.js)覆盖原有目录共享功能。使用 `node server.js --help` 可查看启动选项，直接运行 `node server.js` 可进入原有目录共享模式。
- 已在 Windows 和 Node.js 22.21.1 上通过集成测试，并用 Chrome 桌面及手机尺寸视口验证扫码入口、上传和收件流程。不同手机和现场网络建议在活动前试扫。

如果你使用 Yarn Classic，可运行 `yarn install --frozen-lockfile` 按仓库锁文件安装。提交问题时，建议注明主机系统、Node.js 版本、访客浏览器和复现步骤。

## English quick start

LAN Drop collects files from people on the same local network. One host starts the inbox and chooses a local folder. Guests scan the QR code, upload from their browser, and see a receipt when the host has saved their files.

Use Node.js 22 LTS on the Windows host. Run `npm install --no-package-lock` and `npm start`, then open `http://127.0.0.1:38471/` on that computer. Choose a folder and show the QR code. End the inbox when you're done to revoke the link. Use LAN Drop on a trusted network.

## 许可证

开源许可证待确定。
