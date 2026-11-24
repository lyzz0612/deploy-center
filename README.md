<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->

<div align="center">

<h3 align="center">多端小游戏发布中控台</h3>

  <p align="center">
    微信小游戏 · 抖音小游戏 · H5 的统一版本登记、发布与切流
    <br />
    <a href="openspec/changes/add-publish-console/proposal.md"><strong>查看设计方案 »</strong></a>
    <br />
    <br />
    <a href="https://github.com/lyzz0612/minigames/issues">提交问题</a>
    ·
    <a href="openspec/changes/add-publish-console/tasks.md">实施计划</a>
  </p>

[![Status][status-shield]][status-url]
[![Node][node-shield]][node-url]
[![Docker][docker-shield]][docker-url]
[![OpenSpec][openspec-shield]][openspec-url]

</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>目录</summary>
  <ol>
    <li>
      <a href="#关于本项目">关于本项目</a>
      <ul>
        <li><a href="#设计要点">设计要点</a></li>
        <li><a href="#技术栈">技术栈</a></li>
      </ul>
    </li>
    <li><a href="#当前状态">当前状态</a></li>
    <li><a href="#快速开始">快速开始</a></li>
    <li><a href="#路线图">路线图</a></li>
    <li><a href="#文档">文档</a></li>
    <li><a href="#参与贡献">参与贡献</a></li>
    <li><a href="#许可">许可</a></li>
    <li><a href="#联系">联系</a></li>
    <li><a href="#致谢">致谢</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->

## 关于本项目

同一款小游戏要同时发到微信小游戏、抖音小游戏和 H5，但三端的发布链路天然割裂：构建产物靠人手工拷贝登记，H5 发版靠手动替换站点目录、回滚只能重新打包，各平台的 AppSecret 与上传私钥散落在仓库 Actions Secrets 和个人机器上。而微信/抖音的官方 CLI 又必须在能装 Node、有可写文件系统、有固定出口 IP 的常驻环境里运行，托管的 CI runner 往往在这几步上卡住。

本项目是一套自建的发布中控台：**CI 只负责构建并上报产物元数据，发布动作全部由后台执行**。后台集中管理版本、凭据与发布目标，并把每个平台差异收拢成可插拔的插件。

### 设计要点

- **控制面与数据面分离**：后台不接收构建包的文件流，CI 上传产物后只上报「公开可访问的 URL + 包类型 + 大小 + sha256 + commit」，带宽与 I/O 留在外部。
- **发布在后台，不在 CI**：装 CLI、持私钥、调平台、重试、回滚都在常驻容器里完成，因此能拿到固定出口 IP、能保留失败现场。
- **发布目标插件化**：新增一个小游戏平台或一种 H5 部署方式，改动量固定为「一个插件目录 + 注册表一行」，核心流程不动。
- **凭据集中且只被引用**：凭据是类型化的加密键值袋，发布目标实例只引用凭据、不内联任何密钥，轮换只改一处。
- **发布是多阶段任务**：一次发布产生一条不可变记录，失败只重试失败阶段，回滚方式由目标类型声明的能力决定。
- **数据与代码分界清晰**：游戏、包类型、凭据、目标、构建、发布记录都是可在界面增删的数据；目标类型、凭据类型、CLI 规格才是代码。

### 技术栈

- **运行时**：Node.js 22 + TypeScript
- **数据**：SQLite（WAL）
- **前端**：React + Vite
- **部署**：Docker Compose（单个服务 + 数据卷 + CLI 卷）
- **变更管理**：[OpenSpec](https://github.com/Fission-AI/OpenSpec)

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- STATUS -->

## 当前状态

本项目处于**规划阶段**：架构、领域模型与插件契约已经定稿，尚无任何可运行代码。

| 方面 | 状态 |
| --- | --- |
| 架构与领域模型 | 已完成，见 `openspec/changes/add-publish-console/design.md` |
| 能力规格（6 项） | 已完成并通过 `openspec validate --strict` |
| 实施任务清单 | 已完成，共 12 组 41 项 |
| 可运行代码 | 未开始 |
| 部署文档 | 随实施产出 |

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- GETTING STARTED -->

## 快速开始

> 以下步骤描述的是目标形态，实施完成后才可执行。

### 前置要求

- 一台装有 Docker 与 Docker Compose 的主机，最好具备固定公网 IP（微信代码上传密钥需要配置 IP 白名单）
- 两个持久卷：数据库卷、`/opt/cli`（平台 CLI 安装目录）

### 安装

```bash
git clone https://github.com/lyzz0612/minigames.git
cd minigames
docker compose up -d
```

### 使用

1. 打开中控台，设置管理员口令并生成 CI key
2. 登记游戏、包类型（`wechat` / `douyin` / `h5`）、凭据与发布目标
3. 在 CI 侧加入一次上报调用（契约见 `specs/publish-console/build-ingestion/spec.md`）
4. 在构建列表里选择版本，发布到目标

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- ROADMAP -->

## 路线图

- [x] 架构、领域模型与插件契约设计
- [ ] 工程骨架：单服务 compose、SQLite 建表、鉴权
- [ ] 数据层与注册表、启动自检
- [ ] 凭据管理（类型化、加密、引用保护）
- [ ] 游戏与包类型管理
- [ ] CI 上报接口与构建视图
- [ ] 任务执行器（多阶段、重试、超时、中断恢复）
- [ ] CLI 安装与三层可用性探测
- [ ] 微信插件（第一个真实平台）
- [ ] H5 目标插件
- [ ] 中控台界面
- [ ] 端到端部署验证

完整任务与验证方式见 [tasks.md](openspec/changes/add-publish-console/tasks.md)。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- DOCS -->

## 文档

| 文档 | 内容 |
| --- | --- |
| [proposal.md](openspec/changes/add-publish-console/proposal.md) | 动机、变更范围、能力划分、影响 |
| [design.md](openspec/changes/add-publish-console/design.md) | 技术决策、领域模型、插件契约、风险与部署顺序 |
| [tasks.md](openspec/changes/add-publish-console/tasks.md) | 12 组实施任务，每项带验证方式 |
| [specs/](openspec/changes/add-publish-console/specs/publish-console/) | 6 项能力的行为契约：游戏与包类型、凭据、构建上报、发布目标、发布执行、CLI 管理 |

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- CONTRIBUTING -->

## 参与贡献

本项目为个人自用项目，暂不接受外部贡献。你可以自由 Fork 并按需修改。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- LICENSE -->

## 许可

暂未声明开源许可，保留所有权利。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- CONTACT -->

## 联系

项目地址：[https://github.com/lyzz0612/minigames](https://github.com/lyzz0612/minigames)

问题反馈：[Issues](https://github.com/lyzz0612/minigames/issues)

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- ACKNOWLEDGMENTS -->

## 致谢

- [othneildrew/Best-README-Template](https://github.com/othneildrew/Best-README-Template) — README 结构参考
- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — 变更与规格管理
- [rclone](https://rclone.org/) — 存储后端抽象的实现基础

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->

[status-shield]: https://img.shields.io/badge/status-planning-yellow
[status-url]: openspec/changes/add-publish-console/proposal.md
[node-shield]: https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white
[node-url]: https://nodejs.org/
[docker-shield]: https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white
[docker-url]: https://docs.docker.com/compose/
[openspec-shield]: https://img.shields.io/badge/spec-OpenSpec-6E56CF
[openspec-url]: https://github.com/Fission-AI/OpenSpec
