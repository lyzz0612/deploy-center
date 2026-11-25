<a id="readme-top"></a>

<div align="center">

<h3 align="center">Mini-Games Publish Console</h3>

  <p align="center">
    One place to register, release and roll back WeChat mini-games, Douyin mini-games and H5 builds
    <br />
    <a href="README.md"><strong>中文文档 »</strong></a>
  </p>

[![Status][status-shield]][status-url]
[![Node][node-shield]][node-url]
[![Docker][docker-shield]][docker-url]

</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about">About</a></li>
    <li><a href="#status">Status</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#docs">Docs</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

## About

One mini-game ships to three channels, and the three release paths do not look alike: build artifacts get copied and registered by hand, H5 rollbacks mean rebuilding and redeploying, and each platform's AppSecret or upload key ends up scattered across CI secrets and personal machines. The official WeChat and Douyin CLIs also need a long-running host with Node, a writable filesystem and a fixed egress IP — which managed CI runners rarely provide.

This repo is a self-hosted publish console for that problem: **CI only builds and reports artifact metadata; every release action runs in the console**. It keeps every platform difference inside a pluggable target kind.

- Build artifacts never pass through the console — CI reports a public URL plus size and sha256.
- Releasing happens in a long-running container, so it gets a fixed egress IP and keeps failure evidence.
- Adding a platform or an H5 deployment method costs one plugin directory plus one registry line.
- Credentials are typed, encrypted and only referenced by publish targets, so rotation touches one place.
- A release is a multi-stage job: immutable record, retry only the failed stage, rollback decided by declared capability.

**Stack**: Node.js 22 + TypeScript, SQLite (WAL), server-rendered HTML, Docker Compose (one service, two volumes), images built by GitHub Actions and published to GHCR (`ghcr.io/lyzz0612/minigames`).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Status

The core path works and is verified against real HTTP: 475 tests pass, H5 publish and rollback were checked through an actual external URL, and both platform CLIs install successfully.

**Not yet verified**: deployment on a real Docker host, a real WeChat upload (that needs a mini-game account and a code upload key), a real Cloudflare R2 bucket (the H5 target is tested against an in-process fake S3 that exercises the real SDK, signing and paging), and the image workflow itself — it is configured (tags `v*` or manual dispatch → smoke test → GHCR) but has not run yet. See [README.md](README.md) for details.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] Architecture, domain model and plugin contract
- [x] Service skeleton: compose, schema creation, auth
- [x] Data layer, registries and startup self-check
- [x] Credential management
- [x] Game and package-type management
- [x] CI ingestion API and build views
- [x] Job runner (stages, retry, timeout, crash recovery)
- [x] CLI installation and three-layer probing
- [x] WeChat plugin (real upload pending) and the `h5-r2` object-storage target (Cloudflare R2 / S3-compatible)
- [x] Console UI
- [x] Image pipeline: tag or manual dispatch → smoke test → GHCR
- [ ] End-to-end deployment on a Docker host

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Docs

- [proposal.md](openspec/changes/add-publish-console/proposal.md)
- [design.md](openspec/changes/add-publish-console/design.md)
- [tasks.md](openspec/changes/add-publish-console/tasks.md)
- [specs](openspec/changes/add-publish-console/specs/publish-console)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

[https://github.com/lyzz0612/minigames](https://github.com/lyzz0612/minigames) · [Issues](https://github.com/lyzz0612/minigames/issues)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

[status-shield]: https://img.shields.io/badge/status-alpha-blue
[status-url]: openspec/changes/add-publish-console/proposal.md
[node-shield]: https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white
[node-url]: https://nodejs.org/
[docker-shield]: https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white
[docker-url]: https://docs.docker.com/compose/
