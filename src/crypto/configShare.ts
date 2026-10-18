import { encryptData, decryptData, isEncrypted } from "./e2ee";
import { PluginSettings } from "../types";

export interface SharedSyncConfig {
  appKey: string;
  secretKey: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  remoteBasePath: string;
  enableE2EE: boolean;
  e2eePassword?: string;
  conflictStrategy: string;
  ignoredPatterns: string[];
}

const CONFIG_HEADER_PREFIX = "BDSYNC:v1:";

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = Array.from(bytes.subarray(i, Math.min(i + chunkSize, len)));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.trim();
  try {
    const binary = atob(clean);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new Error("配对码格式无效（Base64 解析失败），请检查是否完整复制！");
  }
}

/**
 * Encrypt and export settings as a single portable pairing string.
 */
export async function exportEncryptedConfig(
  settings: PluginSettings,
  pin: string
): Promise<string> {
  if (!pin || pin.trim().length === 0) {
    throw new Error("配对保护密码不能为空，请设置一个临时配对密码！");
  }

  const exportPayload: SharedSyncConfig = {
    appKey: settings.appKey,
    secretKey: settings.secretKey,
    accessToken: settings.accessToken,
    refreshToken: settings.refreshToken,
    tokenExpiresAt: settings.tokenExpiresAt,
    remoteBasePath: settings.remoteBasePath,
    enableE2EE: settings.enableE2EE,
    e2eePassword: settings.e2eePassword,
    conflictStrategy: settings.conflictStrategy,
    ignoredPatterns: settings.ignoredPatterns,
  };

  const jsonStr = JSON.stringify(exportPayload);
  const enc = new TextEncoder();
  const rawData = enc.encode(jsonStr).buffer;

  const encryptedBuf = await encryptData(rawData, pin.trim());
  const b64 = uint8ArrayToBase64(new Uint8Array(encryptedBuf));
  return `${CONFIG_HEADER_PREFIX}${b64}`;
}

/**
 * Decrypt a pairing string and parse the sync configuration.
 */
export async function importEncryptedConfig(
  pairingCode: string,
  pin: string
): Promise<SharedSyncConfig> {
  const trimmed = pairingCode.trim();
  if (!trimmed.startsWith(CONFIG_HEADER_PREFIX)) {
    throw new Error("无效的配对码格式！配对码必须以 BDSYNC:v1: 开头。");
  }

  if (!pin || pin.trim().length === 0) {
    throw new Error("请输入配对保护密码！");
  }

  const base64Part = trimmed.slice(CONFIG_HEADER_PREFIX.length);
  const encryptedBytes = base64ToUint8Array(base64Part);

  // Mandatory check: Must have valid E2EE magic header to prevent password bypass
  if (!isEncrypted(encryptedBytes.buffer)) {
    throw new Error("配对码格式无效：缺少必要的加密签名头，已拒绝导入未受密码保护的明文配对码！");
  }

  const decryptedBuf = await decryptData(encryptedBytes.buffer, pin.trim());
  const dec = new TextDecoder();
  const jsonStr = dec.decode(decryptedBuf);

  try {
    const config = JSON.parse(jsonStr) as SharedSyncConfig;
    return config;
  } catch {
    throw new Error("配置解析失败，解密内容非有效 JSON。");
  }
}
