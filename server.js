const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

/* =========================================================
   基础配置
   ========================================================= */

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const PUBLIC_BASE =
  process.env.PUBLIC_BASE ||
  `http://127.0.0.1:${PORT}`;

const ROOT =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');

const TMP = path.join(ROOT, 'tmp');
const OUT = path.join(ROOT, 'output');

const CHUNK_SIZE =
  4 * 1024 * 1024;

const MAX_BODY =
  CHUNK_SIZE + 1024 * 1024;

const HLS_TIME = 6;

const MAX_VIDEO_SIZE =
  2 * 1024 * 1024 * 1024;


/* =========================================================
   有赞 / 七牛配置
   ========================================================= */

const YOUZAN_TOKEN_URL =
  'https://shop92519496.youzan.com/v3/im/api/image/token?resourceType=image';

const QINIU_UPLOAD_URL =
  'https://up.qbox.me/';


/*
 * 有赞请求头
 *
 * 按你原来的 PHP 保留。
 */

const YOUZAN_HEADERS = {
  'Host':
    'shop92519496.youzan.com',

  'x-yz-action-id':
    'wap-im-' +
    crypto.randomUUID(),

  'User-Agent':
    'Mozilla/5.0 (Linux; Android 16; 24129RT7CC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36',

  'Referer':
    'https://shop92519496.youzan.com/v3/im/index?c=wsc&v=2&o=https%3A%2F%2Fshop92519496.youzan.com%2F&kdt_id=92327328&type=default&fromSource=%7B%22kdt_id%22%3A%2292327328%22%2C%22source%22%3A%22default%22%2C%22endpoint%22%3A%22h5%22%2C%22site_id%22%3A0%7D&reft=1705939714700&spm=f.90337278',

  'Accept':
    'application/json, text/plain, */*',

  'X-Requested-With':
    'cn.mujiankeji.mbrowser'
};


/* =========================================================
   目录
   ========================================================= */

async function ensureDirs() {

  await fsp.mkdir(
    TMP,
    {
      recursive: true
    }
  );

  await fsp.mkdir(
    OUT,
    {
      recursive: true
    }
  );
}


/* =========================================================
   JSON
   ========================================================= */

function json(
  res,
  status,
  obj
) {

  const body =
    JSON.stringify(obj);

  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Content-Length':
        Buffer.byteLength(body),

      'Access-Control-Allow-Origin':
        '*',

      'Access-Control-Allow-Headers':
        'Content-Type, X-Upload-Id',

      'Access-Control-Allow-Methods':
        'GET,POST,OPTIONS'
    }
  );

  res.end(body);
}


/* =========================================================
   TEXT
   ========================================================= */

function text(
  res,
  status,
  body,
  type =
    'text/plain; charset=utf-8'
) {

  res.writeHead(
    status,
    {
      'Content-Type':
        type,

      'Access-Control-Allow-Origin':
        '*',

      'Cache-Control':
        'no-cache'
    }
  );

  res.end(body);
}


/* =========================================================
   文件名安全
   ========================================================= */

function safeName(name) {

  name =
    path.basename(
      String(
        name ||
        'video.mp4'
      )
    );

  name =
    name.replace(
      /[^\w.\-()+\u4e00-\u9fff ]/g,
      '_'
    );

  return (
    name.slice(0, 180) ||
    'video.mp4'
  );
}


/* =========================================================
   ID
   ========================================================= */

function id() {

  return (
    Date.now() +
    '_' +
    crypto
      .randomBytes(6)
      .toString('hex')
  );
}


/* =========================================================
   上传目录
   ========================================================= */

function uploadDir(
  uploadId
) {

  return path.join(
    TMP,
    uploadId
  );
}


/* =========================================================
   JSON 文件
   ========================================================= */

async function readJson(file) {

  try {

    return JSON.parse(
      await fsp.readFile(
        file,
        'utf8'
      )
    );

  } catch {

    return null;
  }
}


async function writeJson(
  file,
  obj
) {

  await fsp.writeFile(
    file,
    JSON.stringify(
      obj,
      null,
      2
    )
  );
}


/* =========================================================
   执行命令
   ========================================================= */

function run(
  cmd,
  args,
  opts = {}
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const p =
        spawn(
          cmd,
          args,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ],
            ...opts
          }
        );

      let out = '';
      let err = '';

      p.stdout.on(
        'data',
        d => {
          out +=
            d.toString();
        }
      );

      p.stderr.on(
        'data',
        d => {
          err +=
            d.toString();
        }
      );

      p.on(
        'error',
        reject
      );

      p.on(
        'close',
        code => {

          if (code === 0) {

            resolve({
              out,
              err
            });

          } else {

            reject(
              new Error(
                `${cmd} exit ${code}: ${err.slice(-4000)}`
              )
            );
          }
        }
      );
    }
  );
}


/* =========================================================
   后台执行 FFmpeg
   ========================================================= */

function spawnLogged(
  cmd,
  args,
  logFile
) {

  const log =
    fs.createWriteStream(
      logFile,
      {
        flags: 'a'
      }
    );

  const p =
    spawn(
      cmd,
      args,
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

  p.stdout.pipe(log);
  p.stderr.pipe(log);

  p.on(
    'close',
    () => log.end()
  );

  return p;
}


/* =========================================================
   创建初始 M3U8
   ========================================================= */

async function createPlaceholderM3U8(
  dir
) {

  const file =
    path.join(
      dir,
      'playlist.m3u8'
    );

  try {

    await fsp.access(
      file
    );

    return;

  } catch {}

  const body =
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    '#EXT-X-TARGETDURATION:6\n' +
    '#EXT-X-MEDIA-SEQUENCE:0\n';

  await fsp.writeFile(
    file,
    body
  );
}


/* =========================================================
   初始化分片上传
   ========================================================= */

async function initUpload(
  meta
) {

  const uploadId =
    id();

  const dir =
    uploadDir(
      uploadId
    );

  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );

  await writeJson(
    path.join(
      dir,
      'meta.json'
    ),
    {
      id:
        uploadId,

      filename:
        safeName(
          meta.filename
        ),

      size:
        Number(
          meta.size || 0
        ),

      totalChunks:
        Number(
          meta.totalChunks || 0
        ),

      chunkSize:
        CHUNK_SIZE,

      createdAt:
        Date.now(),

      status:
        'uploading'
    }
  );

  return uploadId;
}


/* =========================================================
   获取 META
   ========================================================= */

async function getMeta(
  uploadId
) {

  return readJson(
    path.join(
      uploadDir(
        uploadId
      ),
      'meta.json'
    )
  );
}


/* =========================================================
   已上传分片
   ========================================================= */

async function uploadedChunks(
  uploadId,
  totalChunks
) {

  const dir =
    uploadDir(
      uploadId
    );

  const list = [];

  for (
    let i = 0;
    i < totalChunks;
    i++
  ) {

    try {

      const st =
        await fsp.stat(
          path.join(
            dir,
            `${i}.part`
          )
        );

      list.push(
        {
          index:
            i,

          size:
            st.size
        }
      );

    } catch {}
  }

  return list;
}


/* =========================================================
   合并 MP4
   ========================================================= */

async function mergeParts(
  uploadId,
  meta
) {

  const dir =
    uploadDir(
      uploadId
    );

  const work =
    path.join(
      dir,
      'merged.mp4'
    );

  try {

    const st =
      await fsp.stat(
        work
      );

    if (
      st.size > 0 &&
      meta.size > 0 &&
      st.size >= meta.size
    ) {

      return work;
    }

  } catch {}

  const fh =
    await fsp.open(
      work,
      'w'
    );

  try {

    for (
      let i = 0;
      i < meta.totalChunks;
      i++
    ) {

      const part =
        path.join(
          dir,
          `${i}.part`
        );

      const data =
        await fsp.readFile(
          part
        );

      await fh.write(
        data
      );
    }

  } finally {

    await fh.close();
  }

  return work;
}


/* =========================================================
   生成 125 字节真实 PNG
   =========================================================

   这里生成的是一个合法 PNG：

   PNG Signature
   IHDR
   IDAT
   tEXt
   IEND

   总大小严格 125 字节。

   每次随机生成不同的 Comment 内容，
   所以每次 PNG 二进制都会不同。
   ========================================================= */

function pngChunk(
  type,
  data
) {

  const typeBuffer =
    Buffer.from(
      type,
      'ascii'
    );

  const length =
    Buffer.alloc(4);

  length.writeUInt32BE(
    data.length,
    0
  );

  const crc =
    Buffer.alloc(4);

  crc.writeUInt32BE(
    crc32(
      Buffer.concat(
        [
          typeBuffer,
          data
        ]
      )
    ) >>> 0,
    0
  );

  return Buffer.concat(
    [
      length,
      typeBuffer,
      data,
      crc
    ]
  );
}


/*
 * CRC32
 */

function crc32(
  buffer
) {

  let crc =
    0xffffffff;

  for (
    let i = 0;
    i < buffer.length;
    i++
  ) {

    crc ^=
      buffer[i];

    for (
      let j = 0;
      j < 8;
      j++
    ) {

      crc =
        (crc >>> 1) ^
        (
          0xedb88320 &
          -(
            crc & 1
          )
        );
    }
  }

  return (
    crc ^
    0xffffffff
  ) >>> 0;
}


/*
 * 生成固定 125 字节 PNG
 */

function create125BytePNG() {

  const signature =
    Buffer.from(
      [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a
      ]
    );

  /*
   * 1x1 RGB PNG
   */

  const ihdrData =
    Buffer.alloc(
      13
    );

  ihdrData.writeUInt32BE(
    1,
    0
  );

  ihdrData.writeUInt32BE(
    1,
    4
  );

  /*
   * bit depth = 8
   * color type = 2 RGB
   */

  ihdrData[8] =
    8;

  ihdrData[9] =
    2;

  ihdrData[10] =
    0;

  ihdrData[11] =
    0;

  ihdrData[12] =
    0;

  const ihdr =
    pngChunk(
      'IHDR',
      ihdrData
    );


  /*
   * 一个黑色像素
   */

  const rawPixel =
    Buffer.from(
      [
        0,
        0,
        0,
        0
      ]
    );

  const compressed =
    require('zlib')
      .deflateSync(
        rawPixel
      );

  const idat =
    pngChunk(
      'IDAT',
      compressed
    );


  /*
   * tEXt：
   *
   * Comment
   * +
   * 36 字节随机 ASCII
   *
   * 这样总长度刚好为 125 字节。
   */

  const randomText =
    crypto
      .randomBytes(
        36
      )
      .toString(
        'base64'
      )
      .replace(
        /[^A-Za-z0-9]/g,
        'A'
      )
      .slice(
        0,
        36
      );

  const textData =
    Buffer.from(
      `Comment\0${randomText}`,
      'latin1'
    );

  const textChunk =
    pngChunk(
      'tEXt',
      textData
    );


  const iend =
    pngChunk(
      'IEND',
      Buffer.alloc(0)
    );


  const png =
    Buffer.concat(
      [
        signature,
        ihdr,
        idat,
        textChunk,
        iend
      ]
    );


  /*
   * 安全检查。
   */

  if (
    png.length !== 125
  ) {

    throw new Error(
      `PNG生成错误：${png.length} 字节，不是125字节`
    );
  }

  return png;
}


/* =========================================================
   获取有赞 Token
   ========================================================= */

async function getYouzanToken() {

  const response =
    await fetch(
      YOUZAN_TOKEN_URL,
      {
        method:
          'GET',

        headers:
          YOUZAN_HEADERS
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {

    throw new Error(
      `有赞 Token HTTP ${response.status}: ${text}`
    );
  }

  let data;

  try {

    data =
      JSON.parse(
        text
      );

  } catch {

    throw new Error(
      `有赞 Token 返回不是JSON：${text}`
    );
  }

  if (
    !data ||
    Number(data.code) !== 0
  ) {

    throw new Error(
      `有赞 Token 获取失败：${text}`
    );
  }

  const token =
    data.data;

  if (
    !token
  ) {

    throw new Error(
      `有赞没有返回token：${text}`
    );
  }

  return String(
    token
  );
}


/* =========================================================
   构造七牛 multipart
   ========================================================= */

function createQiniuMultipart(
  token,
  fileName,
  pngBuffer,
  tsPath
) {

  const boundary =
    '----NodeQiniu' +
    crypto
      .randomBytes(16)
      .toString('hex');


  /*
   * token
   */

  const tokenPart =
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="token"\r\n` +
      `\r\n` +
      `${token}\r\n`,
      'utf8'
    );


  /*
   * 文件。
   *
   * 这里非常重要：
   *
   * pngBuffer
   * ↓
   * TS
   *
   * 两者是同一个 multipart file。
   */

  const fileHeader =
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: image/png\r\n` +
      `\r\n`,
      'utf8'
    );


  const footer =
    Buffer.from(
      `\r\n--${boundary}--\r\n`,
      'utf8'
    );


  const tsStatPromise =
    fsp.stat(
      tsPath
    );


  return {
    boundary,
    tokenPart,
    fileHeader,
    pngBuffer,
    footer,
    tsStatPromise
  };
}


/* =========================================================
   上传：
   125字节PNG + TS
   到七牛
   ========================================================= */

async function uploadTsToQiniu(
  tsPath,
  originalName
) {

  /*
   * 1.
   * 获取有赞 token
   */

  const token =
    await getYouzanToken();


  /*
   * 2.
   * 创建 125 字节 PNG
   */

  const pngBuffer =
    create125BytePNG();


  /*
   * 3.
   * 文件名
   *
   * 仍然使用 TS 名称，
   * 但文件内容实际上是：
   *
   * PNG125 + TS
   */

  const fileName =
    path.basename(
      originalName
    );


  /*
   * 4.
   * Multipart
   */

  const multipart =
    createQiniuMultipart(
      token,
      fileName,
      pngBuffer,
      tsPath
    );


  const tsStat =
    await multipart.tsStatPromise;


  /*
   * 最终文件内容长度：
   *
   * PNG 125
   * +
   * TS
   */

  const combinedLength =
    pngBuffer.length +
    tsStat.size;


  /*
   * 整个 HTTP body 长度
   */

  const totalLength =
    multipart.tokenPart.length +
    multipart.fileHeader.length +
    combinedLength +
    multipart.footer.length;


  /*
   * TS Stream
   */

  const tsStream =
    fs.createReadStream(
      tsPath
    );


  /*
   * 构造 ReadableStream
   */

  const stream =
    new ReadableStream(
      {
        start(controller) {

          /*
           * token
           */

          controller.enqueue(
            multipart.tokenPart
          );


          /*
           * 文件头
           */

          controller.enqueue(
            multipart.fileHeader
          );


          /*
           * 关键：
           *
           * PNG 放在最前面。
           */

          controller.enqueue(
            multipart.pngBuffer
          );


          /*
           * 然后是 TS。
           */

          tsStream.on(
            'data',
            chunk => {

              controller.enqueue(
                chunk
              );
            }
          );


          tsStream.on(
            'end',
            () => {

              controller.enqueue(
                multipart.footer
              );

              controller.close();
            }
          );


          tsStream.on(
            'error',
            error => {

              controller.error(
                error
              );
            }
          );
        },

        cancel() {

          tsStream.destroy();
        }
      }
    );


  /*
   * 5.
   * 上传七牛
   */

  const response =
    await fetch(
      QINIU_UPLOAD_URL,
      {
        method:
          'POST',

        headers:
          {
            'Content-Type':
              `multipart/form-data; boundary=${multipart.boundary}`,

            'Content-Length':
              String(
                totalLength
              ),

            'User-Agent':
              'Mozilla/5.0'
          },

        body:
          stream,

        duplex:
          'half'
      }
    );


  const resultText =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `七牛 HTTP ${response.status}: ${resultText}`
    );
  }


  let result;

  try {

    result =
      JSON.parse(
        resultText
      );

  } catch {

    throw new Error(
      `七牛返回不是JSON：${resultText}`
    );
  }


  /*
   * PHP 原代码：
   *
   * $json['data']['attachment_url']
   * $json['data']['attachment_full_url']
   * $json['attachment_url']
   */

  const url =
    result?.data?.attachment_url ||
    result?.data?.attachment_full_url ||
    result?.attachment_url ||
    '';


  if (
    !url
  ) {

    throw new Error(
      `七牛没有返回图片URL：${resultText}`
    );
  }


  return {
    url,
    pngBytes:
      pngBuffer.length,
    tsBytes:
      tsStat.size,
    combinedBytes:
      combinedLength,
    response:
      result
  };
}


/* =========================================================
   M3U8
   ========================================================= */

async function appendSegmentToM3U8(
  playlist,
  duration,
  url
) {

  const line =
    `#EXTINF:${Number(duration).toFixed(6)},\n` +
    `${url}\n`;

  await fsp.appendFile(
    playlist,
    line
  );
}


async function finishM3U8(
  playlist
) {

  try {

    const data =
      await fsp.readFile(
        playlist,
        'utf8'
      );

    if (
      !data.includes(
        '#EXT-X-ENDLIST'
      )
    ) {

      await fsp.appendFile(
        playlist,
        '#EXT-X-ENDLIST\n'
      );
    }

  } catch {}
}


/* =========================================================
   获取 TS duration
   ========================================================= */

async function getTsDuration(
  tsPath
) {

  try {

    const r =
      await run(
        'ffprobe',
        [
          '-v',
          'error',

          '-show_entries',
          'format=duration',

          '-of',
          'default=noprint_wrappers=1:nokey=1',

          tsPath
        ]
      );

    const d =
      Number(
        r.out.trim()
      );

    if (
      Number.isFinite(d) &&
      d > 0
    ) {

      return d;
    }

  } catch {}

  return HLS_TIME;
}


/* =========================================================
   上传 TS 到七牛
   ========================================================= */

async function uploadSegmentsToQiniu(
  uploadId,
  outDir
) {

  const playlist =
    path.join(
      outDir,
      'playlist.m3u8'
    );

  const stateFile =
    path.join(
      outDir,
      'status.json'
    );


  const uploaded =
    new Set();

  let finished =
    false;


  while (
    !finished
  ) {

    const files =
      await fsp.readdir(
        outDir
      );


    const tsFiles =
      files
        .filter(
          x =>
            /^seg_\d+\.ts$/i.test(
              x
            )
        )
        .sort();


    for (
      const fileName of tsFiles
    ) {

      if (
        uploaded.has(
          fileName
        )
      ) {

        continue;
      }


      const tsPath =
        path.join(
          outDir,
          fileName
        );


      /*
       * 判断 FFmpeg 是否已经停止写这个 TS。
       */

      let stable =
        false;

      let previous =
        -1;


      for (
        let i = 0;
        i < 30;
        i++
      ) {

        try {

          const st =
            await fsp.stat(
              tsPath
            );


          if (
            st.size > 0 &&
            st.size === previous
          ) {

            stable =
              true;

            break;
          }


          previous =
            st.size;

        } catch {

          break;
        }


        await new Promise(
          r =>
            setTimeout(
              r,
              150
            )
        );
      }


      if (
        !stable
      ) {

        continue;
      }


      const duration =
        await getTsDuration(
          tsPath
        );


      /*
       * 上传：
       *
       * 125 PNG
       * +
       * TS
       *
       * 同一个文件。
       */

      let uploadResult;

      try {

        uploadResult =
          await uploadTsToQiniu(
            tsPath,
            fileName
          );

      } catch (e) {

        await writeJson(
          stateFile,
          {
            status:
              'qiniu_upload_error',

            uploadId,

            error:
              e.message,

            current:
              fileName,

            m3u8:
              `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
          }
        ).catch(
          () => {}
        );


        /*
         * 等待后重新上传。
         */

        await new Promise(
          r =>
            setTimeout(
              r,
              2000
            )
        );

        continue;
      }


      /*
       * 七牛上传成功。
       */

      await appendSegmentToM3U8(
        playlist,
        duration,
        uploadResult.url
      );


      uploaded.add(
        fileName
      );


      /*
       * 上传成功后删除 TS。
       */

      await fsp.unlink(
        tsPath
      ).catch(
        () => {}
      );


      /*
       * 更新状态。
       */

      await writeJson(
        stateFile,
        {
          status:
            'processing',

          uploadId,

          uploadedSegments:
            uploaded.size,

          current:
            fileName,

          lastUrl:
            uploadResult.url,

          pngBytes:
            uploadResult.pngBytes,

          tsBytes:
            uploadResult.tsBytes,

          combinedBytes:
            uploadResult.combinedBytes,

          m3u8:
            `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
        }
      ).catch(
        () => {}
      );
    }


    /*
     * 判断 FFmpeg 是否结束。
     */

    const ffmpegState =
      await readJson(
        path.join(
          outDir,
          'ffmpeg_state.json'
        )
      );


    if (
      ffmpegState &&
      ffmpegState.finished === true
    ) {

      finished =
        true;
    }


    if (
      !finished
    ) {

      await new Promise(
        r =>
          setTimeout(
            r,
            500
          )
      );
    }
  }


  /*
   * FFmpeg 完成后，
   * 最后再扫描一次。
   */

  const finalFiles =
    await fsp.readdir(
      outDir
    );


  const finalTs =
    finalFiles
      .filter(
        x =>
          /^seg_\d+\.ts$/i.test(
            x
          )
      )
      .sort();


  for (
    const fileName of finalTs
  ) {

    if (
      uploaded.has(
        fileName
      )
    ) {

      continue;
    }


    const tsPath =
      path.join(
        outDir,
        fileName
      );


    const duration =
      await getTsDuration(
        tsPath
      );


    const uploadResult =
      await uploadTsToQiniu(
        tsPath,
        fileName
      );


    await appendSegmentToM3U8(
      playlist,
      duration,
      uploadResult.url
    );


    uploaded.add(
      fileName
    );


    await fsp.unlink(
      tsPath
    ).catch(
      () => {}
    );
  }


  /*
   * 完成 M3U8
   */

  await finishM3U8(
    playlist
  );


  /*
   * 删除 FFmpeg 日志
   */

  await fsp.unlink(
    path.join(
      outDir,
      'ffmpeg.log'
    )
  ).catch(
    () => {}
  );


  await writeJson(
    stateFile,
    {
      status:
        'ready',

      uploadId,

      uploadedSegments:
        uploaded.size,

      endedAt:
        Date.now(),

      m3u8:
        `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
    }
  );


  return uploaded.size;
}


/* =========================================================
   FFmpeg HLS
   ========================================================= */

async function transcodeToHls(
  uploadId,
  input,
  meta
) {

  const outDir =
    path.join(
      OUT,
      uploadId
    );


  await fsp.mkdir(
    outDir,
    {
      recursive: true
    }
  );


  const playlist =
    path.join(
      outDir,
      'playlist.m3u8'
    );


  const logFile =
    path.join(
      outDir,
      'ffmpeg.log'
    );


  /*
   * Node 自己维护 M3U8。
   */

  await fsp.writeFile(
    playlist,
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    '#EXT-X-TARGETDURATION:6\n' +
    '#EXT-X-MEDIA-SEQUENCE:0\n'
  );


  await writeJson(
    path.join(
      outDir,
      'status.json'
    ),
    {
      status:
        'processing',

      uploadId,

      filename:
        meta.filename,

      startedAt:
        Date.now(),

      m3u8:
        `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
    }
  );


  /*
   * FFmpeg
   */

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-i',
    input,

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-crf',
    '23',

    '-c:a',
    'aac',

    '-b:a',
    '128k',

    '-f',
    'hls',

    '-hls_time',
    String(
      HLS_TIME
    ),

    '-hls_list_size',
    '0',

    '-hls_flags',
    'independent_segments',

    '-hls_segment_filename',

    path.join(
      outDir,
      'seg_%06d.ts'
    ),

    path.join(
      outDir,
      'ffmpeg.m3u8'
    )
  ];


  const p =
    spawnLogged(
      'ffmpeg',
      args,
      logFile
    );


  /*
   * FFmpeg 状态。
   */

  p.on(
    'close',
    async code => {

      await writeJson(
        path.join(
          outDir,
          'ffmpeg_state.json'
        ),
        {
          finished:
            true,

          success:
            code === 0,

          code,

          endedAt:
            Date.now()
        }
      ).catch(
        () => {}
      );
    }
  );


  /*
   * 一边 FFmpeg，
   * 一边上传七牛。
   */

  await uploadSegmentsToQiniu(
    uploadId,
    outDir
  );


  /*
   * 等 FFmpeg 完成。
   */

  await new Promise(
    resolve => {

      if (
        p.exitCode !== null
      ) {

        resolve();

        return;
      }

      p.once(
        'close',
        resolve
      );
    }
  );


  const ffState =
    await readJson(
      path.join(
        outDir,
        'ffmpeg_state.json'
      )
    );


  if (
    !ffState ||
    !ffState.success
  ) {

    throw new Error(
      'FFmpeg处理失败，请检查 ffmpeg.log'
    );
  }


  /*
   * 删除 FFmpeg playlist
   */

  await fsp.unlink(
    path.join(
      outDir,
      'ffmpeg.m3u8'
    )
  ).catch(
    () => {}
  );


  /*
   * 删除原始 MP4
   */

  await fsp.unlink(
    input
  ).catch(
    () => {}
  );


  /*
   * 删除上传分片
   */

  const dir =
    uploadDir(
      uploadId
    );


  try {

    const files =
      await fsp.readdir(
        dir
      );


    for (
      const file of files
    ) {

      if (
        file.endsWith(
          '.part'
        ) ||
        file ===
          'merged.mp4'
      ) {

        await fsp.unlink(
          path.join(
            dir,
            file
          )
        ).catch(
          () => {}
        );
      }
    }

  } catch {}


  await writeJson(
    path.join(
      outDir,
      'status.json'
    ),
    {
      status:
        'ready',

      uploadId,

      endedAt:
        Date.now(),

      m3u8:
        `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
    }
  );
}


/* =========================================================
   分片上传后台处理
   ========================================================= */

async function processUpload(
  uploadId
) {

  const meta =
    await getMeta(
      uploadId
    );


  if (
    !meta
  ) {

    return;
  }


  const dir =
    uploadDir(
      uploadId
    );


  const outDir =
    path.join(
      OUT,
      uploadId
    );


  await fsp.mkdir(
    outDir,
    {
      recursive: true
    }
  );


  await createPlaceholderM3U8(
    outDir
  );


  try {

    const merged =
      await mergeParts(
        uploadId,
        meta
      );


    await writeJson(
      path.join(
        dir,
        'meta.json'
      ),
      {
        ...meta,

        status:
          'merged',

        mergedAt:
          Date.now()
      }
    );


    await transcodeToHls(
      uploadId,
      merged,
      meta
    );


  } catch (e) {

    await writeJson(
      path.join(
        outDir,
        'status.json'
      ),
      {
        status:
          'error',

        error:
          e.message,

        m3u8:
          `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
      }
    ).catch(
      () => {}
    );
  }
}


/* =========================================================
   URL 下载
   ========================================================= */

async function downloadUrlToFile(
  url,
  file
) {

  const u =
    new URL(
      url
    );


  if (
    ![
      'http:',
      'https:'
    ].includes(
      u.protocol
    )
  ) {

    throw new Error(
      '仅支持 http/https 视频链接'
    );
  }


  const res =
    await fetch(
      url,
      {
        redirect:
          'follow'
      }
    );


  if (
    !res.ok ||
    !res.body
  ) {

    throw new Error(
      `下载失败 HTTP ${res.status}`
    );
  }


  const ws =
    fs.createWriteStream(
      file
    );


  let total =
    Number(
      res.headers.get(
        'content-length'
      ) || 0
    );


  let got =
    0;


  for await (
    const chunk of res.body
  ) {

    got +=
      chunk.length;


    if (
      got >
      MAX_VIDEO_SIZE
    ) {

      ws.destroy();

      throw new Error(
        '视频超过2GB限制'
      );
    }


    if (
      !ws.write(
        chunk
      )
    ) {

      await new Promise(
        r =>
          ws.once(
            'drain',
            r
          )
      );
    }
  }


  await new Promise(
    (
      resolve,
      reject
    ) => {

      ws.end(
        resolve
      );

      ws.on(
        'error',
        reject
      );
    }
  );


  return {
    total,
    got
  };
}


/* =========================================================
   URL 后台处理
   ========================================================= */

async function processRemote(
  uploadId,
  url,
  filename =
    'remote.mp4'
) {

  const dir =
    uploadDir(
      uploadId
    );


  const outDir =
    path.join(
      OUT,
      uploadId
    );


  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );


  await fsp.mkdir(
    outDir,
    {
      recursive: true
    }
  );


  await createPlaceholderM3U8(
    outDir
  );


  const safeFile =
    safeName(
      filename
    );


  const input =
    path.join(
      dir,
      safeFile
    );


  try {

    await writeJson(
      path.join(
        dir,
        'meta.json'
      ),
      {
        id:
          uploadId,

        filename:
          safeFile,

        sourceUrl:
          url,

        status:
          'downloading',

        createdAt:
          Date.now()
      }
    );


    await writeJson(
      path.join(
        outDir,
        'status.json'
      ),
      {
        status:
          'downloading',

        uploadId,

        m3u8:
          `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
      }
    );


    /*
     * 下载视频
     */

    await downloadUrlToFile(
      url,
      input
    );


    await writeJson(
      path.join(
        dir,
        'meta.json'
      ),
      {
        id:
          uploadId,

        filename:
          safeFile,

        sourceUrl:
          url,

        status:
          'downloaded',

        downloadedAt:
          Date.now()
      }
    );


    /*
     * FFmpeg + 七牛
     */

    await transcodeToHls(
      uploadId,
      input,
      {
        filename:
          safeFile
      }
    );


  } catch (e) {

    await writeJson(
      path.join(
        outDir,
        'status.json'
      ),
      {
        status:
          'error',

        uploadId,

        error:
          e.message,

        m3u8:
          `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
      }
    ).catch(
      () => {}
    );
  }
}


/* =========================================================
   请求 Body
   ========================================================= */

async function parseBody(
  req
) {

  const chunks = [];

  let n =
    0;


  for await (
    const c of req
  ) {

    n +=
      c.length;


    if (
      n >
      MAX_BODY
    ) {

      throw new Error(
        '请求过大'
      );
    }


    chunks.push(
      c
    );
  }


  return Buffer.concat(
    chunks
  );
}


/* =========================================================
   HTTP
   ========================================================= */

async function handle(
  req,
  res
) {

  /*
   * OPTIONS
   */

  if (
    req.method ===
    'OPTIONS'
  ) {

    res.writeHead(
      204,
      {
        'Access-Control-Allow-Origin':
          '*',

        'Access-Control-Allow-Headers':
          'Content-Type, X-Upload-Id',

        'Access-Control-Allow-Methods':
          'GET,POST,OPTIONS'
      }
    );

    return res.end();
  }


  const u =
    new URL(
      req.url,
      `http://${req.headers.host}`
    );


  /* =======================================================
     HEALTH
     ======================================================= */

  if (
    req.method === 'GET' &&
    u.pathname ===
      '/api/health'
  ) {

    return json(
      res,
      200,
      {
        ok:
          true,

        chunkSize:
          CHUNK_SIZE,

        qiniu:
          true,

        youzan:
          true,

        dingTalk:
          false
      }
    );
  }


  /* =======================================================
     INIT
     ======================================================= */

  if (
    req.method === 'POST' &&
    u.pathname ===
      '/api/upload/init'
  ) {

    try {

      const b =
        await parseBody(
          req
        );


      const m =
        JSON.parse(
          b.toString()
        );


      const uploadId =
        await initUpload(
          m
        );


      return json(
        res,
        200,
        {
          ok:
            true,

          uploadId,

          chunkSize:
            CHUNK_SIZE
        }
      );


    } catch (e) {

      return json(
        res,
        400,
        {
          ok:
            false,

          error:
            e.message
        }
      );
    }
  }


  /* =======================================================
     CHUNK
     ======================================================= */

  const cm =
    u.pathname.match(
      /^\/api\/upload\/([^/]+)\/chunk$/
    );


  if (
    req.method === 'POST' &&
    cm
  ) {

    try {

      const uploadId =
        cm[1];


      const meta =
        await getMeta(
          uploadId
        );


      if (
        !meta
      ) {

        return json(
          res,
          404,
          {
            ok:
              false,

            error:
              'uploadId不存在'
          }
        );
      }


      const index =
        Number(
          u.searchParams.get(
            'index'
          )
        );


      if (
        !Number.isInteger(
          index
        ) ||
        index < 0 ||
        index >=
          meta.totalChunks
      ) {

        return json(
          res,
          400,
          {
            ok:
              false,

            error:
              '分片序号错误'
          }
        );
      }


      const body =
        await parseBody(
          req
        );


      if (
        body.length >
        CHUNK_SIZE +
        1024 * 1024
      ) {

        return json(
          res,
          400,
          {
            ok:
              false,

            error:
              '分片超过允许大小'
          }
        );
      }


      await fsp.writeFile(
        path.join(
          uploadDir(
            uploadId
          ),
          `${index}.part`
        ),
        body
      );


      const list =
        await uploadedChunks(
          uploadId,
          meta.totalChunks
        );


      const done =
        list.length ===
        meta.totalChunks;


      if (
        done
      ) {

        const outDir =
          path.join(
            OUT,
            uploadId
          );


        await fsp.mkdir(
          outDir,
          {
            recursive: true
          }
        );


        await createPlaceholderM3U8(
          outDir
        );


        const m3u8 =
          `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`;


        const state =
          await readJson(
            path.join(
              outDir,
              'status.json'
            )
          );


        if (
          !state ||
          ![
            'processing',
            'ready'
          ].includes(
            state.status
          )
        ) {

          await writeJson(
            path.join(
              outDir,
              'status.json'
            ),
            {
              status:
                'queued',

              uploadId,

              m3u8
            }
          );


          processUpload(
            uploadId
          ).catch(
            console.error
          );
        }


        return json(
          res,
          200,
          {
            ok:
              true,

            index,

            done:
              true,

            uploaded:
              list.length,

            total:
              meta.totalChunks,

            remaining:
              0,

            m3u8
          }
        );
      }


      return json(
        res,
        200,
        {
          ok:
            true,

          index,

          done:
            false,

          uploaded:
            list.length,

          total:
            meta.totalChunks,

          remaining:
            meta.totalChunks -
            list.length
        }
      );


    } catch (e) {

      return json(
        res,
        500,
        {
          ok:
            false,

          error:
            e.message
        }
      );
    }
  }


  /* =======================================================
     STATUS
     ======================================================= */

  const sm =
    u.pathname.match(
      /^\/api\/upload\/([^/]+)\/status$/
    );


  if (
    req.method === 'GET' &&
    sm
  ) {

    const uploadId =
      sm[1];


    const meta =
      await getMeta(
        uploadId
      );


    if (
      !meta
    ) {

      return json(
        res,
        404,
        {
          ok:
            false,

          error:
            'uploadId不存在'
        }
      );
    }


    const list =
      await uploadedChunks(
        uploadId,
        meta.totalChunks
      );


    const outDir =
      path.join(
        OUT,
        uploadId
      );


    const state =
      await readJson(
        path.join(
          outDir,
          'status.json'
        )
      );


    return json(
      res,
      200,
      {
        ok:
          true,

        uploadId,

        meta,

        uploaded:
          list,

        total:
          meta.totalChunks,

        remaining:
          meta.totalChunks -
          list.length,

        state,

        m3u8:
          `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
      }
    );
  }


  /* =======================================================
     VIDEO URL
     ======================================================= */

  if (
    req.method === 'POST' &&
    u.pathname ===
      '/api/url'
  ) {

    try {

      const b =
        await parseBody(
          req
        );


      const m =
        JSON.parse(
          b.toString()
        );


      if (
        !m.url
      ) {

        return json(
          res,
          400,
          {
            ok:
              false,

            error:
              '视频URL不能为空'
          }
        );
      }


      const uploadId =
        id();


      const outDir =
        path.join(
          OUT,
          uploadId
        );


      const dir =
        uploadDir(
          uploadId
        );


      await fsp.mkdir(
        dir,
        {
          recursive: true
        }
      );


      await fsp.mkdir(
        outDir,
        {
          recursive: true
        }
      );


      await createPlaceholderM3U8(
        outDir
      );


      const m3u8 =
        `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`;


      processRemote(
        uploadId,
        m.url,
        m.filename ||
          'remote.mp4'
      ).catch(
        console.error
      );


      return json(
        res,
        200,
        {
          ok:
            true,

          uploadId,

          m3u8
        }
      );


    } catch (e) {

      return json(
        res,
        400,
        {
          ok:
            false,

          error:
            e.message
        }
      );
    }
  }


  /* =======================================================
     HLS
     ======================================================= */

  const hm =
    u.pathname.match(
      /^\/hls\/([^/]+)\/(.+)$/
    );


  if (
    req.method === 'GET' &&
    hm
  ) {

    const uploadId =
      hm[1];


    const relative =
      hm[2];


    const base =
      path.resolve(
        OUT
      );


    const file =
      path.resolve(
        OUT,
        uploadId,
        relative
      );


    if (
      !(
        file === base ||
        file.startsWith(
          base +
          path.sep
        )
      )
    ) {

      return text(
        res,
        403,
        'forbidden'
      );
    }


    try {

      const st =
        await fsp.stat(
          file
        );


      const ext =
        path
          .extname(
            file
          )
          .toLowerCase();


      let type =
        'application/octet-stream';


      if (
        ext ===
        '.m3u8'
      ) {

        type =
          'application/vnd.apple.mpegurl';

      } else if (
        ext ===
        '.ts'
      ) {

        type =
          'video/mp2t';
      }


      res.writeHead(
        200,
        {
          'Content-Type':
            type,

          'Content-Length':
            st.size,

          'Cache-Control':
            ext === '.m3u8'
              ? 'no-cache, no-store'
              : 'public, max-age=86400',

          'Access-Control-Allow-Origin':
            '*'
        }
      );


      fs.createReadStream(
        file
      ).pipe(
        res
      );


    } catch {

      return text(
        res,
        404,
        'not found'
      );
    }


    return;
  }


  /* =======================================================
     首页
     ======================================================= */

  if (
    req.method === 'GET' &&
    u.pathname === '/'
  ) {

    const html =
      await fsp.readFile(
        path.join(
          __dirname,
          'public',
          'index.html'
        ),
        'utf8'
      );


    return text(
      res,
      200,
      html,
      'text/html; charset=utf-8'
    );
  }


  return text(
    res,
    404,
    'Not Found'
  );
}


/* =========================================================
   启动
   ========================================================= */

ensureDirs()
  .then(
    () => {

      http
        .createServer(
          (
            req,
            res
          ) => {

            handle(
              req,
              res
            ).catch(
              e => {

                console.error(
                  e
                );

                json(
                  res,
                  500,
                  {
                    ok:
                      false,

                    error:
                      e.message
                  }
                );
              }
            );
          }
        )
        .listen(
          PORT,
          HOST,
          () => {

            console.log(
              `Server started at ${HOST}:${PORT}`
            );

            console.log(
              `PUBLIC_BASE=${PUBLIC_BASE}`
            );

            console.log(
              'Upload mode: Youzan Token + Qiniu'
            );

            console.log(
              'DingTalk upload: DISABLED'
            );

            console.log(
              'PNG prefix: 125 bytes'
            );
          }
        );
    }
  )
  .catch(
    e => {

      console.error(
        e
      );

      process.exit(
        1
      );
    }
  );