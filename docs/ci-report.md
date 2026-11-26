# CI 接入：上报构建

CI 的职责只有两件：构建产物、上传到任意可公开访问的地方，然后把**元数据**登记进中控台。产物文件本身不经过中控台（design.md D1）。

## 前置准备

在中控台完成三件事，各做一次即可：

1. **登记游戏**，拿到它的 slug（例如 `demo`）
2. **登记包类型**，例如 `wechat`、`douyin`、`h5`
3. **保存 CI key**（设置 → CI key），把值填进 CI 的 secret。值加密保存在本机，随时可以回来复制或更换。

## 接口

```
POST /api/ci/builds
Authorization: Bearer <CI_KEY>
Content-Type: application/json
```

也支持 `X-CI-Key: <CI_KEY>`，两种任选。

### 字段

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `game` | 是 | string | 游戏 slug，必须已登记 |
| `packageType` | 是 | string | 包类型 id，必须已登记 |
| `buildId` | 是 | string | 构建标识。与 `game`+`packageType` 一起构成幂等键 |
| `artifactUrl` | 是 | string | 产物下载地址，必须是 http/https |
| `sizeBytes` | 是 | int | 产物字节数，正整数 |
| `sha256` | 是 | string | 产物 sha256，64 位十六进制 |
| `commitSha` | 否 | string | 源码 commit。**强烈建议填**，它决定列表能否聚合 |
| `description` | 否 | string | 这次构建做了什么，会显示在列表里 |

### 响应

| 状态码 | 含义 |
| --- | --- |
| 201 | 新建了构建记录 |
| 200 | 更新了既有记录（同一幂等键重复上报） |
| 400 | 载荷不合法，或游戏/包类型未登记。**不写入任何记录** |
| 401 | CI key 缺失或无效 |

响应体：

```json
{ "id": "<内部 id>", "buildId": "b20261124", "created": true }
```

## 为什么 sha256 和 size 是必填

没有它们，就没有任何手段证明「中控台发出去的那个包，正是 CI 构建出来的那个包」。发布时后台会下载产物并比对这两个值，不一致就终止，不把产物交给平台 CLI。

多产品、多渠道环境下，「哪个包属于哪次构建」如果只靠一个 URL 字符串维系，迟早会出一次发错包的事故。

## 幂等

幂等键是 `(game, packageType, buildId)`。CI 重跑同一次构建时：

- **不会**产生重复条目
- **会**覆盖 `artifactUrl`、`sizeBytes`、`sha256`、`commitSha`、`description`

覆盖是刻意的：重跑产出的是新产物，URL 和摘要都可能变。若拒绝覆盖，就只能换一个 `buildId`，列表里会留下一堆语义重复的条目。

## 产物链接的有效期归 CI 管

中控台**不持有**读取任何存储的凭据，只会用你给的 URL 去下载。所以这个链接必须在「你打算发布它」的那段时间内一直可访问。

有两个常见的坑：

- **GitHub Actions 的 artifact 需要登录，且默认 90 天过期。** 它的下载地址不是公开 URL，中控台拿不到。要用对象存储、Release 资产或别的公开位置。
- **签名 URL 会过期。** 如果上传后拿到的是带 `X-Amz-Expires` 的临时链接，隔天点发布就会拿到 403。用长期有效的地址，或者配一个公开读的 bucket。

发布时下载失败，后台会区分「地址不可达」「无权限」「超时」三种情况，并把当时用的 URL 记进发布日志，不会静默重试死链。

## 完整示例

### 手工验证一次

```bash
CONSOLE_URL=http://127.0.0.1:3000
CI_KEY=mgc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 算产物的摘要与大小
SHA256=$(sha256sum dist/demo-wechat.zip | cut -d' ' -f1)
SIZE=$(stat -c%s dist/demo-wechat.zip)

curl -sS -X POST "$CONSOLE_URL/api/ci/builds" \
  -H "Authorization: Bearer $CI_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"game\": \"demo\",
    \"packageType\": \"wechat\",
    \"buildId\": \"$(date +%Y%m%d)-${GITHUB_SHA:0:7}\",
    \"artifactUrl\": \"https://cdn.example.com/demo/wechat/$SHA256.zip\",
    \"sizeBytes\": $SIZE,
    \"sha256\": \"$SHA256\",
    \"commitSha\": \"$GITHUB_SHA\",
    \"description\": \"feat: 新手引导\"
  }"
```

macOS 上 `sha256sum` 换成 `shasum -a 256`，`stat -c%s` 换成 `stat -f%z`。

### GitHub Actions

```yaml
name: build-and-report

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package_type: [wechat, douyin, h5]
    steps:
      - uses: actions/checkout@v4

      - name: 构建
        run: ./scripts/build.sh ${{ matrix.package_type }}

      - name: 上传产物到对象存储
        env:
          RCLONE_CONFIG_REMOTE_TYPE: s3
          RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID: ${{ secrets.STORAGE_KEY_ID }}
          RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY: ${{ secrets.STORAGE_SECRET }}
        run: |
          rclone copy "dist/${{ matrix.package_type }}.zip" \
            "remote:${{ vars.STORAGE_BUCKET }}/demo/${{ matrix.package_type }}/"

      - name: 上报元数据
        env:
          CI_KEY: ${{ secrets.CONSOLE_CI_KEY }}
          CONSOLE_URL: ${{ vars.CONSOLE_URL }}
          PKG: ${{ matrix.package_type }}
        run: |
          FILE="dist/$PKG.zip"
          SHA256=$(sha256sum "$FILE" | cut -d' ' -f1)
          SIZE=$(stat -c%s "$FILE")
          BUILD_ID="${GITHUB_REF_NAME}-${GITHUB_RUN_NUMBER}"

          curl -sS --fail-with-body -X POST "$CONSOLE_URL/api/ci/builds" \
            -H "Authorization: Bearer $CI_KEY" \
            -H "Content-Type: application/json" \
            -d "$(jq -n \
                  --arg game       "demo" \
                  --arg packageType "$PKG" \
                  --arg buildId    "$BUILD_ID" \
                  --arg artifactUrl "https://cdn.example.com/demo/$PKG/$PKG.zip" \
                  --argjson sizeBytes "$SIZE" \
                  --arg sha256     "$SHA256" \
                  --arg commitSha  "$GITHUB_SHA" \
                  --arg description "$(git log -1 --pretty=%s)" \
                  '$ARGS.named')"
```

两处细节值得照抄：

- **`--fail-with-body`**：没有它，curl 遇到 400 仍然退出码 0，CI 会显示绿色而实际没登记上。
- **`jq -n` 拼 JSON**：commit message 里的引号、反斜杠、换行会把手写的 JSON 字符串搞坏。

### 用 matrix 还是一次上报三个包

上面用 matrix 并行构建三个包，每个包单独上报。三条记录会因为 `commitSha` 相同而在列表里聚合成一行，所以**务必填 `commitSha`**——不填的话三个包会各自独立成行，看不出它们属于同一次构建。

## 查看结果

管理接口（需要管理员会话，不是 CI key）：

```
GET /api/builds?gameId=<id>&packageTypeId=<id>&limit=50
```

返回按 commit 聚合的构建组，每个包带上它在各发布目标上的最新发布状态。

## 不要做的事

- **不要用 CI key 调管理 API。** 两条鉴权入口不互通，CI key 访问 `/api/*` 会返回 401。这是刻意的：CI 日志里泄漏一个 key，不应等于拿到后台控制权。
- **不要在 CI 里触发发布。** 上报只是登记，发布由人在后台发起。微信/抖音的审核以天为单位，把每次 push 都变成一次上传会让平台上的版本号迅速膨胀，运营也分不清哪个该提审。
- **不要把 CI key 打进日志。** 用 CI 的 secret 机制传递。
