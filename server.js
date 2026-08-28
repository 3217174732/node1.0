const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const zlib = require('zlib');

/* =========================================================
   基础配置
   ========================================================= */

const HOST =
  process.env.HOST || '0.0.0.0';

const PORT =
  Number(process.env.PORT || 8080);

const PUBLIC_BASE =
  process.env.PUBLIC_BASE ||
  'http://51.15.184.22:4941';


/* =========================================================
   数据目录
   ========================================================= */

const ROOT =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');


/*
 * 上传临时目录
 *
 * 分片、merged.mp4、meta.json
 */
const TMP =
  path.join(
    ROOT,
    'tmp'
  );


/*
 * FFmpeg 工作区
 *
 * FFmpeg 产生：
 *
 * seg_000000.ts
 * seg_000001.ts
 * ffmpeg.m3u8
 *
 * 这些都只存在这里。
 */
const OUT =
  path.join(
    ROOT,
    'output'
  );


/*
 * 最终 HLS 播放目录
 *
 * 播放器最终访问：
 *
 * /hls/{uploadId}/playlist.m3u8
 *
 * 这里只保存最终 playlist.m3u8
 */
const HLS =
  path.join(
    ROOT,
    'hls'
  );


/*
 * 链接记录
 */
const LINKS_DIR =
  path.join(
    ROOT,
    'links'
  );

const LINKS_FILE =
  path.join(
    LINKS_DIR,
    'links.json'
  );


/* =========================================================
   前端
   ========================================================= */

const PUBLIC_DIR =
  path.join(
    __dirname,
    'public'
  );

const INDEX_FILE =
  path.join(
    PUBLIC_DIR,
    'index.html'
  );


/* =========================================================
   参数
   ========================================================= */

const CHUNK_SIZE =
  4 * 1024 * 1024;

const MAX_BODY =
  CHUNK_SIZE +
  1024 * 1024;

const HLS_TIME =
  6;

const MAX_VIDEO_SIZE =
  2 * 1024 * 1024 * 1024;


/* =========================================================
   有赞 / 七牛
   ========================================================= */

const YOUZAN_TOKEN_URL =
  'https://shop92519496.youzan.com/v3/im/api/image/token?resourceType=image';

const QINIU_UPLOAD_URL =
  'https://up.qbox.me/';

const YOUZAN_HEADERS = {

  Host:
    'shop92519496.youzan.com',

  'x-yz-action-id':
    'wap-im-' +
    crypto.randomUUID(),

  'User-Agent':
    'Mozilla/5.0 (Linux; Android 16; 24129RT7CC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36',

  Referer:
    'https://shop92519496.youzan.com/v3/im/index?c=wsc&v=2&o=https%3A%2F%2Fshop92519496.youzan.com%2F&kdt_id=92327328&type=default&fromSource=%7B%22kdt_id%22%3A%2292327328%22%2C%22source%22%3A%22default%22%2C%22endpoint%22%3A%22h5%22%2C%22site_id%22%3A0%7D&reft=1705939714700&spm=f.90337278',

  Accept:
    'application/json, text/plain, */*',

  'X-Requested-With':
    'cn.mujiankeji.mbrowser'
};


/* =========================================================
   目录初始化
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

  await fsp.mkdir(
    HLS,
    {
      recursive: true
    }
  );

  await fsp.mkdir(
    LINKS_DIR,
    {
      recursive: true
    }
  );


  try {

    await fsp.access(
      LINKS_FILE
    );

  } catch {

    await fsp.writeFile(
      LINKS_FILE,
      '[]\n',
      'utf8'
    );
  }
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
        'GET,POST,OPTIONS',

      'Cache-Control':
        'no-store'
    }
  );


  res.end(
    body
  );
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
        'no-cache, no-store'
    }
  );


  res.end(
    body
  );
}


/* =========================================================
   MIME
   ========================================================= */

function mimeType(
  file
) {

  const ext =
    path
      .extname(file)
      .toLowerCase();

  const types = {

    '.html':
      'text/html; charset=utf-8',

    '.css':
      'text/css; charset=utf-8',

    '.js':
      'application/javascript; charset=utf-8',

    '.json':
      'application/json; charset=utf-8',

    '.png':
      'image/png',

    '.jpg':
      'image/jpeg',

    '.jpeg':
      'image/jpeg',

    '.gif':
      'image/gif',

    '.svg':
      'image/svg+xml',

    '.webp':
      'image/webp',

    '.ico':
      'image/x-icon',

    '.mp4':
      'video/mp4',

    '.m3u8':
      'application/vnd.apple.mpegurl',

    '.ts':
      'video/mp2t'
  };

  return (
    types[ext] ||
    'application/octet-stream'
  );
}


/* =========================================================
   Public 文件
   ========================================================= */

async function servePublicFile(
  relative,
  res
) {

  const base =
    path.resolve(
      PUBLIC_DIR
    );

  const file =
    path.resolve(
      PUBLIC_DIR,
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

    const stat =
      await fsp.stat(
        file
      );


    if (
      !stat.isFile()
    ) {

      return text(
        res,
        404,
        'not found'
      );
    }


    res.writeHead(
      200,
      {
        'Content-Type':
          mimeType(file),

        'Content-Length':
          stat.size,

        'Cache-Control':
          relative === 'index.html'
            ? 'no-cache, no-store, must-revalidate'
            : 'public, max-age=3600',

        'Access-Control-Allow-Origin':
          '*'
      }
    );


    fs.createReadStream(
      file
    ).pipe(
      res
    );


    return true;

  } catch {

    return text(
      res,
      404,
      'not found'
    );
  }
}


/* =========================================================
   文件名安全
   ========================================================= */

function safeName(
  name
) {

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
    name.slice(
      0,
      180
    ) ||
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
   工作目录
   ========================================================= */

function outputDir(
  uploadId
) {

  return path.join(
    OUT,
    uploadId
  );
}


/* =========================================================
   最终 HLS 目录
   ========================================================= */

function hlsDir(
  uploadId
) {

  return path.join(
    HLS,
    uploadId
  );
}


/* =========================================================
   HLS URL
   ========================================================= */

function hlsUrl(
  uploadId
) {

  return (
    `${PUBLIC_BASE}/hls/${uploadId}/playlist.m3u8`
  );
}


/* =========================================================
   JSON 读取
   ========================================================= */

async function readJson(
  file
) {

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


/* =========================================================
   JSON 写入
   ========================================================= */

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
    ),
    'utf8'
  );
}


/* =========================================================
   保存链接
   ========================================================= */

async function saveLink(
  m3u8,
  source
) {

  try {

    if (
      !m3u8
    ) {

      return;
    }


    let list = [];


    try {

      list =
        JSON.parse(
          await fsp.readFile(
            LINKS_FILE,
            'utf8'
          )
        );

    } catch {

      list = [];
    }


    if (
      !Array.isArray(list)
    ) {

      list = [];
    }


    m3u8 =
      String(
        m3u8
      );

    source =
      String(
        source ||
        ''
      );


    const index =
      list.indexOf(
        m3u8
      );


    if (
      index !== -1
    ) {

      if (
        index + 1 <
        list.length
      ) {

        list[index + 1] =
          source;

      } else {

        list.push(
          source
        );
      }

    } else {

      list.push(
        m3u8
      );

      list.push(
        source
      );
    }


    await fsp.writeFile(
      LINKS_FILE,
      JSON.stringify(
        list,
        null,
        2
      ) + '\n',
      'utf8'
    );


    console.log(
      `[链接记录] ${m3u8}`
    );

  } catch (e) {

    console.error(
      '[链接记录失败]',
      e.message
    );
  }
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

          if (
            code === 0
          ) {

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
   FFmpeg
   ========================================================= */

function spawnFFmpeg(
  cmd,
  args
) {

  return spawn(
    cmd,
    args,
    {
      stdio: [
        'ignore',
        'ignore',
        'ignore'
      ]
    }
  );
}


/* =========================================================
   创建最终 HLS M3U8
   ========================================================= */

async function createHlsPlaylist(
  uploadId
) {

  const dir =
    hlsDir(
      uploadId
    );


  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );


  const playlist =
    path.join(
      dir,
      'playlist.m3u8'
    );


  try {

    await fsp.access(
      playlist
    );

    return;

  } catch {}


  const body =
    '#EXTM3U\n' +
    '#EXT-X-VERSION:3\n' +
    '#EXT-X-TARGETDURATION:6\n' +
    '#EXT-X-MEDIA-SEQUENCE:0\n';


  await fsp.writeFile(
    playlist,
    body,
    'utf8'
  );
}


/* =========================================================
   初始化上传
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


  const outDir =
    outputDir(
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


  await createHlsPlaylist(
    uploadId
  );


  const filename =
    safeName(
      meta.filename
    );


  await writeJson(
    path.join(
      dir,
      'meta.json'
    ),
    {
      id:
        uploadId,

      filename,

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


  await writeJson(
    path.join(
      outDir,
      'status.json'
    ),
    {
      status:
        'uploading',

      uploadId,

      filename,

      createdAt:
        Date.now(),

      m3u8:
        hlsUrl(uploadId)
    }
  );


  /*
   * 注意：
   *
   * 现在记录的是最终 HLS 地址
   */
  await saveLink(
    hlsUrl(uploadId),
    filename
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
   PNG CRC32
   ========================================================= */

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


/* =========================================================
   PNG Chunk
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


/* =========================================================
   125 字节 PNG
   ========================================================= */

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
    zlib.deflateSync(
      rawPixel
    );


  const idat =
    pngChunk(
      'IDAT',
      compressed
    );


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


  if (
    png.length !== 125
  ) {

    throw new Error(
      `PNG生成错误：${png.length} 字节`
    );
  }


  return png;
}


/* =========================================================
   有赞 Token
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


  const responseText =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `有赞 Token HTTP ${response.status}`
    );
  }


  let data;


  try {

    data =
      JSON.parse(
        responseText
      );

  } catch {

    throw new Error(
      '有赞 Token 返回不是 JSON'
    );
  }


  if (
    !data ||
    Number(data.code) !== 0
  ) {

    throw new Error(
      '有赞 Token 获取失败'
    );
  }


  const token =
    data.data;


  if (
    !token
  ) {

    throw new Error(
      '有赞没有返回 token'
    );
  }


  return String(
    token
  );
}


/* =========================================================
   七牛上传 TS
   ========================================================= */

async function uploadTsToQiniu(
  tsPath,
  originalName
) {

  const token =
    await getYouzanToken();


  const pngBuffer =
    create125BytePNG();


  const fileName =
    path.basename(
      originalName
    );


  const boundary =
    '----NodeQiniu' +
    crypto
      .randomBytes(16)
      .toString('hex');


  const tokenPart =
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="token"\r\n` +
      `\r\n` +
      `${token}\r\n`,
      'utf8'
    );


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


  const tsStat =
    await fsp.stat(
      tsPath
    );


  const combinedLength =
    pngBuffer.length +
    tsStat.size;


  const totalLength =
    tokenPart.length +
    fileHeader.length +
    combinedLength +
    footer.length;


  const tsStream =
    fs.createReadStream(
      tsPath
    );


  const stream =
    new ReadableStream(
      {
        start(controller) {

          controller.enqueue(
            tokenPart
          );


          controller.enqueue(
            fileHeader
          );


          controller.enqueue(
            pngBuffer
          );


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
                footer
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


  const response =
    await fetch(
      QINIU_UPLOAD_URL,
      {
        method:
          'POST',

        headers:
          {
            'Content-Type':
              `multipart/form-data; boundary=${boundary}`,

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
      `七牛 HTTP ${response.status}`
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
      '七牛返回不是 JSON'
    );
  }


  const url =
    result?.data?.attachment_url ||
    result?.data?.attachment_full_url ||
    result?.attachment_url ||
    '';


  if (
    !url
  ) {

    throw new Error(
      '七牛没有返回图片 URL'
    );
  }


  return {

    url,

    pngBytes:
      pngBuffer.length,

    tsBytes:
      tsStat.size,

    combinedBytes:
      combinedLength
  };
}


/* =========================================================
   最终 HLS M3U8
   ========================================================= */

async function appendSegmentToHls(
  uploadId,
  duration,
  url
) {

  const playlist =
    path.join(
      hlsDir(
        uploadId
      ),
      'playlist.m3u8'
    );


  const line =
    `#EXTINF:${Number(duration).toFixed(6)},\n` +
    `${url}\n`;


  await fsp.appendFile(
    playlist,
    line,
    'utf8'
  );
}


/* =========================================================
   HLS ENDLIST
   ========================================================= */

async function finishHls(
  uploadId
) {

  const playlist =
    path.join(
      hlsDir(
        uploadId
      ),
      'playlist.m3u8'
    );


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
        '#EXT-X-ENDLIST\n',
        'utf8'
      );
    }

  } catch {}
}


/* =========================================================
   TS duration
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
   上传 TS
   ========================================================= */

async function uploadSegmentsToQiniu(
  uploadId,
  outDir
) {

  /*
   * 注意：
   *
   * playlist 不再放 output
   *
   * 而是：
   *
   * data/hls/{id}/playlist.m3u8
   */

  await createHlsPlaylist(
    uploadId
  );


  const playlist =
    path.join(
      hlsDir(
        uploadId
      ),
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

    let files;


    try {

      files =
        await fsp.readdir(
          outDir
        );

    } catch {

      break;
    }


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
       * 等 TS 文件稳定
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


      let uploadResult;


      try {

        uploadResult =
          await uploadTsToQiniu(
            tsPath,
            fileName
          );

      } catch (e) {

        console.error(
          `[七牛上传失败] ${fileName}`,
          e.message
        );


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
       * 核心：
       *
       * 七牛上传成功后，
       * 立即把 URL 写入最终 HLS。
       */
      await appendSegmentToHls(
        uploadId,
        duration,
        uploadResult.url
      );


      uploaded.add(
        fileName
      );


      /*
       * TS 已经上传到七牛，
       * 工作区立即删除。
       */
      await fsp.unlink(
        tsPath
      ).catch(
        () => {}
      );


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

          m3u8:
            hlsUrl(uploadId)
        }
      ).catch(
        () => {}
      );


      console.log(
        `[HLS] ${uploadId} → ${fileName}`
      );
    }


    /*
     * 检查 FFmpeg 是否完成
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
   * FFmpeg 完成后最后扫描
   */
  const finalFiles =
    await fsp.readdir(
      outDir
    ).catch(
      () => []
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


    let uploadResult;


    try {

      uploadResult =
        await uploadTsToQiniu(
          tsPath,
          fileName
        );

    } catch (e) {

      console.error(
        `[最终TS上传失败] ${fileName}`,
        e.message
      );

      continue;
    }


    await appendSegmentToHls(
      uploadId,
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
   * 所有 TS 上传完成
   *
   * 最终 HLS 封口
   */
  await finishHls(
    uploadId
  );


  /*
   * 注意：
   *
   * status.json 是工作状态文件，
   * 完成后删除。
   */
  await fsp.unlink(
    stateFile
  ).catch(
    () => {}
  );


  console.log(
    `[HLS完成] ${hlsUrl(uploadId)}`
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
    outputDir(
      uploadId
    );


  await fsp.mkdir(
    outDir,
    {
      recursive: true
    }
  );


  /*
   * 最终 HLS 播放目录
   */
  await createHlsPlaylist(
    uploadId
  );


  /*
   * 工作区中的 FFmpeg M3U8
   *
   * 仅供 FFmpeg 使用。
   */
  const ffmpegPlaylist =
    path.join(
      outDir,
      'ffmpeg.m3u8'
    );


  /*
   * 如果旧文件存在，先删除
   */
  await fsp.unlink(
    ffmpegPlaylist
  ).catch(
    () => {}
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
        hlsUrl(uploadId)
    }
  );


  const args = [

    '-hide_banner',

    '-loglevel',
    'error',

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

    ffmpegPlaylist
  ];


  console.log(
    `[FFmpeg开始] ${uploadId}`
  );


  const p =
    spawnFFmpeg(
      'ffmpeg',
      args
    );


  p.on(
    'close',
    async code => {

      console.log(
        `[FFmpeg结束] ${uploadId} code=${code}`
      );


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
   * 关键：
   *
   * FFmpeg 和七牛上传并行。
   *
   * FFmpeg：
   *
   * output/{id}/seg_xxx.ts
   *
   * Node：
   *
   * 发现 TS
   * ↓
   * 上传七牛
   * ↓
   * 立即写入 hls/{id}/playlist.m3u8
   *
   * 播放器无需等待 FFmpeg 完成。
   */
  await uploadSegmentsToQiniu(
    uploadId,
    outDir
  );


  /*
   * 等 FFmpeg 完成
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
      'FFmpeg处理失败'
    );
  }


  /*
   * 删除工作区 FFmpeg M3U8
   */
  await fsp.unlink(
    ffmpegPlaylist
  ).catch(
    () => {}
  );


  /*
   * 删除 ffmpeg_state.json
   */
  await fsp.unlink(
    path.join(
      outDir,
      'ffmpeg_state.json'
    )
  ).catch(
    () => {}
  );


  /*
   * 删除原始 merged.mp4
   */
  await fsp.unlink(
    input
  ).catch(
    () => {}
  );


  /*
   * 删除 tmp 中的 .part
   * 和 merged.mp4
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


  /*
   * 删除 meta.json
   */
  await fsp.unlink(
    path.join(
      dir,
      'meta.json'
    )
  ).catch(
    () => {}
  );


  /*
   * 删除整个 tmp/{id}
   */
  await fsp.rm(
    dir,
    {
      recursive:
        true,

      force:
        true
    }
  ).catch(
    () => {}
  );


  /*
   * status.json 也删除
   */
  await fsp.unlink(
    path.join(
      outDir,
      'status.json'
    )
  ).catch(
    () => {}
  );


  /*
   * 删除工作区里可能残留的 TS
   */
  try {

    const files =
      await fsp.readdir(
        outDir
      );


    for (
      const file of files
    ) {

      if (
        /^seg_\d+\.ts$/i.test(
          file
        )
      ) {

        await fsp.unlink(
          path.join(
            outDir,
            file
          )
        ).catch(
          () => {}
        );
      }
    }

  } catch {}


  console.log(
    `[任务完成] ${uploadId}`
  );

  console.log(
    `[最终播放] ${hlsUrl(uploadId)}`
  );
}


/* =========================================================
   上传任务
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
    outputDir(
      uploadId
    );


  await fsp.mkdir(
    outDir,
    {
      recursive:
        true
    }
  );


  await createHlsPlaylist(
    uploadId
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

    console.error(
      `[任务失败] ${uploadId}`,
      e.message
    );


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
          hlsUrl(uploadId)
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
    got
  };
}


/* =========================================================
   URL 后台任务
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
    outputDir(
      uploadId
    );


  await fsp.mkdir(
    dir,
    {
      recursive:
        true
    }
  );


  await fsp.mkdir(
    outDir,
    {
      recursive:
        true
    }
  );


  await createHlsPlaylist(
    uploadId
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
          hlsUrl(uploadId)
      }
    );


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


    await transcodeToHls(
      uploadId,
      input,
      {
        filename:
          safeFile
      }
    );

  } catch (e) {

    console.error(
      `[URL任务失败] ${uploadId}`,
      e.message
    );


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
          hlsUrl(uploadId)
      }
    ).catch(
      () => {}
    );
  }
}


/* =========================================================
   Body
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
     首页
     ======================================================= */

  if (
    req.method === 'GET' &&
    (
      u.pathname === '/' ||
      u.pathname === '/index.html'
    )
  ) {

    return servePublicFile(
      'index.html',
      res
    );
  }


  /* =======================================================
     public
     ======================================================= */

  if (
    req.method === 'GET'
  ) {

    if (
      !u.pathname.startsWith('/api/') &&
      !u.pathname.startsWith('/hls/')
    ) {

      const relative =
        decodeURIComponent(
          u.pathname.replace(
            /^\/+/,
            ''
          )
        );


      if (
        relative &&
        relative !== '/'
      ) {

        const publicFile =
          await servePublicFile(
            relative,
            res
          );


        if (
          publicFile === true
        ) {

          return;
        }
      }
    }
  }


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

        player:
          true,

        publicBase:
          PUBLIC_BASE,

        frontend:
          INDEX_FILE,

        hlsDir:
          HLS,

        outputDir:
          OUT
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
            CHUNK_SIZE,

          m3u8:
            hlsUrl(uploadId)
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


      const m3u8 =
        hlsUrl(
          uploadId
        );


      if (
        done
      ) {

        const outDir =
          outputDir(
            uploadId
          );


        await fsp.mkdir(
          outDir,
          {
            recursive:
              true
          }
        );


        await createHlsPlaylist(
          uploadId
        );


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
            'ready',
            'queued'
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
            e =>
              console.error(
                '[后台任务错误]',
                e.message
              )
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
            list.length,

          m3u8
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


    /*
     * 任务完成后 tmp/{id}
     * 会被删除。
     *
     * 所以这里允许已经没有 meta。
     */
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
            '任务不存在或已完成',

          m3u8:
            hlsUrl(uploadId)
        }
      );
    }


    const list =
      await uploadedChunks(
        uploadId,
        meta.totalChunks
      );


    const outDir =
      outputDir(
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
          hlsUrl(uploadId)
      }
    );
  }


  /* =======================================================
     URL
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
        outputDir(
          uploadId
        );


      const dir =
        uploadDir(
          uploadId
        );


      await fsp.mkdir(
        dir,
        {
          recursive:
            true
        }
      );


      await fsp.mkdir(
        outDir,
        {
          recursive:
            true
        }
      );


      /*
       * 创建最终 HLS
       */
      await createHlsPlaylist(
        uploadId
      );


      const m3u8 =
        hlsUrl(
          uploadId
        );


      /*
       * URL 创建后立即写入 links.json
       */
      await saveLink(
        m3u8,
        m.url
      );


      /*
       * 立即返回
       *
       * 后台下载 + 转码
       */
      processRemote(
        uploadId,
        m.url,
        m.filename ||
          'remote.mp4'
      ).catch(
        e =>
          console.error(
            '[URL后台错误]',
            e.message
          )
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


    /*
     * 现在 /hls 对应：
     *
     * data/hls
     *
     * 不再对应 data/output
     */
    const base =
      path.resolve(
        HLS
      );


    const file =
      path.resolve(
        HLS,
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

          /*
           * M3U8 必须实时读取
           */
          'Cache-Control':
            ext === '.m3u8'
              ? 'no-cache, no-store, must-revalidate'
              : 'public, max-age=86400',

          'Access-Control-Allow-Origin':
            '*',

          'Access-Control-Allow-Headers':
            '*',

          'Accept-Ranges':
            'bytes'
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

      const server =
        http.createServer(
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
                  '[HTTP错误]',
                  e
                );


                if (
                  res.headersSent
                ) {

                  try {
                    res.end();
                  } catch {}

                  return;
                }


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
        );


      server.listen(
        PORT,
        HOST,
        () => {

          console.log(
            `[服务器] http://${HOST}:${PORT}`
          );

          console.log(
            `[公网地址] ${PUBLIC_BASE}`
          );

          console.log(
            `[前端] ${INDEX_FILE}`
          );

          console.log(
            `[工作区] ${OUT}`
          );

          console.log(
            `[最终HLS] ${HLS}`
          );

          console.log(
            `[链接记录] ${LINKS_FILE}`
          );
        }
      );


      /*
       * 优雅退出
       */
      const shutdown =
        signal => {

          console.log(
            `[服务器] 收到 ${signal}，正在停止...`
          );


          server.close(
            () => {

              process.exit(
                0
              );
            }
          );


          setTimeout(
            () => {

              process.exit(
                1
              );

            },
            5000
          ).unref();
        };


      process.on(
        'SIGTERM',
        () =>
          shutdown('SIGTERM')
      );


      process.on(
        'SIGINT',
        () =>
          shutdown('SIGINT')
      );
    }
  )
  .catch(
    e => {

      console.error(
        '[启动失败]',
        e
      );

      process.exit(
        1
      );
    }
  );