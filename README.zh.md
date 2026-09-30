# dsh-widget

[English](README.md) | 中文

为 DeepSeek Harness 提供内联可视化。模型用一次工具调用递交一个自包含的 SVG 或
HTML 片段，该片段就作为一张卡片渲染在对话里 —— 流程图、图表、时间线、对比表格、
带标注的版式 —— 而不是被写成文字描述。

[![test](https://github.com/anneqaq/dsh-widget/actions/workflows/test.yml/badge.svg)](https://github.com/anneqaq/dsh-widget/actions/workflows/test.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dsh](https://img.shields.io/badge/dsh-0.1.2--rc.1%20%7C%7C%200.1.5--alpha.1%20%7C%7C%200.1.6--0%20%7C%7C%200.1.7--0-blue)

## 安装

从 GitHub 安装：

```bash
dsh plugin --profile web add github:anneqaq/dsh-widget
```

或者从一个本地检出安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-widget
```

然后重启 `dsh web`。插件在启动时挂载，没有热重载。

确认配置树里出现了这一行：

```bash
dsh --profile web --dump-config | grep -A2 dsh-widget
```

如果 `pnpm` 报 `ERR_PNPM_ADDING_TO_ROOT` —— 自带的 `web` profile 是单包
workspace，因此触发了它的根检查 —— 放行根写入即可：

```bash
npm_config_ignore_workspace_root_check=true dsh plugin --profile web add github:anneqaq/dsh-widget
```

卸载：

```bash
dsh plugin --profile web remove dsh-widget
```

> 本包**没有构建步骤**，`lib/` 已随仓库提交，所以从 git 安装不需要 `prepare`
> 脚本，也不需要 pnpm 的 `allowBuilds` 授权 —— 安装时不会在你的机器上执行任何
> 构建代码。

## 使用

工作由模型完成，没有需要你配置的东西。要一个可视化的结果，它就会调用
`render_widget`：

> 把这个服务的请求生命周期画成一条时间线。

`render_widget` 接受四个参数：

| 参数 | 必填 | 含义 |
|---|---|---|
| `html` | 是 | 一个自包含的 SVG 或 HTML 片段。 |
| `title` | 否 | 卡片上方的标题；同时也是 frame 的标题。 |
| `height` | 否 | frame 高度（CSS 像素）。默认 420，钳制在 80–2000。 |
| `allowScripts` | 否 | 允许片段内执行脚本。默认关闭。 |

工具只返回一句简短确认。片段**不会**被回显进模型上下文 —— 卡片从记录下来的
调用参数里读取它，因此一张大图在会话记录里只占一份，而不是两份。

## 工作原理

两半，同一个名字：

```
dsh-widget/
├── package.json        dsh.bundle.patch + dsh.client，无依赖
├── cordis.patch.yml    插入本插件的 node 半边行
├── icon.svg            插件图标（显示元数据）
├── locale/             显示元数据：en.json / zh.json
├── lib/
│   ├── index.js        node 半边  → 注册工具 + 一段提示词
│   └── client.js       浏览器半边 → 渲染该工具的调用
└── test/               36 项测试，不需要浏览器、不需要宿主
```

**node 半边**注册一个朴素的 `ToolDefinition`，以及一段陈述创作约定的系统提示词。
它不持有状态，也不绘制任何东西。

**浏览器半边**在按键索引的 `tool.call.toolview` 插槽里认领线名
`render_widget`。由于该插槽以线协议的工具名为键，这是纯增量的：它从不触碰自带
的工具卡片。

**没有构建步骤。** 浏览器半边是用 shell 期望的
`window.__ModuleLoader__.load({ id, factory })` 惰性 CJS 格式手写的，因此包直接
发布 `lib/client.js` —— 没有 tsdown，没有 TypeScript，没有打包器。它唯一
`require` 的是 `react`，而 `react` 是 shell 冻结的平台模块表成员。

**完全没有依赖。** bundle 是通过它在 profile 下的真实路径加载的，所以像
`@deepseek-ai/dsh-tools` 这样的裸标识符只有在包自带 `node_modules` 时才能解析。
本包不导入任何东西，这正是它能从任意目录安装的原因 —— 包括符号链接的开发检出。
`defineTool` 助手本会生成的输入校验，改写在 `lib/index.js` 里。

## 隔离

片段由模型编写，因此按不可信内容处理。它通过**沙箱化的 `srcdoc` frame** 渲染，
绝不通过应用自身 DOM 里的 `dangerouslySetInnerHTML`。

- `sandbox=""` —— 无脚本、不透明源。仅当调用方以 `allowScripts: true` 要求时才用
  `sandbox="allow-scripts"`，且**绝不**与 `allow-same-origin` 同时出现（这一对会让
  片段触及宿主文档）。
- frame 的 CSP 是 `default-src 'none'`，加上 `img-src data: blob:`、
  `style-src 'unsafe-inline'`、`connect-src 'none'`。一个走神写下的 CDN 引入或一次
  `fetch` 会失败关闭，而不是悄悄外泄数据。
- 卡片自身不持有主题状态。frame 注入应用当前正在绘制的调色板，通过
  `body[data-ds-dark-theme]` 跟踪，因此实时切换主题会重新渲染 frame。

## 值得知道的限制

- **卡片在片段参数闭合时出现**，而不是在它流式传输的过程中。读一个只到一半的
  片段会渲染出破损的标记，因此视图在 `html` 完整之前显示占位符 —— 这通常早于
  工具结果落地。
- **单片段 512 KB。** 标记存放在会话日志里，所以这个上限同时约束会话记录和线上
  请求。
- **frame 内没有网络**，这是设计使然。一切都内联。
- **卡片是一个工具行，不是正文。** 它渲染在调用所在的那一轮位置上。段落中间的
  内联渲染无法通过公开扩展点实现；`tool.call.toolview` 插槽是被认可的接缝。

## 兼容性

`package.json` 声明 `engines.dsh` 为
`>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-0 <0.2.0 || >=0.1.7-0 <0.2.0`。

多段 `||` 形式是 semver 预发布规则要求的：一个预发布版本只有在同一个
`[major, minor, patch]` 元组中存在带预发布标记的比较器时，才满足一个比较器集合，
所以裸的 `>=0.1.2-rc.1 <0.2.0` **不**接纳 `0.1.5-rc.1`。每个新的上游预发布元组
都需要自己的子句。

本包在 `0.1.7-rc.2` 上开发与验证，并且**故意不声明**对
`@deepseek-ai/dsh-*` 的 `peerDependencies`：它不导入任何宿主包，而
`peerDependencies` 是一个**强制的安装门禁**（`evaluatePluginCompatibility`，
失败即关闭），声明它会增加一道没有增加事实的门。`engines.dsh` 是声明式的，并且
会被插件市场读取用于兼容性展示。

## 开发

```bash
npm test
```

36 项测试，不需要浏览器、不需要宿主。它们跑的是真实投影：决定卡片是否渲染的
流式 JSON 恢复、frame 的 CSP，以及工具契约。

其中两项检查是刻意的回归护栏，而不是行为测试 —— 模块必须不导入任何东西，
`output.schema` 必须保持闭合。两者编码的都是会在宿主启动时大声失败、而不是在
单元测试时报错的错误。

## 许可证

MIT
