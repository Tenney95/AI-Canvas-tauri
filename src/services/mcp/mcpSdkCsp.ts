/**
 * 必须先于 SDK 运行时入口求值：其协议 schema 在模块加载时创建。
 * 复用 SDK 必需且已锁定的 Zod，只关闭代码生成，保留完整解释式校验。
 */
import { config } from 'zod/v4/core';

config({ jitless: true });
