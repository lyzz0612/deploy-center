/**
 * 进程内的假 S3 服务（测试用）。
 *
 * 为什么不 mock SDK：mock 掉 SDK 就等于把「请求长什么样」这件事也假设对了，
 * 而那正是最容易错的部分（路径风格寻址、缓存头、翻页、批量删除的部分成功）。
 * 这里起一个真的 HTTP 服务说 S3 协议的子集，于是签名、序列化、翻页都真的
 * 跑一遍——和 h5-dir 当初配真实静态服务器验证是同一个思路。
 *
 * 只实现这个插件用到的五个操作，不追求协议完整。
 */
import { createServer, type Server } from 'node:http';

export interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface FakeS3 {
  readonly url: string;
  /** 桶 → 键 → 对象。 */
  readonly buckets: Map<string, Map<string, StoredObject>>;
  /** 收到的请求数，按操作分类，用于断言「没有多发请求」。 */
  readonly calls: { put: number; get: number; list: number; delete: number; head: number };
  /** 让下一次（或多次）写入失败，用于验证失败路径。 */
  failNextPut(times: number, status?: number): void;
  object(bucket: string, key: string): StoredObject | undefined;
  keys(bucket: string): string[];
  close(): Promise<void>;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function startFakeS3(options: { buckets?: readonly string[] } = {}): Promise<FakeS3> {
  const buckets = new Map<string, Map<string, StoredObject>>();
  for (const name of options.buckets ?? ['test-bucket']) {
    buckets.set(name, new Map());
  }

  const calls = { put: 0, get: 0, list: 0, delete: 0, head: 0 };
  let failPuts = 0;
  let failStatus = 500;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 路径风格寻址：/<bucket>/<key...>
    const segments = url.pathname.replace(/^\//, '').split('/');
    const bucketName = decodeURIComponent(segments[0] ?? '');
    const key = segments.slice(1).map(decodeURIComponent).join('/');
    const bucket = buckets.get(bucketName);
    const method = req.method ?? 'GET';

    const fail = (status: number, code: string): void => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    };

    if (bucket === undefined) {
      calls.head += method === 'HEAD' ? 1 : 0;
      fail(404, 'NoSuchBucket');
      return;
    }

    if (method === 'HEAD' && key === '') {
      calls.head += 1;
      res.writeHead(200).end();
      return;
    }

    // HEAD 单个对象：插件用它判断入口壳在不在，不下载内容
    if (method === 'HEAD') {
      calls.head += 1;
      const object = bucket.get(key);
      if (object === undefined) {
        fail(404, 'NoSuchKey');
        return;
      }
      res
        .writeHead(200, {
          'content-type': object.contentType || 'application/octet-stream',
          'content-length': String(object.body.byteLength),
        })
        .end();
      return;
    }

    // ListObjectsV2
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      calls.list += 1;
      const prefix = url.searchParams.get('prefix') ?? '';
      const token = url.searchParams.get('continuation-token');
      const all = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();

      // 刻意每页只给 2 个：翻页逻辑只有在真的翻页时才被验证到
      const pageSize = 2;
      const start = token === null ? 0 : Number(token);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize;
      const truncated = next < all.length;

      const body =
        `<?xml version="1.0"?><ListBucketResult>` +
        `<Name>${xmlEscape(bucketName)}</Name>` +
        `<Prefix>${xmlEscape(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount>` +
        `<MaxKeys>${pageSize}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
        page
          .map(
            (k) =>
              `<Contents><Key>${xmlEscape(k)}</Key>` +
              `<Size>${bucket.get(k)?.body.byteLength ?? 0}</Size>` +
              `<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
          )
          .join('') +
        `</ListBucketResult>`;
      res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
      return;
    }

    // DeleteObjects（POST /<bucket>?delete）
    if (method === 'POST' && url.searchParams.has('delete')) {
      calls.delete += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const xml = Buffer.concat(chunks).toString('utf8');
        const requested = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1] ?? '');
        for (const k of requested) bucket.delete(k);
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end('<?xml version="1.0"?><DeleteResult></DeleteResult>');
      });
      return;
    }

    if (method === 'PUT') {
      calls.put += 1;
      if (failPuts > 0) {
        failPuts -= 1;
        fail(failStatus, 'InternalError');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        bucket.set(key, {
          body: Buffer.concat(chunks),
          contentType: String(req.headers['content-type'] ?? ''),
          cacheControl: String(req.headers['cache-control'] ?? ''),
        });
        res.writeHead(200, { etag: '"fake"' }).end();
      });
      return;
    }

    if (method === 'GET') {
      calls.get += 1;
      const object = bucket.get(key);
      if (object === undefined) {
        fail(404, 'NoSuchKey');
        return;
      }
      res
        .writeHead(200, {
          'content-type': object.contentType || 'application/octet-stream',
          'content-length': String(object.body.byteLength),
        })
        .end(object.body);
      return;
    }

    fail(405, 'MethodNotAllowed');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('假 S3 服务没有拿到端口');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    buckets,
    calls,
    failNextPut(times: number, status = 500): void {
      failPuts = times;
      failStatus = status;
    },
    object(bucketName: string, key: string): StoredObject | undefined {
      return buckets.get(bucketName)?.get(key);
    },
    keys(bucketName: string): string[] {
      return [...(buckets.get(bucketName)?.keys() ?? [])].sort();
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
