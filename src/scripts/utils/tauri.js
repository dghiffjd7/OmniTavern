
/**
 * Tauri 兼容工具
 * 提供在浏览器（开发模式）与 Tauri 环境下通用的 invoke 方法
 */

import { recordInvokeResult } from './boot-diagnostics.js';

// IPC 挂死防护：Tauri IPC 通道故障时 invoke 会永久 pending（无响应也无拒绝，catch 不到）。
// 按命令给 IPC 级超时：http_request 用自身 timeoutMs+缓冲，其余命令 20s；超时抛错让调用方 fallback 生效。
// 资料包导出/导入耗时随数据量线性增长（实测 3GB 资料在 debug 构建下超过 10 分钟），返回 0 表示不设超时。
const UNLIMITED_INVOKE_COMMANDS = new Set([
    'export_data_bundle',
    'import_data_bundle',
    'import_data_bundle_bytes',
    'prepare_microphone_permission_retry',
    // 下载安装包耗时取决于网速；成功时应用直接重启，不会返回
    'app_update_install',
]);
export const resolveInvokeTimeoutMs = (cmd, args) => {
    if (UNLIMITED_INVOKE_COMMANDS.has(cmd)) return 0;
    if (cmd === 'http_request' || cmd === 'public_http_request') {
        const requestTimeout = Number(args?.timeoutMs);
        return (Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : 240000) + 30000;
    }
    return 20000;
};

export const safeInvoke = async (cmd, args) => {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    // 尝试多种路径获取 invoke 函数
    const invoker = g?.__TAURI__?.core?.invoke || 
                    g?.__TAURI__?.invoke || 
                    g?.__TAURI_INVOKE__ || 
                    g?.__TAURI_INTERNALS__?.invoke;
    
    if (typeof invoker !== 'function') {
        // 如果找不到 invoke，抛出错误，调用者应捕获并回退到 localStorage 等
        recordInvokeResult({ cmd, status: 'error', message: 'Tauri invoke not available' });
        throw new Error('Tauri invoke not available');
    }
    
    const timeoutMs = resolveInvokeTimeoutMs(cmd, args);
    let timer = null;
    try {
        const result = await (timeoutMs <= 0 ? invoker(cmd, args) : Promise.race([
            invoker(cmd, args),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`tauri_invoke_timeout:${cmd}:${timeoutMs}ms`)), timeoutMs);
            }),
        ]));
        recordInvokeResult({ cmd, status: 'ok' });
        return result;
    } catch (error) {
        const message = String(error?.message || error || '');
        recordInvokeResult({
            cmd,
            status: message.startsWith('tauri_invoke_timeout:') ? 'timeout' : 'error',
            message,
        });
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
};
