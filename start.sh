#!/bin/sh

APP_DIR="/www/wwwroot/301"

SERVER="$APP_DIR/server.js"
CLEANUP="$APP_DIR/cleanup.js"

SERVER_LOG="$APP_DIR/server.log"
CLEANUP_LOG="$APP_DIR/cleanup.log"

PUBLIC_BASE="http://51.15.184.22:4941"

SERVER_PID=""
CLEANUP_PID=""


# =========================================================
# 查找进程
# =========================================================

get_server_pid() {
    ps | grep "[n]ode $SERVER" | awk '{print $1}' | head -n 1
}

get_cleanup_pid() {
    ps | grep "[n]ode $CLEANUP" | awk '{print $1}' | head -n 1
}


# =========================================================
# 状态
# =========================================================

status() {

    SERVER_PID=$(get_server_pid)
    CLEANUP_PID=$(get_cleanup_pid)

    echo ""
    echo "========================================"
    echo "  301 Node.js 服务状态"
    echo "========================================"

    if [ -n "$SERVER_PID" ]; then
        echo "server.js  : 运行中"
        echo "PID        : $SERVER_PID"
    else
        echo "server.js  : 未运行"
    fi

    echo ""

    if [ -n "$CLEANUP_PID" ]; then
        echo "cleanup.js : 运行中"
        echo "PID        : $CLEANUP_PID"
    else
        echo "cleanup.js : 未运行"
    fi

    echo "========================================"
    echo ""
}


# =========================================================
# 启动 server.js
# =========================================================

start_server() {

    SERVER_PID=$(get_server_pid)

    if [ -n "$SERVER_PID" ]; then
        echo "server.js 已经在运行，PID=$SERVER_PID"
        return
    fi

    echo "正在启动 server.js..."

    cd "$APP_DIR" || exit 1

    PUBLIC_BASE="$PUBLIC_BASE" \
    nohup node "$SERVER" \
    > "$SERVER_LOG" 2>&1 &

    sleep 1

    SERVER_PID=$(get_server_pid)

    if [ -n "$SERVER_PID" ]; then
        echo "server.js 启动成功"
        echo "PID=$SERVER_PID"
    else
        echo "server.js 启动失败"
        echo "请查看：$SERVER_LOG"
    fi
}


# =========================================================
# 启动 cleanup.js
# =========================================================

start_cleanup() {

    CLEANUP_PID=$(get_cleanup_pid)

    if [ -n "$CLEANUP_PID" ]; then
        echo "cleanup.js 已经在运行，PID=$CLEANUP_PID"
        return
    fi

    echo "正在启动 cleanup.js..."

    cd "$APP_DIR" || exit 1

    nohup node "$CLEANUP" \
    > "$CLEANUP_LOG" 2>&1 &

    sleep 1

    CLEANUP_PID=$(get_cleanup_pid)

    if [ -n "$CLEANUP_PID" ]; then
        echo "cleanup.js 启动成功"
        echo "PID=$CLEANUP_PID"
    else
        echo "cleanup.js 启动失败"
        echo "请查看：$CLEANUP_LOG"
    fi
}


# =========================================================
# 启动全部
# =========================================================

start_all() {

    echo ""
    echo "正在启动 301 服务..."
    echo ""

    start_server

    echo ""

    start_cleanup

    echo ""

    status
}


# =========================================================
# 停止 server.js
# =========================================================

stop_server() {

    SERVER_PID=$(get_server_pid)

    if [ -z "$SERVER_PID" ]; then
        echo "server.js 当前没有运行"
        return
    fi

    echo "正在停止 server.js，PID=$SERVER_PID"

    kill "$SERVER_PID" 2>/dev/null

    sleep 1

    SERVER_PID=$(get_server_pid)

    if [ -n "$SERVER_PID" ]; then
        echo "正常停止失败，强制停止..."

        kill -9 "$SERVER_PID" 2>/dev/null

        sleep 1
    fi

    echo "server.js 已停止"
}


# =========================================================
# 停止 cleanup.js
# =========================================================

stop_cleanup() {

    CLEANUP_PID=$(get_cleanup_pid)

    if [ -z "$CLEANUP_PID" ]; then
        echo "cleanup.js 当前没有运行"
        return
    fi

    echo "正在停止 cleanup.js，PID=$CLEANUP_PID"

    kill "$CLEANUP_PID" 2>/dev/null

    sleep 1

    CLEANUP_PID=$(get_cleanup_pid)

    if [ -n "$CLEANUP_PID" ]; then
        echo "正常停止失败，强制停止..."

        kill -9 "$CLEANUP_PID" 2>/dev/null

        sleep 1
    fi

    echo "cleanup.js 已停止"
}


# =========================================================
# 停止全部
# =========================================================

stop_all() {

    echo ""
    echo "正在停止 301 服务..."
    echo ""

    stop_server

    echo ""

    stop_cleanup

    echo ""

    status
}


# =========================================================
# 重启全部
# =========================================================

restart_all() {

    echo ""
    echo "正在重启 301 服务..."
    echo ""

    stop_server

    echo ""

    stop_cleanup

    sleep 1

    echo ""

    start_server

    echo ""

    start_cleanup

    echo ""

    status
}


# =========================================================
# 重启 server.js
# =========================================================

restart_server() {

    stop_server

    sleep 1

    start_server

    status
}


# =========================================================
# 重启 cleanup.js
# =========================================================

restart_cleanup() {

    stop_cleanup

    sleep 1

    start_cleanup

    status
}


# =========================================================
# 日志
# =========================================================

logs_server() {

    echo "========================================"
    echo " server.js 最近日志"
    echo "========================================"

    tail -n 100 "$SERVER_LOG"
}


logs_cleanup() {

    echo "========================================"
    echo " cleanup.js 最近日志"
    echo "========================================"

    tail -n 100 "$CLEANUP_LOG"
}


# =========================================================
# 实时日志
# =========================================================

follow_server() {

    tail -f "$SERVER_LOG"
}


follow_cleanup() {

    tail -f "$CLEANUP_LOG"
}


# =========================================================
# 帮助
# =========================================================

usage() {

    echo ""
    echo "301 服务管理"
    echo ""
    echo "用法："
    echo ""
    echo "  ./start.sh start          启动全部"
    echo "  ./start.sh stop           停止全部"
    echo "  ./start.sh restart        重启全部"
    echo "  ./start.sh status         查看状态"
    echo ""
    echo "  ./start.sh start-server   启动 server.js"
    echo "  ./start.sh stop-server    停止 server.js"
    echo "  ./start.sh restart-server 重启 server.js"
    echo ""
    echo "  ./start.sh start-cleanup  启动 cleanup.js"
    echo "  ./start.sh stop-cleanup   停止 cleanup.js"
    echo "  ./start.sh restart-cleanup 重启 cleanup.js"
    echo ""
    echo "  ./start.sh log-server     查看 server 日志"
    echo "  ./start.sh log-cleanup    查看 cleanup 日志"
    echo ""
    echo "  ./start.sh tail-server    实时查看 server 日志"
    echo "  ./start.sh tail-cleanup   实时查看 cleanup 日志"
    echo ""
}


# =========================================================
# 参数
# =========================================================

case "$1" in

    start)
        start_all
        ;;

    stop)
        stop_all
        ;;

    restart)
        restart_all
        ;;

    status)
        status
        ;;

    start-server)
        start_server
        ;;

    stop-server)
        stop_server
        ;;

    restart-server)
        restart_server
        ;;

    start-cleanup)
        start_cleanup
        ;;

    stop-cleanup)
        stop_cleanup
        ;;

    restart-cleanup)
        restart_cleanup
        ;;

    log-server)
        logs_server
        ;;

    log-cleanup)
        logs_cleanup
        ;;

    tail-server)
        follow_server
        ;;

    tail-cleanup)
        follow_cleanup
        ;;

    *)
        usage
        ;;

esac