const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/* =========================================================
   配置
   ========================================================= */

const ROOT =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');

const TMP =
  path.join(ROOT, 'tmp');

const OUTPUT =
  path.join(ROOT, 'output');

/*
 * 只清理：
 *
 * data/tmp/{id}
 * data/output/{id}
 *
 * 不碰：
 *
 * data/hls/{id}
 * data/links/links.json
 */

const CLEANUP_HOURS =
  Number(process.env.CLEANUP_HOURS || 24);

const MAX_AGE =
  CLEANUP_HOURS *
  60 *
  60 *
  1000;

/*
 * 默认每 1 小时检查一次
 *
 * 可以通过：
 *
 * CLEANUP_INTERVAL=60
 *
 * 修改为 60 分钟
 */

const INTERVAL =
  Number(process.env.CLEANUP_INTERVAL || 60) *
  60 *
  1000;


/* =========================================================
   删除目录
   ========================================================= */

async function removeDirectory(dir) {

  try {

    await fsp.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    );

    return true;

  } catch (e) {

    console.error(
      `[清理失败] ${dir}`,
      e.message
    );

    return false;
  }
}


/* =========================================================
   清理指定目录
   ========================================================= */

async function cleanDirectory(
  baseDir,
  now
) {

  let entries;

  try {

    entries =
      await fsp.readdir(
        baseDir,
        {
          withFileTypes: true
        }
      );

  } catch {

    /*
     * 目录不存在不报错
     */

    return 0;
  }


  let count = 0;


  for (
    const entry of entries
  ) {

    /*
     * 这里只处理目录
     */

    if (
      !entry.isDirectory()
    ) {

      continue;
    }


    const fullPath =
      path.join(
        baseDir,
        entry.name
      );


    try {

      const stat =
        await fsp.stat(
          fullPath
        );


      const age =
        now -
        stat.mtimeMs;


      /*
       * 超过24小时
       */

      if (
        age >
        MAX_AGE
      ) {

        const success =
          await removeDirectory(
            fullPath
          );


        if (
          success
        ) {

          count++;

          console.log(
            `[清理] 删除 ${fullPath}`
          );
        }
      }

    } catch (e) {

      console.error(
        `[检查失败] ${fullPath}`,
        e.message
      );
    }
  }


  return count;
}


/* =========================================================
   执行一次清理
   ========================================================= */

async function cleanup() {

  const now =
    Date.now();


  console.log(
    `\n[清理] 开始检查`
  );

  console.log(
    `[清理] 保留时间：${CLEANUP_HOURS} 小时`
  );


  /*
   * 清理 TMP
   */

  const tmpCount =
    await cleanDirectory(
      TMP,
      now
    );


  /*
   * 清理 OUTPUT
   */

  const outputCount =
    await cleanDirectory(
      OUTPUT,
      now
    );


  /*
   * 明确不处理：
   *
   * data/hls
   * data/links/links.json
   */


  console.log(
    `[清理] 完成 TMP=${tmpCount} OUTPUT=${outputCount}`
  );
}


/* =========================================================
   启动
   ========================================================= */

cleanup()
  .catch(
    e => {

      console.error(
        '[清理错误]',
        e
      );

    }
  );


setInterval(
  () => {

    cleanup()
      .catch(
        e => {

          console.error(
            '[清理错误]',
            e
          );

        }
      );

  },
  INTERVAL
);


console.log(
  `[清理脚本] 已启动`
);


console.log(
  `[清理脚本] 检查间隔：${INTERVAL / 60000} 分钟`
);


console.log(
  `[清理脚本] 超过 ${CLEANUP_HOURS} 小时的 tmp/output 目录将被删除`
);